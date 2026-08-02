import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ACTIVITY_FRESH_SEC,
  HEARTBEAT_FAIL_SEC,
  collectHealth,
  type HealthReport,
} from '../../../src/bus/health';
import { renderHuman, exitCodeFor, EXIT_OK, EXIT_WARN, EXIT_FAIL } from '../../../src/cli/health';
import type { AgentStatus } from '../../../src/types/index';

let ctxRoot: string;
const NOW = new Date('2026-08-01T12:00:00.000Z');

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'health-'));
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- fixture helpers -------------------------------------------------------

function roster(entries: Record<string, { enabled: boolean; org: string }>): void {
  writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify(entries));
}

function heartbeat(agent: string, ageSec: number): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    agent,
    last_heartbeat: new Date(NOW.getTime() - ageSec * 1000).toISOString(),
  }));
}

function stdout(agent: string, ageSec: number): void {
  const dir = join(ctxRoot, 'logs', agent);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'stdout.log');
  writeFileSync(p, 'output');
  const when = (NOW.getTime() - ageSec * 1000) / 1000;
  utimesSync(p, when, when);
}

function restarts(agent: string, isoTimes: string[]): void {
  const dir = join(ctxRoot, 'logs', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'restarts.log'),
    isoTimes.map((t) => `[${t}] CRASH: exit_code=-1 crash_count=1 backoff_s=5`).join('\n') + '\n',
  );
}

function inbox(agent: string, count: number, ageSec: number): void {
  const dir = join(ctxRoot, 'inbox', agent);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const p = join(dir, `1-${i}-from-x-abc.json`);
    writeFileSync(p, '{}');
    const when = (NOW.getTime() - ageSec * 1000) / 1000;
    utimesSync(p, when, when);
  }
}

function run(
  statuses: AgentStatus[] | null,
  running = true,
): Promise<HealthReport> {
  return collectHealth({
    ctxRoot,
    now: NOW,
    daemonStatus: async () => (statuses === null ? null : { running, statuses }),
  });
}

const RUNNING = (name: string, pid = 1234): AgentStatus => ({ name, status: 'running', pid });

// --- tests -----------------------------------------------------------------

describe('collectHealth — no model invocation', () => {
  it('makes no network calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 60);
    await run([RUNNING('goose')]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('contains no injection or spawn code path', () => {
    // Structural guarantee: the collector cannot wake an agent because it has
    // no reference to any mechanism that could.
    const src = readFileSync(join(process.cwd(), 'src/bus/health.ts'), 'utf-8');
    for (const forbidden of ['injectMessage', 'injectAgent', '.write(', 'spawn(', 'sendMessage']) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('does not create or modify agent state while collecting', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 60);
    const before = readFileSync(join(ctxRoot, 'state', 'goose', 'heartbeat.json'), 'utf-8');
    await run([RUNNING('goose')]);
    expect(readFileSync(join(ctxRoot, 'state', 'goose', 'heartbeat.json'), 'utf-8')).toBe(before);
  });
});

describe('collectHealth — liveness is not readiness', () => {
  it('does not report reachable from a PID alone', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    // Daemon says running, PID present, but no heartbeat and no stdout evidence.
    const report = await run([RUNNING('goose')]);
    const goose = report.agents[0];
    expect(goose.pid).toBe(1234);
    expect(goose.reachability).not.toBe('reachable');
    expect(goose.reachability).toBe('unknown');
    expect(goose.state).not.toBe('ok');
  });

  it('detects attached-but-unreachable when process is up but nothing advances', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', HEARTBEAT_FAIL_SEC + 600);
    stdout('goose', ACTIVITY_FRESH_SEC + 600);

    const report = await run([RUNNING('goose')]);
    const goose = report.agents[0];
    expect(goose.reachability).toBe('running-unreachable');
    expect(goose.state).toBe('fail');
    expect(goose.notes.join(' ')).toMatch(/attached-but-unreachable/);
  });

  it('reports reachable when a fresh heartbeat corroborates the process', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 120);
    const report = await run([RUNNING('goose')]);
    expect(report.agents[0].reachability).toBe('reachable');
    expect(report.agents[0].state).toBe('ok');
  });

  it('accepts fresh stdout activity as corroboration when the heartbeat is stale', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', HEARTBEAT_FAIL_SEC + 600);
    stdout('goose', 60);
    const report = await run([RUNNING('goose')]);
    expect(report.agents[0].reachability).toBe('reachable');
    // Still not "ok" — the stale heartbeat is a real warning.
    expect(report.agents[0].state).toBe('fail');
  });

  it('flags an enabled agent that is not running', async () => {
    roster({ forge: { enabled: true, org: 'atlasos' } });
    const report = await run([{ name: 'forge', status: 'stopped' }]);
    expect(report.agents[0].reachability).toBe('not-running');
    expect(report.agents[0].state).toBe('warn');
  });

  it('treats a disabled, stopped agent as expected rather than faulty', async () => {
    roster({ argus: { enabled: false, org: 'atlasos' } });
    const report = await run([{ name: 'argus', status: 'stopped' }]);
    expect(report.agents[0].state).toBe('ok');
    expect(report.agents[0].notes.join(' ')).toMatch(/disabled in the roster/);
  });
});

describe('collectHealth — missing and corrupt evidence degrade to unknown', () => {
  it('reports unknown, not healthy, when the daemon cannot be reached', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    const report = await run(null);
    expect(report.daemon.running).toBeNull();
    expect(report.daemon.state).toBe('unknown');
    expect(report.agents[0].reachability).toBe('unknown');
    expect(report.fleet.state).not.toBe('ok');
  });

  it('never claims healthy from a daemon.pid file alone', async () => {
    writeFileSync(join(ctxRoot, 'daemon.pid'), '4242');
    const report = await run(null);
    expect(report.daemon.pid).toBe(4242);
    expect(report.daemon.state).toBe('unknown');
    expect(report.daemon.notes.join(' ')).toMatch(/PID is not a liveness signal/);
  });

  it('reports a corrupt heartbeat as unknown rather than fresh', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    mkdirSync(join(ctxRoot, 'state', 'goose'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'goose', 'heartbeat.json'), '{ truncated');
    const report = await run([RUNNING('goose')]);
    expect(report.agents[0].heartbeatAgeSec).toBeNull();
    expect(report.agents[0].heartbeatState).toBe('unknown');
  });

  it('reports a corrupt crons.json as unknown, not as zero crons', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 60);
    const cronDir = join(ctxRoot, '.cortextOS', 'state', 'agents', 'goose');
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(join(cronDir, 'crons.json'), '{ not json');
    const report = await run([RUNNING('goose')]);
    expect(report.agents[0].cronsEnabled).toBeNull();
    expect(report.agents[0].cronSchedulerState).toBe('unknown');
  });

  it('reports a corrupt roster without losing agents the daemon knows about', async () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'not json at all');
    heartbeat('goose', 60);
    const report = await run([RUNNING('goose')]);
    expect(report.agents.map((a) => a.agent)).toContain('goose');
    expect(report.agents[0].enabled).toBeNull();
  });

  it('marks the fleet failed when the daemon is confirmed down', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    const report = await run([], false);
    expect(report.daemon.state).toBe('fail');
  });
});

describe('collectHealth — queue depth and inflight', () => {
  it('reports queueDepth as null because no queue exists in this build', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 60);
    const report = await run([RUNNING('goose')]);
    expect(report.agents[0].queueDepth).toBeNull();
  });

  it('counts inbox backlog and oldest age', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 60);
    inbox('goose', 3, 7200);
    const report = await run([RUNNING('goose')]);
    expect(report.agents[0].inbox.count).toBe(3);
    expect(report.agents[0].inbox.oldestAgeSec).toBeGreaterThanOrEqual(7000);
    expect(report.agents[0].state).toBe('fail');
  });

  it('counts recent crashes from restarts.log within 24h only', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 60);
    restarts('goose', ['2026-08-01T09:00:00Z', '2026-07-01T09:00:00Z']);
    const report = await run([RUNNING('goose')]);
    expect(report.agents[0].recentCrashes24h).toBe(1);
    expect(report.agents[0].runtimeErrorState).toBe('errors-observed');
  });
});

describe('human and JSON outputs carry the same facts', () => {
  it('renders every JSON leaf value into the text output', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' }, forge: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 120);
    inbox('forge', 2, 300);
    const report = await run([RUNNING('goose'), { name: 'forge', status: 'stopped' }]);

    const text = renderHuman(report);

    for (const a of report.agents) {
      expect(text).toContain(a.agent);
      expect(text).toContain(a.reachability);
      expect(text).toContain(a.state === 'ok' ? 'OK' : a.state.toUpperCase());
      expect(text).toContain(`cronScheduler=${a.cronSchedulerState}`);
      expect(text).toContain(`telegramPoller=${a.telegramPoller}`);
      expect(text).toContain(`runtimeErrors=${a.runtimeErrorState}`);
      for (const note of a.notes) expect(text).toContain(note);
    }
    expect(text).toContain(report.instanceId);
    expect(text).toContain(report.ctxRoot);
    expect(text).toContain(`total=${report.fleet.total}`);
    expect(text).toContain(`fail=${report.fleet.fail}`);
  });

  it('is built from one report object, so the two views cannot diverge', async () => {
    roster({ goose: { enabled: true, org: 'atlasos' } });
    heartbeat('goose', 120);
    const report = await run([RUNNING('goose')]);
    const parsed = JSON.parse(JSON.stringify(report)) as HealthReport;
    expect(renderHuman(parsed)).toBe(renderHuman(report));
  });
});

describe('exit codes', () => {
  it('maps ok to 0, warn and unknown to 1, fail to 2', () => {
    expect(exitCodeFor('ok')).toBe(EXIT_OK);
    expect(exitCodeFor('warn')).toBe(EXIT_WARN);
    // "unknown" must not look like success to a scheduler.
    expect(exitCodeFor('unknown')).toBe(EXIT_WARN);
    expect(exitCodeFor('fail')).toBe(EXIT_FAIL);
  });
});
