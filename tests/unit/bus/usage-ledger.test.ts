import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import {
  LEDGER_FIELDS,
  MAX_IDENTIFIER_LENGTH,
  REQUEST_ID_PATTERN,
  MAX_LEDGER_LINES,
  RECONCILIATION_DISCLAIMER,
  dayKey,
  ledgerDir,
  ledgerFileFor,
  readLedger,
  recordAttempt,
  reconcileTokens,
  summarize,
  type UsageLedgerEntry,
} from '../../../src/bus/usage-ledger';
import { EMPTY_PAYLOAD, measurePayload } from '../../../src/bus/payload-metadata';

let ctxRoot: string;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
  delete process.env.CTX_USAGE_LEDGER;
});

afterEach(() => {
  delete process.env.CTX_USAGE_LEDGER;
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function linesFor(day = dayKey()): UsageLedgerEntry[] {
  const file = ledgerFileFor(day, ctxRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as UsageLedgerEntry);
}

describe('recordAttempt — record shape', () => {
  it('writes one line per attempt with the exact allowlisted field set', () => {
    recordAttempt({
      agent: 'goose',
      workspace: 'atlasos',
      runtime: 'claude-code',
      model: 'claude-sonnet-4-6',
      result: 'dispatched',
      payload: measurePayload('hello'),
      latencyMs: 12,
      meta: { source: 'cron', purpose: 'cron-fire', requestId: 'heartbeat@2026-08-01T00:00:00Z' },
      ctxRoot,
    });

    const rows = linesFor();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([...LEDGER_FIELDS].sort());
    expect(rows[0].agent).toBe('goose');
    expect(rows[0].source).toBe('cron');
    expect(rows[0].purpose).toBe('cron-fire');
    expect(rows[0].result).toBe('dispatched');
    expect(rows[0].rejection_reason).toBeNull();
    expect(rows[0].payload_bytes).toBe(5);
  });

  it('records every rejection reason, not just dispatches', () => {
    for (const reason of ['not_running', 'deduped', 'not_found'] as const) {
      recordAttempt({
        agent: 'forge',
        result: 'rejected',
        rejectionReason: reason,
        payload: measurePayload('x'),
        ctxRoot,
      });
    }
    const rows = linesFor();
    expect(rows.map((r) => r.rejection_reason)).toEqual(['not_running', 'deduped', 'not_found']);
    expect(rows.every((r) => r.result === 'rejected')).toBe(true);
  });

  it('defaults an un-instrumented caller to unknown rather than failing', () => {
    recordAttempt({ agent: 'lex', result: 'dispatched', payload: measurePayload('x'), ctxRoot });
    const [row] = linesFor();
    expect(row.source).toBe('unknown');
    expect(row.purpose).toBe('unknown');
    expect(row.request_id).toBeNull();
  });
});

describe('privacy - no content, and nothing derived from content, is stored', () => {
  const SECRET = 'CANARY-sk-live-9f3a-DO-NOT-PERSIST';

  it('does not persist payload text anywhere in the ledger', () => {
    recordAttempt({
      agent: 'timber',
      result: 'dispatched',
      payload: measurePayload('=== TELEGRAM from Jennifer ===\n' + SECRET + '\n'),
      meta: { source: 'telegram', purpose: 'telegram-message' },
      ctxRoot,
    });

    const raw = readFileSync(ledgerFileFor(dayKey(), ctxRoot), 'utf-8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('TELEGRAM from');
  });

  it('stores no hash, encoding, excerpt, prefix or suffix of the content', () => {
    recordAttempt({
      agent: 'timber',
      result: 'dispatched',
      payload: measurePayload(SECRET),
      meta: { source: 'telegram', purpose: 'telegram-message', requestId: 'update-991' },
      ctxRoot,
    });

    const [row] = linesFor();
    // Primary guarantee: schema allowlist. Only these keys are ever written.
    expect(Object.keys(row).sort()).toEqual([...LEDGER_FIELDS].sort());

    // Behavioural: no stored value derives from the content, under any of the
    // encodings or digests a future change might plausibly reach for.
    const derivations = [
      SECRET,
      SECRET.slice(0, 8),
      SECRET.slice(-8),
      Buffer.from(SECRET, 'utf-8').toString('base64'),
      Buffer.from(SECRET, 'utf-8').toString('hex'),
      encodeURIComponent(SECRET),
      createHash('sha256').update(SECRET).digest('hex'),
      createHash('sha256').update(SECRET).digest('base64'),
      createHash('md5').update(SECRET).digest('hex'),
      createHash('sha1').update(SECRET).digest('hex'),
    ];
    const serialized = JSON.stringify(row);
    for (const d of derivations) expect(serialized).not.toContain(d);

    // Nothing digest-shaped is present at all.
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toMatch(/^[0-9a-f]{32,}$/);
    }
  });

  it('makes two different payloads of equal size indistinguishable', () => {
    // The strongest form of the property: the record cannot fingerprint
    // content, so equal-length payloads yield identical records modulo time.
    recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('AAAAAAAAAA'), ctxRoot });
    recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('a secret!!'), ctxRoot });

    const [r1, r2] = linesFor();
    const strip = (r: UsageLedgerEntry) => ({ ...r, ts: '', latency_ms: 0 });
    expect(strip(r1)).toEqual(strip(r2));
  });

  it('runtime-rejects a raw string forced past the type system', () => {
    // The compiler rejects `payload: string`; this covers a JS caller or an
    // `as any` that defeats it.
    recordAttempt({
      agent: 'timber',
      result: 'dispatched',
      payload: ('=== TELEGRAM ===\n' + SECRET) as unknown as ReturnType<typeof measurePayload>,
      ctxRoot,
    });

    const raw = readFileSync(ledgerFileFor(dayKey(), ctxRoot), 'utf-8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('TELEGRAM');
    const [row] = linesFor();
    expect(row.payload_bytes).toBe(0);
    expect(row.message_count).toBeNull();
  });
});

describe('request ids - bounded, content-free, not a dedup key', () => {
  const SECRET = 'CANARY-sk-live-9f3a-DO-NOT-PERSIST';

  it('drops an id containing a newline or control character', () => {
    recordAttempt({
      agent: 'timber',
      result: 'dispatched',
      payload: measurePayload('x'),
      meta: { source: 'bus', purpose: 'inbox-delivery', requestId: 'line one\n' + SECRET },
      ctxRoot,
    });
    const raw = readFileSync(ledgerFileFor(dayKey(), ctxRoot), 'utf-8');
    expect(raw).not.toContain(SECRET);
    expect(linesFor()[0].request_id).toBeNull();
  });

  it('drops an over-long id rather than truncating it', () => {
    recordAttempt({
      agent: 'timber', result: 'dispatched', payload: measurePayload('x'),
      meta: { requestId: 'A'.repeat(MAX_IDENTIFIER_LENGTH + 1) }, ctxRoot,
    });
    expect(linesFor()[0].request_id).toBeNull();
  });

  it('drops prose-shaped ids: any whitespace fails the allowlist', () => {
    recordAttempt({
      agent: 'timber', result: 'dispatched', payload: measurePayload('x'),
      meta: { requestId: 'please call me back about the offer' }, ctxRoot,
    });
    expect(linesFor()[0].request_id).toBeNull();
  });

  it('rejects every character outside the allowlist', () => {
    const bad = [
      'has space',
      'tab\tsep',
      'slash/path',
      'semi;colon',
      'quote"mark',
      "apos'trophe",
      'back\\slash',
      'brace{x}',
      'percent%20',
      'hash#frag',
      'amp&amp',
      'star*',
      'paren(1)',
      'comma,list',
      'lt<gt>',
      'pipe|x',
      'dollar$',
      'question?',
      'equals=',
      'tilde~',
      'caret^',
      'bang!',
      '-leading-dash',
      '.leading-dot',
      '@leading-at',
      '_leading-underscore',
    ];
    for (const id of bad) {
      recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('y'), meta: { requestId: id }, ctxRoot });
    }
    const rows = linesFor();
    expect(rows).toHaveLength(bad.length);
    for (const r of rows) expect(r.request_id).toBeNull();
  });

  it('accepts every id format cortextOS actually generates', () => {
    // Inventoried from the real generators, including an agent name with the
    // underscore that validateAgentName permits.
    const valid = [
      '1754000000000-forge-ab12c',
      '1754000000000-my_agent-ab12c',
      '1754000000000-forge-ab12c+2',
      'heartbeat@2026-08-01T00:00:00.000Z',
      'fleet-cron-health@2026-08-01T12:30:00.000Z',
      'fresh@2026-08-01T00:00:00.000Z',
      'continue@2026-08-01T00:00:00.000Z',
      'worker-spawn@2026-08-01T00:00:00.000Z',
    ];
    for (const id of valid) {
      recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('y'), meta: { requestId: id }, ctxRoot });
    }
    expect(linesFor().map((r) => r.request_id)).toEqual(valid);
  });

  it('every id matches REQUEST_ID_PATTERN by construction', () => {
    for (const id of [
      '1754000000000-forge-ab12c',
      '1754000000000-my_agent-ab12c+3',
      'heartbeat@2026-08-01T00:00:00.000Z',
    ]) {
      expect(REQUEST_ID_PATTERN.test(id)).toBe(true);
    }
    for (const id of ['has space', 'slash/x', '-leading', '']) {
      expect(REQUEST_ID_PATTERN.test(id)).toBe(false);
    }
  });

  it('keeps the real identifier shapes this system produces', () => {
    const valid = [
      '1754000000000-forge-ab12c',
      'heartbeat@2026-08-01T00:00:00.000Z',
      'continue@2026-08-01T00:00:00.000Z',
      '1754000000000-forge-ab12c+3',
      'update-991',
    ];
    for (const id of valid) {
      recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('y'), meta: { requestId: id }, ctxRoot });
    }
    expect(linesFor().map((r) => r.request_id)).toEqual(valid);
  });

  it('is independent of content: same id across different bodies', () => {
    const id = '1754000000000-forge-ab12c';
    recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('body one'), meta: { requestId: id }, ctxRoot });
    recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('a totally different body'), meta: { requestId: id }, ctxRoot });

    const rows = linesFor();
    expect(rows[0].request_id).toBe(id);
    expect(rows[1].request_id).toBe(id);
    expect(rows[0].payload_bytes).not.toBe(rows[1].payload_bytes);
  });

  it('stores null when no safe identifier exists, never a manufactured one', () => {
    recordAttempt({ agent: 'x', result: 'dispatched', payload: measurePayload('some content'), ctxRoot });
    expect(linesFor()[0].request_id).toBeNull();
  });
});

describe('measurePayload', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // 'e' + combining acute: 3 bytes; String.length would say 2.
    expect(measurePayload('é').payloadBytes).toBe(3);
    // Cyrillic: 2 bytes per character.
    expect(measurePayload('привет').payloadBytes).toBe(12);
    // Astral-plane emoji: 4 bytes; String.length would say 2.
    expect(measurePayload('\u{1F44D}').payloadBytes).toBe(4);
    // Mixed CJK + ASCII: 6 ASCII + 2 x 3-byte CJK.
    expect(measurePayload('hello 世界').payloadBytes).toBe(12);
    expect(measurePayload('ascii').payloadBytes).toBe(5);
  });

  it('produces no content-derived fields at all', () => {
    expect(Object.keys(measurePayload('anything')).sort()).toEqual(['messageCount', 'payloadBytes']);
  });

  it('is total - malformed input yields zero/unknown metadata, never a throw', () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol('x')]) {
      expect(() => measurePayload(bad)).not.toThrow();
      expect(measurePayload(bad)).toEqual(EMPTY_PAYLOAD);
    }
  });

  it('carries a message count when known, null otherwise', () => {
    expect(measurePayload('x', 4).messageCount).toBe(4);
    expect(measurePayload('x').messageCount).toBeNull();
    expect(measurePayload('x', -1).messageCount).toBeNull();
    expect(measurePayload('x', NaN).messageCount).toBeNull();
  });

  it('malformed metadata does not prevent a record being written', () => {
    recordAttempt({
      agent: 'x', result: 'dispatched',
      payload: measurePayload(undefined), ctxRoot,
    });
    const [row] = linesFor();
    expect(row.payload_bytes).toBe(0);
    expect(row.message_count).toBeNull();
    expect(row.result).toBe('dispatched');
  });
});

describe('recordAttempt — never throws, never blocks', () => {
  it('survives an unwritable ledger path', () => {
    // A FILE where the ledger directory must be: mkdir and append both fail.
    const usageDir = join(ctxRoot, 'state', 'usage');
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(join(usageDir, 'ledger'), 'not a directory');

    expect(() => recordAttempt({
      agent: 'goose', result: 'dispatched', payload: measurePayload('x'), ctxRoot,
    })).not.toThrow();
  });

  it('survives malformed input without throwing', () => {
    expect(() => recordAttempt({
      agent: undefined as unknown as string,
      result: 'dispatched',
      payload: undefined,
      ctxRoot,
    })).not.toThrow();
  });

  it('returns undefined so no caller can branch on it', () => {
    const returned = recordAttempt({ agent: 'g', result: 'dispatched', payload: measurePayload('x'), ctxRoot });
    expect(returned).toBeUndefined();
  });

  it('writes nothing when the kill switch is off', () => {
    process.env.CTX_USAGE_LEDGER = 'off';
    recordAttempt({ agent: 'goose', result: 'dispatched', payload: measurePayload('x'), ctxRoot });
    expect(existsSync(ledgerFileFor(dayKey(), ctxRoot))).toBe(false);
  });
});

describe('readLedger — degraded evidence', () => {
  it('reports corrupt lines instead of throwing', () => {
    recordAttempt({ agent: 'goose', result: 'dispatched', payload: measurePayload('x'), ctxRoot });
    const file = ledgerFileFor(dayKey(), ctxRoot);
    writeFileSync(file, readFileSync(file, 'utf-8') + '{not json\n' + '{"partial":true}\n');

    const read = readLedger({ ctxRoot });
    expect(read.entries).toHaveLength(1);
    expect(read.unparseable).toBe(2);
  });

  it('reports a missing day as missing, not as zero activity', () => {
    const read = readLedger({ ctxRoot, since: '2026-01-01', until: '2026-01-03' });
    expect(read.entries).toHaveLength(0);
    expect(read.missingDays).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('returns empty rather than throwing when no ledger has ever been written', () => {
    expect(() => readLedger({ ctxRoot })).not.toThrow();
    expect(readLedger({ ctxRoot }).entries).toEqual([]);
  });
});

describe('rotation and retention', () => {
  it('prunes a day file down to the line cap once it exceeds the size threshold', () => {
    const dir = ledgerDir(ctxRoot);
    mkdirSync(dir, { recursive: true });
    const file = ledgerFileFor(dayKey(), ctxRoot);

    // Oversized file: enough padded lines to blow the 5 MB threshold.
    const fat = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', agent: 'x', pad: 'p'.repeat(400) });
    writeFileSync(file, Array.from({ length: MAX_LEDGER_LINES + 5_000 }, () => fat).join('\n') + '\n');

    recordAttempt({ agent: 'goose', result: 'dispatched', payload: measurePayload('x'), ctxRoot });

    const remaining = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    expect(remaining.length).toBeLessThanOrEqual(MAX_LEDGER_LINES);
    // The newest record must survive pruning.
    expect(remaining[remaining.length - 1]).toContain('"agent":"goose"');
  });

  it('deletes day files older than the retention window', () => {
    const dir = ledgerDir(ctxRoot);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, '2020-01-01.jsonl');
    writeFileSync(stale, '{}\n');

    recordAttempt({ agent: 'goose', result: 'dispatched', payload: measurePayload('x'), ctxRoot });

    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(dir).some((f) => f === `${dayKey()}.jsonl`)).toBe(true);
  });
});

describe('summarize', () => {
  const entries: UsageLedgerEntry[] = [
    mk({ agent: 'atlas', source: 'cron', result: 'dispatched', payload_bytes: 10 }),
    mk({ agent: 'atlas', source: 'cron', result: 'rejected', payload_bytes: 5 }),
    mk({ agent: 'goose', source: 'telegram', result: 'dispatched', payload_bytes: 7 }),
  ];

  it('groups by every supported dimension', () => {
    for (const by of ['agent', 'workspace', 'source', 'runtime', 'model', 'purpose', 'result'] as const) {
      expect(() => summarize(entries, by)).not.toThrow();
    }
  });

  it('counts dispatched and rejected separately', () => {
    const rows = summarize(entries, 'agent');
    const atlas = rows.find((r) => r.key === 'atlas')!;
    expect(atlas.attempts).toBe(2);
    expect(atlas.dispatched).toBe(1);
    expect(atlas.rejected).toBe(1);
    expect(atlas.payload_bytes).toBe(15);
  });

  it('buckets null dimension values as (unknown) rather than dropping them', () => {
    const rows = summarize([mk({ agent: 'x', workspace: null })], 'workspace');
    expect(rows[0].key).toBe('(unknown)');
  });
});

describe('reconcileTokens', () => {
  it('sums only usage counters and never reads message content', () => {
    const projects = mkdtempSync(join(tmpdir(), 'projects-'));
    const sessionDir = join(projects, 'C--cortext-test-cortextos-orgs-atlasos-agents-goose');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 's.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-01T10:00:00.000Z',
        message: { content: 'SENSITIVE-BODY', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } },
      }),
      JSON.stringify({ timestamp: '2026-08-01T11:00:00.000Z', usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join('\n') + '\n');

    const result = reconcileTokens({
      agents: ['goose'],
      since: '2026-08-01',
      until: '2026-08-01',
      projectsDir: projects,
    });

    expect(result.noEvidence).toBe(false);
    expect(result.byAgent.goose.approx_input_tokens).toBe(106);
    expect(result.byAgent.goose.approx_output_tokens).toBe(22);
    // The reconciler returns counters only — no content field is surfaced.
    expect(JSON.stringify(result)).not.toContain('SENSITIVE-BODY');

    rmSync(projects, { recursive: true, force: true });
  });

  it('reports noEvidence rather than zero when no transcripts match', () => {
    const empty = mkdtempSync(join(tmpdir(), 'projects-empty-'));
    const result = reconcileTokens({ agents: ['goose'], projectsDir: empty });
    expect(result.noEvidence).toBe(true);
    expect(result.byAgent).toEqual({});
    rmSync(empty, { recursive: true, force: true });
  });

  it('skips session directories that match no known agent', () => {
    const projects = mkdtempSync(join(tmpdir(), 'projects-other-'));
    const other = join(projects, 'C--some-unrelated-project');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 's.jsonl'),
      JSON.stringify({ usage: { input_tokens: 999, output_tokens: 999 } }) + '\n');

    const result = reconcileTokens({ agents: ['goose'], projectsDir: projects });
    expect(result.byAgent).toEqual({});
    rmSync(projects, { recursive: true, force: true });
  });

  it('exposes an approximation disclaimer for consumers to surface', () => {
    expect(RECONCILIATION_DISCLAIMER).toMatch(/APPROXIMATE/);
    expect(RECONCILIATION_DISCLAIMER).toMatch(/not an invoice/i);
  });
});

function mk(partial: Partial<UsageLedgerEntry>): UsageLedgerEntry {
  return {
    ts: '2026-08-01T00:00:00.000Z',
    request_id: null,
    workspace: 'atlasos',
    agent: 'agent',
    actor: 'agent',
    runtime: 'claude-code',
    model: 'claude-sonnet-4-6',
    source: 'unknown',
    purpose: 'unknown',
    result: 'dispatched',
    rejection_reason: null,
    latency_ms: null,
    payload_bytes: 0,
    message_count: null,
    ...partial,
  };
}
