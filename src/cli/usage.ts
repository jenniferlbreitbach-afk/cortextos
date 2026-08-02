/**
 * usage.ts — `cortextos usage summary`
 *
 * Reads the record-only usage ledger and aggregates it. Pure read: this command
 * never writes a ledger record, never contacts a provider, and never touches an
 * agent.
 *
 * Lives in its own file rather than as a `bus` subcommand so it does not share
 * a source file with unrelated in-flight work.
 */

import { Command } from 'commander';
import {
  RECONCILIATION_DISCLAIMER,
  readLedger,
  reconcileTokens,
  summarize,
  type SummaryDimension,
  type SummaryRow,
} from '../bus/usage-ledger.js';

const DIMENSIONS: SummaryDimension[] = [
  'agent',
  'workspace',
  'source',
  'runtime',
  'model',
  'purpose',
  'result',
];

export const usageCommand = new Command('usage')
  .description('Model-invocation usage ledger (record-only; no provider calls)');

usageCommand
  .command('summary')
  .description('Summarise recorded injection attempts')
  .option(
    '--by <dimension>',
    `Group by one of: ${DIMENSIONS.join(', ')}`,
    'agent',
  )
  .option('--since <YYYY-MM-DD>', 'Start date (inclusive)')
  .option('--until <YYYY-MM-DD>', 'End date (inclusive)')
  .option('--reconcile', 'Attach APPROXIMATE token counts from local session transcripts')
  .option('--json', 'Emit JSON')
  .action((options: {
    by?: string;
    since?: string;
    until?: string;
    reconcile?: boolean;
    json?: boolean;
  }) => {
    const by = (options.by ?? 'agent') as SummaryDimension;
    if (!DIMENSIONS.includes(by)) {
      console.error(`Unknown dimension "${options.by}". Expected one of: ${DIMENSIONS.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const read = readLedger({ since: options.since, until: options.until });
    const rows = summarize(read.entries, by);

    let reconciliation: ReturnType<typeof reconcileTokens> | null = null;
    if (options.reconcile) {
      const agents = [...new Set(read.entries.map((e) => e.agent))];
      reconciliation = reconcileTokens({
        since: options.since,
        until: options.until,
        agents,
      });
      if (by === 'agent') {
        for (const row of rows) {
          const t = reconciliation.byAgent[row.key];
          if (t) {
            row.approx_input_tokens = t.approx_input_tokens;
            row.approx_output_tokens = t.approx_output_tokens;
          }
        }
      }
    }

    if (options.json) {
      console.log(JSON.stringify({
        by,
        since: options.since ?? null,
        until: options.until ?? null,
        rows,
        evidence: {
          entries: read.entries.length,
          unparseableLines: read.unparseable,
          unreadableFiles: read.unreadableFiles,
          missingDays: read.missingDays,
        },
        ...(reconciliation
          ? {
            reconciliation: {
              disclaimer: RECONCILIATION_DISCLAIMER,
              filesRead: reconciliation.filesRead,
              noEvidence: reconciliation.noEvidence,
            },
          }
          : {}),
      }, null, 2));
      return;
    }

    console.log(`Usage ledger summary by ${by}`);
    const range = options.since || options.until
      ? `${options.since ?? '(start)'} → ${options.until ?? '(end)'}`
      : 'all recorded days';
    console.log(`  range: ${range}`);
    console.log(`  records: ${read.entries.length}`);
    if (read.unparseable > 0) console.log(`  unparseable lines: ${read.unparseable}`);
    if (read.unreadableFiles.length > 0) {
      console.log(`  unreadable day files: ${read.unreadableFiles.join(', ')}`);
    }
    if (read.missingDays.length > 0) {
      console.log(`  days with no ledger file: ${read.missingDays.length} (no evidence, not zero activity)`);
    }
    console.log('');

    if (rows.length === 0) {
      console.log('  (no records)');
      return;
    }

    console.log(renderTable(rows, Boolean(reconciliation) && by === 'agent'));

    if (reconciliation) {
      console.log('');
      console.log(`  ${RECONCILIATION_DISCLAIMER}`);
      if (reconciliation.noEvidence) {
        console.log('  No session transcripts matched — token columns are absent, not zero.');
      }
    }
  });

export function renderTable(rows: SummaryRow[], withTokens: boolean): string {
  const head = withTokens
    ? ['key', 'attempts', 'dispatched', 'rejected', 'bytes', '~in_tok', '~out_tok']
    : ['key', 'attempts', 'dispatched', 'rejected', 'bytes'];

  const body = rows.map((r) => {
    const base = [
      r.key,
      String(r.attempts),
      String(r.dispatched),
      String(r.rejected),
      String(r.payload_bytes),
    ];
    if (withTokens) {
      base.push(
        r.approx_input_tokens === undefined ? '-' : String(r.approx_input_tokens),
        r.approx_output_tokens === undefined ? '-' : String(r.approx_output_tokens),
      );
    }
    return base;
  });

  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)));

  const line = (cells: string[]): string =>
    '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}
