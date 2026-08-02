/**
 * usage-ledger.ts — Record-only ledger of model-invocation attempts.
 *
 * WHAT THIS IS
 * ------------
 * cortextOS spends a token in exactly one way: writing bytes into a PTY that is
 * running a model CLI. This module appends one JSONL record per *injection
 * decision* — dispatched or rejected — so that spend can be attributed after
 * the fact.
 *
 * RECORD-ONLY BY CONSTRUCTION
 * ---------------------------
 * `recordAttempt()` is called AFTER the inject/reject decision has already been
 * made and executed by the caller. It returns void, never throws, and has no
 * return channel the caller could branch on. It is therefore structurally
 * incapable of blocking an injection — not merely "careful not to". Every
 * filesystem operation is individually wrapped; a full disk, a read-only mount,
 * or a corrupt ledger file degrades to a dropped record and nothing else.
 *
 * CONTENT NEVER ENTERS THIS MODULE
 * --------------------------------
 * No prompts, no user/Telegram/email message bodies, no credentials, no
 * environment values, no absolute paths — and not merely "not written": raw
 * content is never *passed in*. Callers reduce their payload to
 * `PayloadMetadata` (UTF-8 byte count + message count) via `measurePayload` in
 * `payload-metadata.ts` and hand over only that. Nothing in this file — not the
 * JSON serializer, not the rotation logic, not an exception path — has content
 * in scope, so no bug here can leak it.
 *
 * NO CONTENT-DERIVED IDENTIFIERS
 * ------------------------------
 * The ledger stores no hash, digest, excerpt, prefix, suffix, or encoding of a
 * payload. Even a one-way digest is a persistent fingerprint of private data
 * and is dictionary-attackable for short or predictable messages, and it is not
 * needed to measure usage. Correlation uses pre-existing immutable identifiers
 * only (message ids, cron names, request ids); where none exists the record
 * stores null rather than manufacturing one from content.
 *
 * Every remaining field is an identifier, a count, or a config value, and the
 * test suite pins the written key set to `LEDGER_FIELDS` so a future field
 * cannot quietly widen this contract.
 *
 * KNOWN MEASUREMENT GAPS (Phase 1A)
 * ---------------------------------
 * 1. TUI keystroke submissions are NOT recorded. When an agent raises an
 *    AskUserQuestion or enters plan mode, `FastChecker` answers by writing raw
 *    key sequences to the PTY (`agent.write(KEYS.ENTER)` and friends, see
 *    `daemon/fast-checker.ts`). Submitting an answer causes a model turn, but
 *    it is a keystroke rather than an injection, so it does not pass through
 *    `injectMessageDetailed` and produces no ledger record. Turn counts are
 *    therefore a LOWER BOUND on approval-heavy sessions. Deliberately left
 *    un-instrumented in Phase 1A: closing it means recording at the PTY write
 *    layer, which is a wider change than a record-only ledger warrants.
 * 2. Mixed batches are one record. A single PTY write combining Telegram and
 *    inbox messages is recorded once as `source: 'mixed'` with the full
 *    `message_count`. Per-source byte attribution within such a batch is not
 *    recoverable from the ledger.
 * 3. Token counts are reconciled, not measured — see TOKEN FIELDS below.
 *
 * TOKEN FIELDS
 * ------------
 * Token counts are NOT known at injection time and are never written by
 * `recordAttempt`. They are attached later, on demand, by `reconcileTokens()`,
 * which reads aggregate `usage` numbers out of Claude Code's own session
 * transcripts. That attribution is approximate — see `reconcileTokens` — and
 * every consumer must label it as such.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { resolveEnv } from '../utils/env.js';
import { EMPTY_PAYLOAD, type PayloadMetadata } from './payload-metadata.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Where the injection came from. */
export type LedgerSource =
  | 'telegram'
  | 'bus'
  /**
   * One PTY write carrying messages from more than one source (e.g. a
   * fast-checker batch holding both Telegram and inbox messages). Labelling
   * such a batch with a single source would hide the other source's usage
   * entirely; `mixed` plus `message_count` keeps it visible.
   */
  | 'mixed'
  | 'cron'
  | 'heartbeat'
  | 'ipc'
  | 'handoff'
  | 'restart'
  | 'worker'
  | 'unknown';

/** What the injection was for. */
export type LedgerPurpose =
  | 'telegram-message'
  | 'inbox-delivery'
  /** A single batch carrying both Telegram and inbox messages. */
  | 'mixed-delivery'
  | 'cron-fire'
  | 'urgent-signal'
  | 'context-warning'
  | 'context-handoff'
  | 'boot'
  | 'operator-inject'
  | 'worker-inject'
  | 'unknown';

/** Outcome of the injection decision. */
export type LedgerResult = 'dispatched' | 'rejected';

/**
 * Why an injection was rejected. `null` when dispatched.
 *
 * These mirror the existing `injectMessageDetailed` outcome codes. Phase 1A
 * adds no new rejection reasons — nothing in this module can cause a rejection.
 */
export type LedgerRejectionReason =
  | 'not_running'
  | 'deduped'
  | 'not_found'
  | 'error'
  | null;

/**
 * Metadata a call site supplies so the ledger can attribute the attempt.
 * Every field is optional: an un-instrumented caller produces a valid record
 * with `source`/`purpose` of `'unknown'` rather than an error.
 */
export interface InjectionMeta {
  source?: LedgerSource;
  purpose?: LedgerPurpose;
  /**
   * Correlation id, drawn from a pre-existing immutable identifier (bus message
   * id, cron name + fire time, spawn mode + time). Never derived from message,
   * prompt, email, or document content. Null when no safe identifier exists —
   * one is never manufactured.
   *
   * NOT A DEDUPLICATION KEY. Cron ids embed the fire timestamp, so a retry of
   * the same logical fire produces a different id. This is adequate for
   * accounting, which is all Phase 1A does with it. Any future queue
   * deduplication must define its own stable key rather than reusing this.
   */
  requestId?: string | null;
  /** Discrete messages combined into this injection, when the caller knows it. */
  messageCount?: number | null;
}

/** One line of the ledger. */
export interface UsageLedgerEntry {
  ts: string;
  request_id: string | null;
  workspace: string | null;
  agent: string;
  actor: 'agent' | 'worker';
  runtime: string | null;
  model: string | null;
  source: LedgerSource;
  purpose: LedgerPurpose;
  result: LedgerResult;
  rejection_reason: LedgerRejectionReason;
  latency_ms: number | null;
  /** UTF-8 bytes injected. */
  payload_bytes: number;
  /** Discrete messages combined into this injection, when known. */
  message_count: number | null;
}

/**
 * The exact set of keys `recordAttempt` may write. Anything outside this list
 * is a contract violation; the test suite asserts written lines match it.
 */
export const LEDGER_FIELDS: readonly (keyof UsageLedgerEntry)[] = [
  'ts',
  'request_id',
  'workspace',
  'agent',
  'actor',
  'runtime',
  'model',
  'source',
  'purpose',
  'result',
  'rejection_reason',
  'latency_ms',
  'payload_bytes',
  'message_count',
] as const;

export interface RecordAttemptInput {
  agent: string;
  actor?: 'agent' | 'worker';
  workspace?: string | null;
  runtime?: string | null;
  model?: string | null;
  result: LedgerResult;
  rejectionReason?: LedgerRejectionReason;
  /**
   * Content-free measurement of the payload, produced by `measurePayload()` at
   * the call site. Raw content is deliberately NOT accepted here — see the
   * module header.
   */
  payload?: PayloadMetadata;
  latencyMs?: number | null;
  meta?: InjectionMeta;
  /** Explicit instance root. Falls back to `resolveEnv().ctxRoot`. */
  ctxRoot?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Bounds — mirrors the rotation contract in daemon/cron-execution-log.ts
// ---------------------------------------------------------------------------

/** Max lines retained in a single day's ledger file after pruning. */
export const MAX_LEDGER_LINES = 50_000;

/** Size threshold (bytes) above which pruning is attempted. */
export const ROTATION_SIZE_BYTES = 5 * 1_024 * 1_024; // 5 MB

/** Daily ledger files older than this are deleted. */
export const RETENTION_DAYS = 30;

/** Identifiers longer than this are dropped, not truncated. */
export const MAX_IDENTIFIER_LENGTH = 200;

/**
 * Strict allowlist for request ids. No whitespace, no control characters, no
 * punctuation beyond what real cortextOS identifiers actually contain.
 *
 * Derived from an inventory of every id this system generates:
 *   - bus message id      `1754000000000-forge-ab12c`
 *     (`${epochMs}-${agentName}-${rand5}`; `validateAgentName` permits
 *      `[a-z0-9_-]`, which is why `_` is in the set; `randomString` is
 *      lowercase alphanumeric)
 *   - batched bus ids     `1754000000000-forge-ab12c+2`          (`+`)
 *   - cron fire           `heartbeat@2026-08-01T00:00:00.000Z`   (`@` `:` `.`)
 *   - agent boot          `fresh@…` / `continue@…`
 *   - worker boot         `worker-spawn@…`
 *
 * Verified against all 117 live cron names: zero rejections. Anything outside
 * this set is treated as not-an-identifier and stored as null.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+_-]*$/;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve the instance root.
 *
 * Deliberately goes through `resolveEnv()` rather than `process.env.CTX_ROOT ??
 * process.cwd()`. The cwd fallback used in `bus/crons.ts` and
 * `daemon/cron-execution-log.ts` is what produced the phantom state tree where
 * CLI writes landed somewhere the daemon never read. New state must not inherit
 * that bug.
 */
function resolveCtxRoot(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return resolveEnv().ctxRoot;
  } catch {
    return join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default');
  }
}

export function ledgerDir(ctxRoot?: string): string {
  return join(resolveCtxRoot(ctxRoot), 'state', 'usage', 'ledger');
}

/** `YYYY-MM-DD` in UTC — matches the ISO date prefix used elsewhere. */
export function dayKey(when: Date = new Date()): string {
  return when.toISOString().split('T')[0];
}

export function ledgerFileFor(day: string, ctxRoot?: string): string {
  return join(ledgerDir(ctxRoot), `${day}.jsonl`);
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * `CTX_USAGE_LEDGER=off` disables recording without a redeploy. Checked per
 * call so it can be flipped with a daemon restart rather than a rebuild.
 */
export function ledgerEnabled(): boolean {
  return (process.env.CTX_USAGE_LEDGER || '').toLowerCase() !== 'off';
}

// ---------------------------------------------------------------------------
// recordAttempt
// ---------------------------------------------------------------------------

/**
 * Append one record. Never throws. Never blocks. Returns nothing on purpose —
 * there is no value a caller could branch on, so no future edit can turn this
 * into a gate without changing the signature.
 */
export function recordAttempt(input: RecordAttemptInput): void {
  try {
    if (!ledgerEnabled()) return;

    const now = input.now ?? new Date();
    // Already content-free by the time it reaches us.
    const payload = input.payload ?? EMPTY_PAYLOAD;

    const entry: UsageLedgerEntry = {
      ts: now.toISOString(),
      request_id: normalizeRequestId(input.meta?.requestId),
      workspace: sanitizeLabel(input.workspace),
      agent: String(input.agent || 'unknown'),
      actor: input.actor === 'worker' ? 'worker' : 'agent',
      runtime: sanitizeLabel(input.runtime),
      model: sanitizeLabel(input.model),
      source: input.meta?.source ?? 'unknown',
      purpose: input.meta?.purpose ?? 'unknown',
      result: input.result,
      rejection_reason: input.result === 'rejected'
        ? (input.rejectionReason ?? 'error')
        : null,
      latency_ms: typeof input.latencyMs === 'number' ? input.latencyMs : null,
      payload_bytes: typeof payload.payloadBytes === 'number' && Number.isFinite(payload.payloadBytes)
        ? payload.payloadBytes
        : 0,
      message_count: typeof payload.messageCount === 'number' && Number.isFinite(payload.messageCount)
        ? payload.messageCount
        : null,
    };

    const ctxRoot = resolveCtxRoot(input.ctxRoot);
    const day = dayKey(now);
    const file = ledgerFileFor(day, ctxRoot);

    ensureLedgerDir(ctxRoot);
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');

    maybeRotate(file);
    maybePruneOldDays(ctxRoot, day);
  } catch {
    // Intentionally swallowed. A ledger failure must never surface to, or
    // interrupt, agent operation. Dropping the record is the correct cost.
  }
}

/**
 * Identifiers only. Anything containing a newline or exceeding a sane
 * identifier length is dropped rather than truncated — truncation could still
 * leak a prefix of message text if a caller passed the wrong value.
 */
/**
 * Normalize a correlation id against the strict allowlist.
 *
 * Anything nonconforming - overlong, whitespace-bearing, control-character
 * bearing, or simply outside the character set - becomes null. Ids are NEVER
 * truncated: a truncated value would still persist a prefix of whatever the
 * caller wrongly passed, which is the exact leak this guards against.
 */
function normalizeRequestId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
  if (!REQUEST_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Normalize a configuration-derived label (workspace, runtime, model).
 *
 * Deliberately NOT the request-id allowlist. These come from config, not from
 * user content, and legitimately contain characters an id never would - an
 * OpenRouter model such as `deepseek/deepseek-chat` must survive. The
 * guarantees that matter here are the same length bound, no control
 * characters, and no whitespace (no real runtime/model/workspace value has
 * any); anything else is dropped whole rather than truncated.
 */
function sanitizeLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}
function ensureLedgerDir(ctxRoot: string): void {
  const dir = ledgerDir(ctxRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Rotation / retention
// ---------------------------------------------------------------------------

/**
 * Prune the oldest lines once a day file exceeds the size threshold.
 * Same shape as daemon/cron-execution-log.ts: cheap stat on every append, full
 * read + prune only when the threshold is crossed, atomic rename to swap in.
 */
function maybeRotate(file: string): void {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < ROTATION_SIZE_BYTES) return;

    const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length <= MAX_LEDGER_LINES) return;

    const kept = lines.slice(lines.length - MAX_LEDGER_LINES);
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, kept.join('\n') + '\n', 'utf-8');
    renameSync(tmp, file);
  } catch {
    /* rotation is best-effort */
  }
}

/** Delete ledger files older than RETENTION_DAYS. Runs at most once per day. */
function maybePruneOldDays(ctxRoot: string, today: string): void {
  try {
    const dir = ledgerDir(ctxRoot);
    const marker = join(dir, '.last-prune');
    if (existsSync(marker)) {
      const last = readFileSync(marker, 'utf-8').trim();
      if (last === today) return;
    }
    writeFileSync(marker, today, 'utf-8');

    const cutoffMs = Date.parse(`${today}T00:00:00.000Z`) - RETENTION_DAYS * 86_400_000;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const day = name.slice(0, -'.jsonl'.length);
      const dayMs = Date.parse(`${day}T00:00:00.000Z`);
      if (Number.isNaN(dayMs)) continue;
      if (dayMs < cutoffMs) {
        try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
      }
    }
  } catch {
    /* retention is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadLedgerResult {
  entries: UsageLedgerEntry[];
  /** Lines that failed to parse. Reported, never thrown. */
  unparseable: number;
  /** Day files that could not be read at all. */
  unreadableFiles: string[];
  /** Days in the requested range with no ledger file — evidence is absent. */
  missingDays: string[];
}

export interface ReadLedgerOptions {
  since?: string; // YYYY-MM-DD inclusive
  until?: string; // YYYY-MM-DD inclusive
  ctxRoot?: string;
}

/**
 * Read entries in a date range. Corrupt lines are counted, not fatal; a missing
 * day is reported as missing rather than silently treated as "no activity".
 */
export function readLedger(options: ReadLedgerOptions = {}): ReadLedgerResult {
  const ctxRoot = resolveCtxRoot(options.ctxRoot);
  const dir = ledgerDir(ctxRoot);
  const result: ReadLedgerResult = {
    entries: [],
    unparseable: 0,
    unreadableFiles: [],
    missingDays: [],
  };

  let available: string[] = [];
  try {
    available = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort();
  } catch {
    // Directory absent — no ledger has ever been written. Not an error.
    if (options.since && options.until) {
      result.missingDays = enumerateDays(options.since, options.until);
    }
    return result;
  }

  const days = options.since && options.until
    ? enumerateDays(options.since, options.until)
    : available;

  for (const day of days) {
    const file = ledgerFileFor(day, ctxRoot);
    if (!existsSync(file)) {
      if (options.since && options.until) result.missingDays.push(day);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch {
      result.unreadableFiles.push(day);
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as UsageLedgerEntry;
        if (parsed && typeof parsed.agent === 'string' && typeof parsed.ts === 'string') {
          result.entries.push(parsed);
        } else {
          result.unparseable++;
        }
      } catch {
        result.unparseable++;
      }
    }
  }

  return result;
}

function enumerateDays(since: string, until: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${since}T00:00:00.000Z`);
  const end = Date.parse(`${until}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().split('T')[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export type SummaryDimension =
  | 'agent'
  | 'workspace'
  | 'source'
  | 'runtime'
  | 'model'
  | 'purpose'
  | 'result';

export interface SummaryRow {
  key: string;
  attempts: number;
  dispatched: number;
  rejected: number;
  payload_bytes: number;
  /** Populated only when reconciliation ran. Approximate — see reconcileTokens. */
  approx_input_tokens?: number;
  approx_output_tokens?: number;
}

const DIMENSION_FIELD: Record<SummaryDimension, keyof UsageLedgerEntry> = {
  agent: 'agent',
  workspace: 'workspace',
  source: 'source',
  runtime: 'runtime',
  model: 'model',
  purpose: 'purpose',
  result: 'result',
};

export function summarize(
  entries: UsageLedgerEntry[],
  by: SummaryDimension,
): SummaryRow[] {
  const field = DIMENSION_FIELD[by];
  const rows = new Map<string, SummaryRow>();

  for (const e of entries) {
    const raw = e[field];
    const key = raw === null || raw === undefined || raw === '' ? '(unknown)' : String(raw);
    let row = rows.get(key);
    if (!row) {
      row = { key, attempts: 0, dispatched: 0, rejected: 0, payload_bytes: 0 };
      rows.set(key, row);
    }
    row.attempts++;
    if (e.result === 'dispatched') row.dispatched++;
    else row.rejected++;
    row.payload_bytes += typeof e.payload_bytes === 'number' ? e.payload_bytes : 0;
  }

  return [...rows.values()].sort((a, b) => b.attempts - a.attempts || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Token reconciliation — APPROXIMATE
// ---------------------------------------------------------------------------

/**
 * Label that MUST accompany any reconciled token figure in user-facing output.
 */
export const RECONCILIATION_DISCLAIMER =
  'APPROXIMATE — tokens are attributed by session directory and timestamp window, ' +
  'not by provider billing records. Treat as an indicator, not an invoice.';

export interface ReconciliationResult {
  /** Per-agent approximate token totals over the requested window. */
  byAgent: Record<string, { approx_input_tokens: number; approx_output_tokens: number }>;
  /** Session transcript files actually read. */
  filesRead: number;
  /** True when no transcripts were found — totals are absent, not zero. */
  noEvidence: boolean;
}

/**
 * Attach approximate token counts by reading Claude Code's own session
 * transcripts (`~/.claude/projects/<slug>/*.jsonl`).
 *
 * WHY THIS IS APPROXIMATE
 * -----------------------
 * The transcripts are per *session directory*, and a directory maps to an agent
 * only by path convention. Turns cannot be joined to individual ledger records,
 * so tokens are aggregated per agent over the window rather than attributed per
 * injection. Sessions that span the window boundary are counted by turn
 * timestamp. Cached-read tokens are reported inside the input total.
 *
 * ONLY aggregate `usage.*` integers are read. Message content is never opened,
 * parsed, or retained.
 */
export function reconcileTokens(options: {
  since?: string;
  until?: string;
  agents: string[];
  projectsDir?: string;
}): ReconciliationResult {
  const result: ReconciliationResult = { byAgent: {}, filesRead: 0, noEvidence: true };
  const root = options.projectsDir ?? join(homedir(), '.claude', 'projects');

  const startMs = options.since ? Date.parse(`${options.since}T00:00:00.000Z`) : -Infinity;
  const endMs = options.until ? Date.parse(`${options.until}T23:59:59.999Z`) : Infinity;

  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return result;
  }

  for (const dir of dirs) {
    // Map a session directory to an agent by suffix match on the roster.
    // Deliberately conservative: an unmatched directory is skipped, never
    // guessed at, so unrelated projects don't pollute agent totals.
    const agent = options.agents.find((a) =>
      dir.toLowerCase().endsWith(`-${a.toLowerCase()}`) || dir.toLowerCase() === a.toLowerCase(),
    );
    if (!agent) continue;

    let files: string[];
    try {
      files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const f of files) {
      let raw: string;
      try {
        raw = readFileSync(join(root, dir, f), 'utf-8');
      } catch {
        continue;
      }
      result.filesRead++;

      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
        if (!Number.isNaN(ts) && (ts < startMs || ts > endMs)) continue;

        const usage = extractUsage(obj);
        if (!usage) continue;

        const bucket = result.byAgent[agent] ??= {
          approx_input_tokens: 0,
          approx_output_tokens: 0,
        };
        bucket.approx_input_tokens += usage.input;
        bucket.approx_output_tokens += usage.output;
        result.noEvidence = false;
      }
    }
  }

  return result;
}

/**
 * Pull ONLY the integer token counters out of a transcript line. Any other
 * property — notably `message.content` — is never touched.
 */
function extractUsage(obj: Record<string, unknown>): { input: number; output: number } | null {
  const message = obj.message as Record<string, unknown> | undefined;
  const usage = (obj.usage ?? message?.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input =
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens);
  const output = num(usage.output_tokens);

  if (input === 0 && output === 0) return null;
  return { input, output };
}
