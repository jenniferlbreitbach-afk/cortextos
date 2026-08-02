import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import {
  classify,
  inventoryHealthCrons,
  planConversions,
} from '../../../src/bus/health-cron-inventory';

let ctxRoot: string;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'cron-inv-'));
});

afterEach(() => {
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeCrons(agent: string, crons: Array<Record<string, unknown>>, raw?: string): string {
  const dir = join(ctxRoot, '.cortextOS', 'state', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'crons.json');
  writeFileSync(path, raw ?? JSON.stringify({ updated_at: '2026-08-01T00:00:00Z', crons }, null, 2));
  return path;
}

/** Digest + mtime of every crons.json under the fixture tree. */
function snapshotTree(): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(ctxRoot, '.cortextOS', 'state', 'agents');
  for (const agent of readdirSync(base)) {
    const p = join(base, agent, 'crons.json');
    try {
      const buf = readFileSync(p);
      const st = statSync(p);
      out.set(p, `${createHash('sha256').update(buf).digest('hex')}:${st.mtimeMs}:${st.size}`);
    } catch { /* skip */ }
  }
  return out;
}

// --- classification --------------------------------------------------------

describe('classify', () => {
  it('classifies a pure liveness check as a conversion candidate', () => {
    const r = classify(
      'check-agent-health',
      'Run scripts/check-agent-health.js to check all roster agents have running PIDs.',
    );
    expect(r.klass).toBe('deterministic-health-candidate');
  });

  it('classifies the real goose/heartbeat cron as agent work, not a health check', () => {
    // This is the only enabled health-named cron in the live fleet. Its steps
    // 1-4 already run zero-token; what remains is memory, goals, and resuming
    // work — which no deterministic check can reproduce.
    const r = classify(
      'heartbeat',
      'Steps 1-4 of HEARTBEAT.md ALREADY RAN zero-token via the Windows Scheduled Task '
      + 'zero-token-hb-goose (every 2h). DO NOT repeat them. Read HEARTBEAT.md and execute ONLY '
      + 'steps 5-8: write daily memory, check GOALS.md, resume highest-priority work, update '
      + 'long-term memory if applicable.',
    );
    expect(r.klass).toBe('planning-or-agent-work');
    expect(r.rationale).toMatch(/memory|goals|planning|resuming/i);
  });

  it('classifies a business check as a business workflow', () => {
    const r = classify(
      'amazon-live-check',
      "Check whether the print book 'A Goose Named Aaron' (ISBN 9798997261467) is live on Amazon: run a WebSearch",
    );
    expect(r.klass).toBe('business-workflow');
  });

  it('classifies inbox routing as inbox processing', () => {
    const r = classify('ghl-convo-monitor', 'monitor GHL conversations and route new messages to Timber');
    expect(r.klass).not.toBe('deterministic-health-candidate');
  });

  it('prefers the disqualifying category when a cron both checks and does work', () => {
    const r = classify(
      'daily-health',
      'Run daily system health check: verify services are healthy, then write daily memory and review priorities.',
    );
    expect(r.klass).toBe('planning-or-agent-work');
  });

  it('defaults to ambiguous rather than guessing', () => {
    expect(classify('theta-wave', 'Initiate the theta wave cycle.').klass).toBe('ambiguous');
  });

  it('never marks an unclassifiable cron as a candidate', () => {
    for (const [name, prompt] of [['x', ''], ['', ''], ['zzz', 'do the thing']]) {
      expect(classify(name, prompt).klass).not.toBe('deterministic-health-candidate');
    }
  });
});

// --- inventory -------------------------------------------------------------

describe('inventoryHealthCrons', () => {
  it('is strictly read-only — no cron record is modified', () => {
    writeCrons('forge', [
      { name: 'check-agent-health', prompt: 'check all agents have running PIDs', schedule: '*/15 * * * *', enabled: true },
    ]);
    writeCrons('goose', [
      { name: 'heartbeat', prompt: 'write daily memory and resume highest-priority work', schedule: '4h', enabled: true },
    ]);

    const before = snapshotTree();
    inventoryHealthCrons({ ctxRoot });
    planConversions(inventoryHealthCrons({ ctxRoot }));
    const after = snapshotTree();

    expect(after).toEqual(before);
  });

  it('marks only enabled health candidates eligible', () => {
    writeCrons('forge', [
      { name: 'check-agent-health', prompt: 'check all agents have running PIDs', schedule: '*/15 * * * *', enabled: true },
      { name: 'dashboard-watchdog', prompt: 'check dashboard health', schedule: '*/30 * * * *', enabled: false },
    ]);

    const inv = inventoryHealthCrons({ ctxRoot });
    const enabled = inv.rows.find((r) => r.name === 'check-agent-health')!;
    const disabled = inv.rows.find((r) => r.name === 'dashboard-watchdog')!;

    expect(enabled.eligible).toBe(true);
    expect(disabled.klass).toBe('deterministic-health-candidate');
    expect(disabled.eligible).toBe(false);
    expect(inv.totals.enabledHealthCandidates).toBe(1);
  });

  it('reports unreadable crons.json instead of throwing', () => {
    writeCrons('polly', [], '{ this is not json');
    const inv = inventoryHealthCrons({ ctxRoot });
    expect(inv.unreadable).toContain('polly');
    expect(inv.rows).toHaveLength(0);
  });

  it('tolerates a UTF-8 BOM', () => {
    writeCrons('timber', [], '﻿' + JSON.stringify({
      crons: [{ name: 'heartbeat-check', prompt: 'verify liveness', schedule: '1h', enabled: true }],
    }));
    const inv = inventoryHealthCrons({ ctxRoot });
    expect(inv.unreadable).not.toContain('timber');
    expect(inv.rows).toHaveLength(1);
  });

  it('returns an empty inventory when no cron tree exists', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cron-inv-empty-'));
    const inv = inventoryHealthCrons({ ctxRoot: empty });
    expect(inv.rows).toEqual([]);
    expect(inv.totals.definitions).toBe(0);
    rmSync(empty, { recursive: true, force: true });
  });

  it('can restrict the inventory to enabled crons', () => {
    writeCrons('forge', [
      { name: 'a', prompt: 'check liveness', schedule: '1h', enabled: true },
      { name: 'b', prompt: 'check liveness', schedule: '1h', enabled: false },
    ]);
    expect(inventoryHealthCrons({ ctxRoot, enabledOnly: true }).rows).toHaveLength(1);
    expect(inventoryHealthCrons({ ctxRoot }).rows).toHaveLength(2);
  });
});

// --- dry run ---------------------------------------------------------------

describe('planConversions', () => {
  it('proposes nothing when the only enabled crons are ineligible', () => {
    // Mirrors the live fleet: goose/heartbeat + goose/amazon-live-check.
    writeCrons('goose', [
      { name: 'heartbeat', prompt: 'write daily memory, resume highest-priority work', schedule: '4h', enabled: true },
      { name: 'amazon-live-check', prompt: 'Check whether the book is live on Amazon via WebSearch', schedule: '2h', enabled: true },
    ]);

    const plan = planConversions(inventoryHealthCrons({ ctxRoot }));
    expect(plan.changes).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.note).toMatch(/No enabled cron is safely convertible/);
  });

  it('never applies anything', () => {
    writeCrons('forge', [
      { name: 'check-agent-health', prompt: 'check all agents have running PIDs', schedule: '*/15 * * * *', enabled: true },
    ]);
    const plan = planConversions(inventoryHealthCrons({ ctxRoot }));
    expect(plan.applied).toBe(false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.note).toMatch(/DRY RUN ONLY/);
  });

  it('preserves the original definition as migration evidence', () => {
    writeCrons('forge', [
      { name: 'check-agent-health', prompt: 'check all agents have running PIDs', schedule: '*/15 * * * *', enabled: true },
    ]);
    const plan = planConversions(inventoryHealthCrons({ ctxRoot }));
    expect(plan.changes[0].original).toMatchObject({
      agent: 'forge',
      name: 'check-agent-health',
      schedule: '*/15 * * * *',
      enabled: true,
    });
  });

  it('records a reason for every cron it declines to convert', () => {
    writeCrons('goose', [
      { name: 'heartbeat', prompt: 'resume highest-priority work', schedule: '4h', enabled: true },
      { name: 'old', prompt: 'check liveness', schedule: '1h', enabled: false },
    ]);
    const plan = planConversions(inventoryHealthCrons({ ctxRoot }));
    expect(plan.skipped).toHaveLength(2);
    for (const s of plan.skipped) expect(s.reason.length).toBeGreaterThan(0);
  });
});
