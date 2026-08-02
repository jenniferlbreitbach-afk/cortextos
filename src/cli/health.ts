/**
 * health.ts — `cortextos health`
 *
 * A deterministic, zero-model health report. Safe to run from a scheduled task:
 * it reads files and performs one read-only status IPC. It never injects into a
 * PTY, never starts or wakes an agent, and never contacts a model provider.
 *
 * Exit codes (so a scheduler can alert without waking anything):
 *   0  fleet ok
 *   1  warnings, or state could not be determined
 *   2  failures present
 *
 * `unknown` deliberately exits non-zero. Reporting "no data" as success is the
 * failure mode this command exists to remove.
 */

import { Command } from 'commander';
import { collectHealth, type AgentHealth, type HealthReport, type HealthState } from '../bus/health.js';
import { inventoryHealthCrons, planConversions } from '../bus/health-cron-inventory.js';

export const EXIT_OK = 0;
export const EXIT_WARN = 1;
export const EXIT_FAIL = 2;

export function exitCodeFor(state: HealthState): number {
  if (state === 'fail') return EXIT_FAIL;
  if (state === 'warn' || state === 'unknown') return EXIT_WARN;
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtAge(sec: number | null): string {
  if (sec === null) return 'n/a';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const MARK: Record<HealthState, string> = {
  ok: 'OK  ',
  warn: 'WARN',
  fail: 'FAIL',
  unknown: '????',
};

/**
 * Render the report as text.
 *
 * Every field present in the JSON appears here too — the two outputs are
 * projections of one `HealthReport`, never independently assembled. A test
 * asserts this so the human view can never drift into a rosier story than the
 * machine view.
 */
export function renderHuman(report: HealthReport): string {
  const lines: string[] = [];

  lines.push(`cortextOS health — ${report.generatedAt}`);
  lines.push(`instance: ${report.instanceId}   ctxRoot: ${report.ctxRoot}`);
  lines.push('');

  const d = report.daemon;
  lines.push(
    `[${MARK[d.state]}] daemon  running=${d.running === null ? 'unknown' : d.running}  pid=${d.pid ?? 'n/a'}`,
  );
  for (const n of d.notes) lines.push(`         - ${n}`);
  lines.push('');

  lines.push(
    `[${MARK[report.fleet.state]}] fleet  total=${report.fleet.total} ` +
    `ok=${report.fleet.ok} warn=${report.fleet.warn} fail=${report.fleet.fail} unknown=${report.fleet.unknown}`,
  );
  lines.push('');

  for (const a of report.agents) lines.push(...renderAgent(a));

  return lines.join('\n');
}

function renderAgent(a: AgentHealth): string[] {
  const lines: string[] = [];
  lines.push(
    `[${MARK[a.state]}] ${a.agent}  workspace=${a.workspace ?? 'n/a'}  enabled=${a.enabled ?? 'unknown'}`,
  );
  lines.push(
    `         daemonReported=${a.daemonReported ?? 'n/a'}  pid=${a.pid ?? 'n/a'}  ` +
    `attached=${a.attached === null ? 'unknown' : a.attached}  reachability=${a.reachability}`,
  );
  lines.push(
    `         heartbeat=${fmtAge(a.heartbeatAgeSec)} (${a.heartbeatState})  ` +
    `inbox=${a.inbox.count ?? 'n/a'}/oldest ${fmtAge(a.inbox.oldestAgeSec)}  ` +
    `inflight=${a.inflight.count ?? 'n/a'}/oldest ${fmtAge(a.inflight.oldestAgeSec)}`,
  );
  lines.push(
    `         cronsEnabled=${a.cronsEnabled ?? 'n/a'}  lastCronFire=${fmtAge(a.lastCronFireAgeSec)}  ` +
    `cronScheduler=${a.cronSchedulerState}  crashes24h=${a.recentCrashes24h ?? 'n/a'}`,
  );
  lines.push(
    `         telegramPoller=${a.telegramPoller}  runtimeErrors=${a.runtimeErrorState}  ` +
    `queueDepth=${a.queueDepth ?? 'n/a'}`,
  );
  for (const n of a.notes) lines.push(`         - ${n}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const healthCommand = new Command('health')
  .description('Deterministic fleet health report (no model invocation)')
  .option('--json', 'Emit JSON')
  .option('--instance <id>', 'Instance ID')
  .action(async (options: { json?: boolean; instance?: string }) => {
    const report = await collectHealth({ instanceId: options.instance });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderHuman(report));
    }
    process.exitCode = exitCodeFor(report.fleet.state);
  });

healthCommand
  .command('crons')
  .description('Inventory crons a deterministic health check could replace (read-only)')
  .option('--json', 'Emit JSON')
  .option('--enabled-only', 'Restrict the inventory to currently-enabled crons')
  .option('--dry-run', 'Show the conversion plan (this build never applies changes)')
  .action((options: { json?: boolean; enabledOnly?: boolean; dryRun?: boolean }) => {
    const inventory = inventoryHealthCrons({ enabledOnly: options.enabledOnly });

    if (options.dryRun) {
      const plan = planConversions(inventory);
      if (options.json) {
        console.log(JSON.stringify({ inventory, plan }, null, 2));
        return;
      }
      console.log(`Cron conversion DRY RUN — ${plan.generatedAt}`);
      console.log(`  definitions scanned: ${inventory.totals.definitions}`);
      console.log(`  currently enabled:   ${inventory.totals.enabled}`);
      console.log(`  eligible:            ${inventory.totals.enabledHealthCandidates}`);
      console.log('');
      if (plan.changes.length === 0) {
        console.log('  No changes proposed.');
      } else {
        for (const c of plan.changes) {
          console.log(`  ~ ${c.agent}/${c.cron}`);
          console.log(`      action:      ${c.action}`);
          console.log(`      replacement: ${c.replacement}`);
          console.log(`      rationale:   ${c.rationale}`);
        }
      }
      console.log('');
      console.log(`  ${plan.note}`);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }

    console.log(`Cron inventory — ${inventory.generatedAt}`);
    console.log(
      `  ${inventory.totals.definitions} definition(s), ` +
      `${inventory.totals.enabled} enabled, ` +
      `${inventory.totals.enabledHealthCandidates} eligible for conversion`,
    );
    if (inventory.unreadable.length > 0) {
      console.log(`  UNREADABLE crons.json for: ${inventory.unreadable.join(', ')}`);
    }
    console.log('');
    for (const r of inventory.rows) {
      const flag = r.eligible ? 'ELIGIBLE' : '        ';
      const state = r.enabled ? 'enabled ' : 'disabled';
      console.log(`  ${flag} ${state} ${r.agent}/${r.name}  [${r.schedule}]  ${r.klass}`);
      console.log(`             ${r.rationale}`);
    }
  });
