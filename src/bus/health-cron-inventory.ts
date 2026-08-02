/**
 * health-cron-inventory.ts — Classify cron definitions that a deterministic
 * health check could replace.
 *
 * STRICTLY READ-ONLY
 * ------------------
 * This module opens `crons.json` files for reading and never writes, renames,
 * or deletes anything. Producing a conversion *plan* is the entire job;
 * applying one is a separate, separately-approved action that does not exist in
 * this build. The test suite asserts file mtimes and digests are unchanged
 * after an inventory run.
 *
 * CONSERVATIVE BY DEFAULT
 * -----------------------
 * A cron is eligible only when its ENTIRE purpose is a liveness/health check
 * that `cortextos health` already answers. Anything that also writes memory,
 * resumes work, plans, touches a business system, or that we simply cannot
 * classify confidently, is marked ineligible with a stated reason. False
 * negatives here cost nothing; a false positive silently deletes real work.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveEnv } from '../utils/env.js';
import { CRONS_DIRECTORY, cronsPathFor } from './crons-schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CronClass =
  /** Whole purpose is a health/liveness check `cortextos health` can answer. */
  | 'deterministic-health-candidate'
  /** Touches a business system or produces business output. */
  | 'business-workflow'
  /** Writes memory, resumes work, plans, or reviews priorities. */
  | 'planning-or-agent-work'
  /** Delivers messages / processes an inbox. */
  | 'inbox-processing'
  /** Cannot be classified confidently. */
  | 'ambiguous';

export interface CronInventoryRow {
  agent: string;
  name: string;
  schedule: string;
  enabled: boolean;
  pausedReason: string | null;
  klass: CronClass;
  rationale: string;
  /** Eligible for conversion: health candidate AND currently enabled. */
  eligible: boolean;
  /** SHA-free excerpt used for classification, for operator review only. */
  promptExcerpt: string;
}

export interface CronInventoryResult {
  generatedAt: string;
  ctxRoot: string;
  rows: CronInventoryRow[];
  /** Agents whose crons.json existed but could not be parsed. */
  unreadable: string[];
  totals: {
    definitions: number;
    enabled: number;
    enabledHealthCandidates: number;
  };
}

export interface ConversionPlan {
  generatedAt: string;
  /** Proposed changes. Empty means nothing is safely convertible right now. */
  changes: Array<{
    agent: string;
    cron: string;
    action: 'disable-and-replace-with-scheduled-health-check';
    rationale: string;
    /** Verbatim original definition, preserved as migration evidence. */
    original: Record<string, unknown>;
    replacement: string;
  }>;
  /** Everything considered and deliberately not converted. */
  skipped: Array<{ agent: string; cron: string; reason: string }>;
  applied: false;
  note: string;
}

// ---------------------------------------------------------------------------
// Classification vocabulary
// ---------------------------------------------------------------------------

/** Names that suggest a health/liveness purpose. */
const HEALTH_NAME = /health|heartbeat|watchdog|liveness|alive|stale|uptime|monitor/i;

/** Verbs/nouns that indicate the cron does agent work beyond checking. */
const AGENT_WORK = /resume|highest-priority|priority work|write (daily )?memory|long-term memory|goals?\.md|plan\b|planning|review\b|briefing|assess|draft|summari[sz]e|decide/i;

/** Indicators of a business system or business output. */
const BUSINESS = /email|gmail|inbox(es)?\b|ghl\b|deal|property|properties|portfolio|contact|tenant|lease|listing|amazon|isbn|book|invoice|payment|calendar|meeting|outreach|doorloop|clickup|crm|websearch|web search/i;

/** Indicators of message delivery / inbox processing. */
const INBOX = /check.inbox|process.*inbox|route .*message|deliver .*message|reply to/i;

/** Health-check verbs that `cortextos health` can satisfy deterministically. */
const HEALTH_VERB = /check|verify|confirm|report|detect|scan|test/i;

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryOptions {
  ctxRoot?: string;
  now?: Date;
  /** Restrict to currently-enabled crons. Default false (inventory everything). */
  enabledOnly?: boolean;
}

export function inventoryHealthCrons(options: InventoryOptions = {}): CronInventoryResult {
  const ctxRoot = options.ctxRoot ?? resolveCtxRoot();
  const now = options.now ?? new Date();
  const rows: CronInventoryRow[] = [];
  const unreadable: string[] = [];

  const agentsDir = join(ctxRoot, CRONS_DIRECTORY);
  let agents: string[] = [];
  try {
    agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // No cron tree at all — an empty inventory, not an error.
    return {
      generatedAt: now.toISOString(),
      ctxRoot,
      rows,
      unreadable,
      totals: { definitions: 0, enabled: 0, enabledHealthCandidates: 0 },
    };
  }

  for (const agent of agents) {
    const path = join(ctxRoot, cronsPathFor(agent));
    if (!existsSync(path)) continue;

    let defs: Array<Record<string, unknown>>;
    try {
      // Strip a UTF-8 BOM: some agents' crons.json carry one and a naive
      // JSON.parse throws on it.
      const raw = readFileSync(path, 'utf-8').replace(/^﻿/, '');
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : ((parsed as { crons?: unknown[] })?.crons ?? []);
      if (!Array.isArray(list)) throw new Error('not a list');
      defs = list as Array<Record<string, unknown>>;
    } catch {
      unreadable.push(agent);
      continue;
    }

    for (const def of defs) {
      const enabled = def.enabled === true;
      if (options.enabledOnly && !enabled) continue;

      const name = String(def.name ?? '(unnamed)');
      const prompt = String(def.prompt ?? '');
      const { klass, rationale } = classify(name, prompt);

      rows.push({
        agent,
        name,
        schedule: String(def.schedule ?? ''),
        enabled,
        pausedReason: typeof def.paused_reason === 'string' && def.paused_reason.trim() !== ''
          ? def.paused_reason
          : null,
        klass,
        rationale,
        eligible: klass === 'deterministic-health-candidate' && enabled,
        promptExcerpt: prompt.slice(0, 160),
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    ctxRoot,
    rows,
    unreadable,
    totals: {
      definitions: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      enabledHealthCandidates: rows.filter((r) => r.eligible).length,
    },
  };
}

/**
 * Classify one cron. Order matters: the disqualifying categories are tested
 * before the health category, so a cron that both checks health AND resumes
 * work is correctly classified as agent work.
 */
export function classify(name: string, prompt: string): { klass: CronClass; rationale: string } {
  const haystack = `${name}\n${prompt}`;

  if (AGENT_WORK.test(haystack)) {
    return {
      klass: 'planning-or-agent-work',
      rationale: 'Performs agent work (memory, goals, planning, or resuming tasks) '
        + 'that a deterministic check cannot reproduce.',
    };
  }

  if (INBOX.test(haystack)) {
    return {
      klass: 'inbox-processing',
      rationale: 'Processes or routes messages; excluded from conversion by policy.',
    };
  }

  if (BUSINESS.test(haystack)) {
    return {
      klass: 'business-workflow',
      rationale: 'Touches a business system or produces business output.',
    };
  }

  if (HEALTH_NAME.test(name) && HEALTH_VERB.test(prompt)) {
    return {
      klass: 'deterministic-health-candidate',
      rationale: 'Name and body describe a liveness/health check with no side effects '
        + 'beyond reporting — `cortextos health` answers this deterministically.',
    };
  }

  return {
    klass: 'ambiguous',
    rationale: 'Could not be classified confidently; left untouched by design.',
  };
}

// ---------------------------------------------------------------------------
// Dry-run plan
// ---------------------------------------------------------------------------

/**
 * Build a conversion plan. NEVER applies anything — `applied` is the literal
 * `false` and there is no code path that writes.
 *
 * `original` carries the verbatim definition so the plan doubles as migration
 * evidence: whatever a later, separately-approved apply step does, the
 * pre-change definition is recorded here.
 */
export function planConversions(
  inventory: CronInventoryResult,
  now: Date = new Date(),
): ConversionPlan {
  const changes: ConversionPlan['changes'] = [];
  const skipped: ConversionPlan['skipped'] = [];

  for (const row of inventory.rows) {
    if (!row.enabled) {
      skipped.push({ agent: row.agent, cron: row.name, reason: 'not currently enabled' });
      continue;
    }
    if (!row.eligible) {
      skipped.push({ agent: row.agent, cron: row.name, reason: `${row.klass}: ${row.rationale}` });
      continue;
    }
    changes.push({
      agent: row.agent,
      cron: row.name,
      action: 'disable-and-replace-with-scheduled-health-check',
      rationale: row.rationale,
      original: { ...row },
      replacement: `cortextos health --json   (scheduled task, schedule: ${row.schedule || 'unchanged'})`,
    });
  }

  return {
    generatedAt: now.toISOString(),
    changes,
    skipped,
    applied: false,
    note: changes.length === 0
      ? 'No enabled cron is safely convertible. Nothing to do.'
      : 'DRY RUN ONLY. Applying these changes requires separate explicit approval; '
        + 'this build contains no code that writes cron records.',
  };
}

// ---------------------------------------------------------------------------

function resolveCtxRoot(): string {
  try {
    return resolveEnv().ctxRoot;
  } catch {
    return join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default');
  }
}
