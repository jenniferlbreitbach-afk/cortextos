/**
 * Mixed-batch attribution.
 *
 * One PTY write is one model turn, so a fast-checker batch produces exactly one
 * ledger record no matter how many messages it combines. When that batch mixes
 * Telegram and inbox messages, attributing it to either single source would
 * hide the other's usage entirely — so it must be recorded as `mixed`, with a
 * `messageCount` covering every message in the batch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths, InboxMessage } from '../../../src/types';

let ctxRoot: string;
let paths: BusPaths;

function createMockAgent(name = 'goose') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
  } as any;
}

/** Write a real inbox message file so checkInbox() picks it up. */
function writeInbox(from: string, text: string, seq: number): string {
  const epochMs = 1754000000000 + seq;
  const id = `${epochMs}-${from}-ab12c`;
  const msg: InboxMessage = {
    id,
    from,
    to: 'goose',
    priority: 'normal',
    timestamp: new Date(epochMs).toISOString(),
    text,
    reply_to: null,
  } as InboxMessage;
  writeFileSync(join(paths.inbox, `2-${epochMs}-from-${from}-ab12c.json`), JSON.stringify(msg));
  return id;
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'mixed-batch-'));
  paths = {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', 'goose'),
    inflight: join(ctxRoot, 'inflight', 'goose'),
    processed: join(ctxRoot, 'processed', 'goose'),
    logDir: join(ctxRoot, 'logs', 'goose'),
    stateDir: join(ctxRoot, 'state', 'goose'),
  } as BusPaths;
  for (const d of [paths.inbox, paths.inflight, paths.processed, paths.logDir, paths.stateDir]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Run exactly one poll cycle and return the meta passed to injectMessage. */
async function pollOnce(agent: any, telegramBodies: string[] = []) {
  const checker = new FastChecker(agent, paths, '/tmp/framework');
  for (const body of telegramBodies) {
    checker.queueTelegramMessage(
      `=== TELEGRAM from [USER: Jennifer] (chat_id:999) ===\n\`\`\`\n${body}\n\`\`\`\n\n`,
    );
  }
  await (checker as any).pollCycle();
  return checker;
}

describe('FastChecker mixed-batch ledger attribution', () => {
  it('produces exactly one record labelled mixed with the full message count', async () => {
    const agent = createMockAgent();
    const busId = writeInbox('forge', 'inbox body one', 1);
    writeInbox('atlas', 'inbox body two', 2);

    await pollOnce(agent, ['telegram body A', 'telegram body B']);

    // One PTY write => one ledger record, regardless of message count.
    expect(agent.injectMessage).toHaveBeenCalledTimes(1);

    const [block, meta] = agent.injectMessage.mock.calls[0];
    expect(meta.source).toBe('mixed');
    expect(meta.purpose).toBe('mixed-delivery');
    // 2 Telegram + 2 inbox.
    expect(meta.messageCount).toBe(4);

    // Safe bus request id: the first inbox message id, plus a count of the rest.
    expect(meta.requestId).toBe(`${busId}+1`);

    // The block carries content; the ledger metadata must not.
    expect(block).toContain('telegram body A');
    expect(JSON.stringify(meta)).not.toContain('telegram body A');
    expect(JSON.stringify(meta)).not.toContain('inbox body one');
  });

  it('labels a Telegram-only batch telegram, with a null request id', async () => {
    const agent = createMockAgent();
    await pollOnce(agent, ['just telegram']);

    const [, meta] = agent.injectMessage.mock.calls[0];
    expect(meta.source).toBe('telegram');
    expect(meta.purpose).toBe('telegram-message');
    expect(meta.messageCount).toBe(1);
    // No safe identifier exists at this layer, so none is manufactured.
    expect(meta.requestId).toBeNull();
  });

  it('labels an inbox-only batch bus, carrying the bus message id', async () => {
    const agent = createMockAgent();
    const busId = writeInbox('forge', 'only inbox', 1);

    await pollOnce(agent);

    const [, meta] = agent.injectMessage.mock.calls[0];
    expect(meta.source).toBe('bus');
    expect(meta.purpose).toBe('inbox-delivery');
    expect(meta.messageCount).toBe(1);
    expect(meta.requestId).toBe(busId);
  });

  it('injects nothing, and records nothing, when there are no messages', async () => {
    const agent = createMockAgent();
    await pollOnce(agent);
    expect(agent.injectMessage).not.toHaveBeenCalled();
  });

  it('request id stays within the ledger allowlist for a mixed batch', async () => {
    const agent = createMockAgent();
    writeInbox('my_agent', 'body', 1);
    writeInbox('forge', 'body', 2);
    await pollOnce(agent, ['tg']);

    const [, meta] = agent.injectMessage.mock.calls[0];
    // Underscore agent names are legal; the id must survive normalization.
    expect(meta.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:@+_-]*$/);
  });
});
