/**
 * health.ts — Deterministic fleet health collection.
 *
 * ZERO MODEL INVOCATION, BY CONSTRUCTION
 * --------------------------------------
 * This module reads files and asks the daemon for the status snapshot it
 * already holds in memory. It never injects into a PTY, never spawns an agent
 * runtime, never wakes a sleeping agent, and never calls a model provider. The
 * only socket traffic is the same read-only `status` IPC that `cortextos
 * status` already performs.
 *
 * LIVENESS IS NOT READINESS
 * -------------------------
 * A PID is not a health signal. cortextOS has a documented failure mode where a
 * restarted daemon leaves agent processes alive but unattached: the process
 * exists, `status` says `running`, and the agent is unreachable. This collector
 * therefore never reports healthy on process existence alone — it requires
 * corroborating evidence (a fresh heartbeat, or recent stdout activity), and
 * reports `running-unreachable` when the process is up but that evidence is
 * absent.
 *
 * UNKNOWN IS A REAL ANSWER
 * ------------------------
 * Missing or corrupt evidence produces `unknown`, never `ok` and never `fail`.
 * A check that cannot distinguish "healthy" from "no data" is not a check.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveEnv } from '../utils/env.js';
import { cronsPathFor, cronExecutionLogPathFor } from './crons-schema.js';
import type { AgentStatus } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthState = 'ok' | 'warn' | 'fail' | 'unknown';

export type Reachability =
  | 'reachable'
  | 'running-unreachable'
  | 'not-running'
  | 'unknown';

export interface CountAndAge {
  count: number | null;
  oldestAgeSec: number | null;
}

export interface AgentHealth {
  agent: string;
  workspace: string | null;
  enabled: boolean | null;

  /** Status as reported by the daemon's in-memory registry. */
  daemonReported: AgentStatus['status'] | null;
  pid: number | null;
  /** Whether the daemon currently holds a registry entry for this agent. */
  attached: boolean | null;
  reachability: Reachability;

  heartbeatAgeSec: number | null;
  heartbeatState: HealthState;

  inbox: CountAndAge;
  inflight: CountAndAge;

  /** Enabled cron count from crons.json; null when unreadable. */
  cronsEnabled: number | null;
  /** Age of the newest cron-execution.log entry. */
  lastCronFireAgeSec: number | null;
  cronSchedulerState: HealthState;

  /** Crashes recorded in restarts.log within the last 24h. */
  recentCrashes24h: number | null;

  /**
   * Whether a Telegram poller is configured for this agent. Configuration is
   * locally observable; whether the poller is actually polling is not, so this
   * never claims "running".
   */
  telegramPoller: 'configured' | 'disabled' | 'unknown';

  /**
   * Runtime error evidence from local logs. Deliberately NOT classified by
   * cause — this is not a provider state machine and nothing gates on it.
   */
  runtimeErrorState: 'none-observed' | 'errors-observed' | 'unknown';

  /**
   * Depth of a provider-blocked work queue. No such queue exists in this
   * build, so this is always null. Present so the field does not appear later
   * and silently change meaning.
   */
  queueDepth: number | null;

  state: HealthState;
  notes: string[];
}

export interface DaemonHealth {
  running: boolean | null;
  pid: number | null;
  state: HealthState;
  notes: string[];
}

export interface HealthReport {
  generatedAt: string;
  instanceId: string;
  ctxRoot: string;
  daemon: DaemonHealth;
  agents: AgentHealth[];
  fleet: {
    state: HealthState;
    total: number;
    ok: number;
    warn: number;
    fail: number;
    unknown: number;
  };
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Heartbeat ages. Sized against the two existing liveness mechanisms: the
 * in-daemon watchdog (50 min) and the zero-token scheduled tasks (2 h). Warn at
 * one missed scheduled-task window, fail at two.
 */
export const HEARTBEAT_WARN_SEC = 2 * 60 * 60;
export const HEARTBEAT_FAIL_SEC = 4 * 60 * 60;

/** Inbox backlog ages before the queue is considered stuck. */
export const INBOX_WARN_SEC = 15 * 60;
export const INBOX_FAIL_SEC = 60 * 60;

/** Inflight messages older than this were never acked. */
export const INFLIGHT_WARN_SEC = 10 * 60;

/** stdout.log quiet for longer than this is not corroborating activity. */
export const ACTIVITY_FRESH_SEC = 2 * 60 * 60;

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CollectHealthOptions {
  instanceId?: string;
  ctxRoot?: string;
  /** Framework checkout root (holds `orgs/<org>/agents/<agent>/config.json`). */
  frameworkRoot?: string;
  now?: Date;
  /**
   * Injectable daemon status source. Defaults to a read-only `status` IPC call.
   * Returning null means "could not determine", which yields `unknown` — not a
   * failure verdict.
   */
  daemonStatus?: () => Promise<{ running: boolean; statuses: AgentStatus[] } | null>;
}

export async function collectHealth(
  options: CollectHealthOptions = {},
): Promise<HealthReport> {
  const now = options.now ?? new Date();
  const instanceId = options.instanceId
    || process.env.CTX_INSTANCE_ID
    || 'default';
  const ctxRoot = options.ctxRoot ?? resolveCtxRoot(instanceId);
  const frameworkRoot = options.frameworkRoot ?? resolveFrameworkRoot(instanceId);

  const daemonSource = options.daemonStatus ?? (() => defaultDaemonStatus(instanceId));

  let daemonInfo: { running: boolean; statuses: AgentStatus[] } | null = null;
  try {
    daemonInfo = await daemonSource();
  } catch {
    daemonInfo = null;
  }

  const daemon = buildDaemonHealth(ctxRoot, daemonInfo);
  const roster = readRoster(ctxRoot);
  const statusByAgent = new Map<string, AgentStatus>();
  for (const s of daemonInfo?.statuses ?? []) statusByAgent.set(s.name, s);

  // Include agents the daemon knows about even if absent from the roster file,
  // so a mis-synced roster cannot hide a running agent.
  const names = new Set<string>([...roster.keys(), ...statusByAgent.keys()]);

  const agents: AgentHealth[] = [];
  for (const name of [...names].sort()) {
    agents.push(
      collectAgent({
        agent: name,
        ctxRoot,
        frameworkRoot,
        now,
        roster: roster.get(name) ?? null,
        daemonRunning: daemonInfo?.running ?? null,
        status: statusByAgent.get(name) ?? null,
        daemonKnowsAgent: daemonInfo ? statusByAgent.has(name) : null,
      }),
    );
  }

  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const a of agents) counts[a.state]++;

  const fleetState: HealthState = counts.fail > 0
    ? 'fail'
    : counts.warn > 0
      ? 'warn'
      : counts.ok > 0
        ? 'ok'
        : 'unknown';

  return {
    generatedAt: now.toISOString(),
    instanceId,
    ctxRoot,
    daemon,
    agents,
    fleet: { state: fleetState, total: agents.length, ...counts },
  };
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function defaultDaemonStatus(
  instanceId: string,
): Promise<{ running: boolean; statuses: AgentStatus[] } | null> {
  try {
    // Imported lazily so that health collection has no import-time dependency
    // on the daemon module graph (keeps the CLI cheap and test isolation easy).
    const { IPCClient } = await import('../daemon/ipc-server.js');
    const ipc = new IPCClient(instanceId);
    const running = await ipc.isDaemonRunning();
    if (!running) return { running: false, statuses: [] };
    const response = await ipc.send({ type: 'status', source: 'cortextos health' });
    if (!response.success) return { running: true, statuses: [] };
    const statuses = Array.isArray(response.data) ? (response.data as AgentStatus[]) : [];
    return { running: true, statuses };
  } catch {
    return null;
  }
}

function buildDaemonHealth(
  ctxRoot: string,
  info: { running: boolean; statuses: AgentStatus[] } | null,
): DaemonHealth {
  const notes: string[] = [];
  let pid: number | null = null;
  try {
    const raw = readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) pid = parsed;
  } catch {
    /* absent or unreadable */
  }

  if (info === null) {
    notes.push('Daemon status could not be determined (IPC unavailable).');
    if (pid !== null) {
      notes.push(`daemon.pid exists (${pid}) but a PID is not a liveness signal.`);
    }
    return { running: null, pid, state: 'unknown', notes };
  }

  if (!info.running) {
    notes.push('Daemon is not accepting IPC connections.');
    return { running: false, pid, state: 'fail', notes };
  }

  return { running: true, pid, state: 'ok', notes };
}

// ---------------------------------------------------------------------------
// Per-agent
// ---------------------------------------------------------------------------

function collectAgent(input: {
  agent: string;
  ctxRoot: string;
  frameworkRoot: string;
  now: Date;
  roster: { enabled: boolean; org: string | null } | null;
  daemonRunning: boolean | null;
  status: AgentStatus | null;
  daemonKnowsAgent: boolean | null;
}): AgentHealth {
  const { agent, ctxRoot, frameworkRoot, now, roster, daemonRunning, status, daemonKnowsAgent } = input;
  const notes: string[] = [];
  const nowMs = now.getTime();

  const heartbeatAgeSec = readHeartbeatAgeSec(ctxRoot, agent, nowMs);
  const heartbeatState = gradeAge(heartbeatAgeSec, HEARTBEAT_WARN_SEC, HEARTBEAT_FAIL_SEC);
  const inbox = readDirAge(join(ctxRoot, 'inbox', agent), nowMs, '.json');
  const inflight = readDirAge(join(ctxRoot, 'inflight', agent), nowMs, '.json');
  const cronsEnabled = readEnabledCronCount(ctxRoot, agent);
  const lastCronFireAgeSec = readLastCronFireAgeSec(ctxRoot, agent, nowMs);
  const recentCrashes24h = readRecentCrashes(ctxRoot, agent, nowMs);
  const activityAgeSec = readStdoutAgeSec(ctxRoot, agent, nowMs);
  const telegramPoller = readTelegramPollerConfig(
    ctxRoot,
    frameworkRoot,
    roster?.org ?? null,
    agent,
  );
  const runtimeErrorState = readRuntimeErrorState(status, recentCrashes24h);

  // --- Reachability -------------------------------------------------------
  // A PID alone never yields "reachable". We require corroborating evidence
  // that the session is actually consuming input: a fresh heartbeat or fresh
  // stdout activity.
  let reachability: Reachability = 'unknown';
  if (daemonRunning === null) {
    notes.push('Daemon unreachable — reachability cannot be determined from files alone.');
  } else if (!daemonRunning) {
    reachability = 'not-running';
    notes.push('Daemon is down; agents cannot receive messages regardless of PID.');
  } else if (daemonKnowsAgent === false) {
    reachability = 'unknown';
    notes.push('Daemon holds no registry entry for this agent.');
  } else if (status && (status.status === 'running' || status.status === 'starting')) {
    const heartbeatFresh = heartbeatAgeSec !== null && heartbeatAgeSec <= HEARTBEAT_FAIL_SEC;
    const activityFresh = activityAgeSec !== null && activityAgeSec <= ACTIVITY_FRESH_SEC;
    if (heartbeatFresh || activityFresh) {
      reachability = 'reachable';
    } else if (heartbeatAgeSec === null && activityAgeSec === null) {
      reachability = 'unknown';
      notes.push('Process reported running but no heartbeat or stdout evidence exists to corroborate it.');
    } else {
      reachability = 'running-unreachable';
      notes.push(
        'Process reported running but neither heartbeat nor stdout has advanced — '
        + 'likely attached-but-unreachable (daemon restarted without re-attaching).',
      );
    }
  } else if (status) {
    reachability = 'not-running';
  }

  // --- Cron scheduler state ----------------------------------------------
  let cronSchedulerState: HealthState = 'unknown';
  if (cronsEnabled === null) {
    notes.push('crons.json unreadable — cron state unknown.');
  } else if (cronsEnabled === 0) {
    // No enabled crons is a legitimate configuration, not a fault.
    cronSchedulerState = 'ok';
  } else if (lastCronFireAgeSec === null) {
    cronSchedulerState = 'unknown';
    notes.push(`${cronsEnabled} cron(s) enabled but no execution-log evidence of any fire.`);
  } else {
    cronSchedulerState = 'ok';
  }

  // --- Overall grade ------------------------------------------------------
  const grades: HealthState[] = [heartbeatState, cronSchedulerState];

  const inboxState = gradeAge(inbox.oldestAgeSec, INBOX_WARN_SEC, INBOX_FAIL_SEC);
  if (inbox.count !== null && inbox.count > 0) grades.push(inboxState);

  if (inflight.count !== null && inflight.count > 0) {
    const inflightState = gradeAge(inflight.oldestAgeSec, INFLIGHT_WARN_SEC, Infinity);
    grades.push(inflightState);
    if (inflightState !== 'ok') {
      notes.push(`${inflight.count} message(s) stuck in inflight — delivered but never acked.`);
    }
  }

  if (reachability === 'running-unreachable') grades.push('fail');
  if (reachability === 'not-running' && roster?.enabled) {
    grades.push('warn');
    notes.push('Agent is enabled in the roster but not running.');
  }
  if (recentCrashes24h !== null && recentCrashes24h > 0) {
    grades.push(recentCrashes24h >= 3 ? 'fail' : 'warn');
    notes.push(`${recentCrashes24h} crash(es) recorded in the last 24h.`);
  }
  if (status && (status.status === 'halted' || status.status === 'crashed')) {
    grades.push('fail');
  }

  // A disabled, stopped agent with no traffic is not a fault.
  if (roster && roster.enabled === false && reachability === 'not-running') {
    return finish({
      agent, roster, status, heartbeatAgeSec, heartbeatState, inbox, inflight,
      cronsEnabled, lastCronFireAgeSec, cronSchedulerState, recentCrashes24h,
      telegramPoller, runtimeErrorState, reachability, daemonKnowsAgent,
      state: 'ok',
      notes: [...notes, 'Agent is disabled in the roster; not-running is expected.'],
    });
  }

  return finish({
    agent, roster, status, heartbeatAgeSec, heartbeatState, inbox, inflight,
    cronsEnabled, lastCronFireAgeSec, cronSchedulerState, recentCrashes24h,
    telegramPoller, runtimeErrorState, reachability, daemonKnowsAgent,
    state: worst(grades),
    notes,
  });
}

function finish(p: {
  agent: string;
  roster: { enabled: boolean; org: string | null } | null;
  status: AgentStatus | null;
  heartbeatAgeSec: number | null;
  heartbeatState: HealthState;
  inbox: CountAndAge;
  inflight: CountAndAge;
  cronsEnabled: number | null;
  lastCronFireAgeSec: number | null;
  cronSchedulerState: HealthState;
  recentCrashes24h: number | null;
  telegramPoller: AgentHealth['telegramPoller'];
  runtimeErrorState: AgentHealth['runtimeErrorState'];
  reachability: Reachability;
  daemonKnowsAgent: boolean | null;
  state: HealthState;
  notes: string[];
}): AgentHealth {
  return {
    agent: p.agent,
    workspace: p.roster?.org ?? null,
    enabled: p.roster ? p.roster.enabled : null,
    daemonReported: p.status?.status ?? null,
    pid: p.status?.pid ?? null,
    attached: p.daemonKnowsAgent,
    reachability: p.reachability,
    heartbeatAgeSec: p.heartbeatAgeSec,
    heartbeatState: p.heartbeatState,
    inbox: p.inbox,
    inflight: p.inflight,
    cronsEnabled: p.cronsEnabled,
    lastCronFireAgeSec: p.lastCronFireAgeSec,
    cronSchedulerState: p.cronSchedulerState,
    recentCrashes24h: p.recentCrashes24h,
    telegramPoller: p.telegramPoller,
    runtimeErrorState: p.runtimeErrorState,
    queueDepth: null,
    state: p.state,
    notes: p.notes,
  };
}

// ---------------------------------------------------------------------------
// Evidence readers — every one degrades to null, never throws
// ---------------------------------------------------------------------------

function resolveCtxRoot(instanceId: string): string {
  try {
    return resolveEnv({ instanceId }).ctxRoot;
  } catch {
    return join(homedir(), '.cortextos', instanceId);
  }
}

function resolveFrameworkRoot(instanceId: string): string {
  try {
    return resolveEnv({ instanceId }).frameworkRoot || '';
  } catch {
    return '';
  }
}

function readRoster(ctxRoot: string): Map<string, { enabled: boolean; org: string | null }> {
  const out = new Map<string, { enabled: boolean; org: string | null }>();
  try {
    const raw = readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, { enabled?: boolean; org?: string }>;
    for (const [name, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      out.set(name, {
        enabled: entry.enabled !== false,
        org: typeof entry.org === 'string' ? entry.org : null,
      });
    }
  } catch {
    /* absent or corrupt — callers see an empty roster, agents come from the daemon */
  }
  return out;
}

function readHeartbeatAgeSec(ctxRoot: string, agent: string, nowMs: number): number | null {
  try {
    const raw = readFileSync(join(ctxRoot, 'state', agent, 'heartbeat.json'), 'utf-8');
    const hb = JSON.parse(raw) as { last_heartbeat?: string; timestamp?: string };
    const ts = hb.last_heartbeat || hb.timestamp;
    if (!ts) return null;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return null;
    return Math.max(0, Math.floor((nowMs - ms) / 1000));
  } catch {
    return null;
  }
}

function readDirAge(dir: string, nowMs: number, suffix: string): CountAndAge {
  try {
    if (!existsSync(dir)) return { count: 0, oldestAgeSec: null };
    const files = readdirSync(dir).filter((f) => f.endsWith(suffix) && !f.startsWith('.'));
    if (files.length === 0) return { count: 0, oldestAgeSec: null };
    let oldest = Infinity;
    for (const f of files) {
      try {
        const m = statSync(join(dir, f)).mtimeMs;
        if (m < oldest) oldest = m;
      } catch { /* skip */ }
    }
    return {
      count: files.length,
      oldestAgeSec: Number.isFinite(oldest)
        ? Math.max(0, Math.floor((nowMs - oldest) / 1000))
        : null,
    };
  } catch {
    return { count: null, oldestAgeSec: null };
  }
}

function readEnabledCronCount(ctxRoot: string, agent: string): number | null {
  try {
    const path = join(ctxRoot, cronsPathFor(agent));
    if (!existsSync(path)) return 0;
    const raw = readFileSync(path, 'utf-8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { crons?: unknown[] })?.crons ?? []);
    if (!Array.isArray(list)) return null;
    return list.filter((c) => (c as { enabled?: boolean })?.enabled === true).length;
  } catch {
    return null;
  }
}

function readLastCronFireAgeSec(ctxRoot: string, agent: string, nowMs: number): number | null {
  try {
    const path = join(ctxRoot, cronExecutionLogPathFor(agent));
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as { ts?: string };
        if (!entry.ts) continue;
        const ms = Date.parse(entry.ts);
        if (Number.isNaN(ms)) continue;
        return Math.max(0, Math.floor((nowMs - ms) / 1000));
      } catch { /* skip malformed line */ }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Count crashes in restarts.log within the last 24h.
 * Format: `[2026-07-29T18:34:58Z] CRASH: exit_code=-1 crash_count=1 backoff_s=5`
 */
function readRecentCrashes(ctxRoot: string, agent: string, nowMs: number): number | null {
  try {
    const path = join(ctxRoot, 'logs', agent, 'restarts.log');
    if (!existsSync(path)) return 0;
    const raw = readFileSync(path, 'utf-8');
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    let count = 0;
    for (const line of raw.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]\s+CRASH/);
      if (!m) continue;
      const ms = Date.parse(m[1]);
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoff) count++;
    }
    return count;
  } catch {
    return null;
  }
}

function readStdoutAgeSec(ctxRoot: string, agent: string, nowMs: number): number | null {
  try {
    const path = join(ctxRoot, 'logs', agent, 'stdout.log');
    const m = statSync(path).mtimeMs;
    return Math.max(0, Math.floor((nowMs - m) / 1000));
  } catch {
    return null;
  }
}

/**
 * Agent config lives under the FRAMEWORK root (`orgs/<org>/agents/<agent>/`),
 * not the instance root. Both locations are probed because deployments differ
 * on whether orgs/ is checked out beside the instance state.
 */
function readTelegramPollerConfig(
  ctxRoot: string,
  frameworkRoot: string,
  org: string | null,
  agent: string,
): AgentHealth['telegramPoller'] {
  if (!org) return 'unknown';
  const candidates = [
    frameworkRoot ? join(frameworkRoot, 'orgs', org, 'agents', agent, 'config.json') : '',
    join(ctxRoot, 'orgs', org, 'agents', agent, 'config.json'),
  ].filter(Boolean);

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const cfg = JSON.parse(readFileSync(path, 'utf-8')) as { telegram_polling?: boolean };
      if (cfg.telegram_polling === false) return 'disabled';
      if (cfg.telegram_polling === true) return 'configured';
      // Field absent: the daemon default is polling-enabled, but "defaulted"
      // is not the same as "observed", so this stays unknown.
      return 'unknown';
    } catch {
      /* try the next candidate */
    }
  }
  return 'unknown';
}

/**
 * Runtime error evidence. Intentionally coarse: derived from the daemon's own
 * status and the crash log, NOT from scanning agent output for provider error
 * strings. Classifying provider errors is out of scope for this build and
 * nothing here gates any behaviour.
 */
function readRuntimeErrorState(
  status: AgentStatus | null,
  recentCrashes: number | null,
): AgentHealth['runtimeErrorState'] {
  if (status === null && recentCrashes === null) return 'unknown';
  if (status && (status.status === 'crashed' || status.status === 'halted')) {
    return 'errors-observed';
  }
  if (recentCrashes !== null && recentCrashes > 0) return 'errors-observed';
  if (recentCrashes === null) return 'unknown';
  return 'none-observed';
}

// ---------------------------------------------------------------------------
// Grading helpers
// ---------------------------------------------------------------------------

/** Missing evidence grades `unknown`, never `ok`. */
function gradeAge(ageSec: number | null, warnSec: number, failSec: number): HealthState {
  if (ageSec === null) return 'unknown';
  if (ageSec >= failSec) return 'fail';
  if (ageSec >= warnSec) return 'warn';
  return 'ok';
}

const SEVERITY: Record<HealthState, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

function worst(states: HealthState[]): HealthState {
  let acc: HealthState = 'ok';
  for (const s of states) if (SEVERITY[s] > SEVERITY[acc]) acc = s;
  return acc;
}
