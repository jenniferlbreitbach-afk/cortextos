/**
 * Proves the usage ledger is record-only: it observes injection decisions and
 * can never alter or block one, even when it fails outright.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(4242),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: () => true, getRecent: () => '' }),
  setTelegramHandle: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const mockInjectMessage = vi.fn();
let dedupVerdict = false;
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return dedupVerdict; } },
  KEYS: { ENTER: '\r', DOWN: '\x1b[B', SPACE: ' ' },
}));

const mockRecordAttempt = vi.fn();
vi.mock('../../../src/bus/usage-ledger.js', () => ({
  recordAttempt: (...args: unknown[]) => mockRecordAttempt(...args),
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 0, size: 0 }),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    unlinkSync: vi.fn(),
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
const { WorkerProcess } = await import('../../../src/daemon/worker-process.js');

const ENV = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/proj',
};

async function runningAgent() {
  const agent = new AgentProcess(
    'alice',
    ENV as never,
    { model: 'claude-sonnet-4-6', runtime: 'claude-code' } as never,
    () => {},
  );
  await agent.start();
  return agent;
}

beforeEach(() => {
  vi.clearAllMocks();
  dedupVerdict = false;
  mockRecordAttempt.mockReset();
  mockRecordAttempt.mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// The core guarantee
// ---------------------------------------------------------------------------

describe('a failing ledger cannot block an injection', () => {
  it('still injects and still reports ok when recordAttempt throws', async () => {
    const agent = await runningAgent();
    mockRecordAttempt.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const result = agent.injectMessageDetailed('payload', { source: 'bus', purpose: 'inbox-delivery' });

    expect(result.ok).toBe(true);
    expect(mockInjectMessage).toHaveBeenCalled();
  });

  it('still returns the correct rejection code when recordAttempt throws', async () => {
    const agent = await runningAgent();
    dedupVerdict = true;
    mockRecordAttempt.mockImplementation(() => { throw new Error('ledger down'); });

    const result = agent.injectMessageDetailed('dupe');

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('DEDUPED');
  });

  it('injects before the ledger is consulted', async () => {
    const agent = await runningAgent();
    const order: string[] = [];
    mockInjectMessage.mockImplementation(() => { order.push('inject'); });
    mockRecordAttempt.mockImplementation(() => { order.push('ledger'); });

    agent.injectMessageDetailed('payload');

    expect(order).toEqual(['inject', 'ledger']);
  });

  it('does not let a throwing ledger break the worker inject path', async () => {
    const worker = new WorkerProcess('w1', '/tmp/proj', 'alice', () => {});
    await worker.spawn(ENV as never, 'task prompt', { model: 'claude-sonnet-4-6' });
    mockRecordAttempt.mockImplementation(() => { throw new Error('ledger down'); });

    expect(worker.inject('nudge')).toBe(true);
    expect(mockInjectMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

describe('every decision is recorded exactly once', () => {
  it('records a dispatch with its source and purpose', async () => {
    const agent = await runningAgent();
    mockRecordAttempt.mockClear();

    agent.injectMessageDetailed('hello', {
      source: 'cron',
      purpose: 'cron-fire',
      requestId: 'heartbeat@2026-08-01T00:00:00Z',
    });

    expect(mockRecordAttempt).toHaveBeenCalledTimes(1);
    expect(mockRecordAttempt.mock.calls[0][0]).toMatchObject({
      agent: 'alice',
      actor: 'agent',
      workspace: 'acme',
      runtime: 'claude-code',
      model: 'claude-sonnet-4-6',
      result: 'dispatched',
      rejectionReason: null,
      meta: { source: 'cron', purpose: 'cron-fire' },
    });
  });

  it('records a NOT_RUNNING rejection', () => {
    const agent = new AgentProcess('alice', ENV as never, {} as never, () => {});
    agent.injectMessageDetailed('hello', { source: 'ipc', purpose: 'operator-inject' });

    expect(mockRecordAttempt).toHaveBeenCalledTimes(1);
    expect(mockRecordAttempt.mock.calls[0][0]).toMatchObject({
      result: 'rejected',
      rejectionReason: 'not_running',
    });
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });

  it('records a DEDUPED rejection', async () => {
    const agent = await runningAgent();
    mockRecordAttempt.mockClear();
    dedupVerdict = true;

    agent.injectMessageDetailed('dupe');

    expect(mockRecordAttempt.mock.calls[0][0]).toMatchObject({
      result: 'rejected',
      rejectionReason: 'deduped',
    });
  });

  it('records the boot prompt on spawn, because a spawn is a model turn', async () => {
    await runningAgent();
    const boot = mockRecordAttempt.mock.calls
      .map((c) => c[0] as { meta?: { purpose?: string }; result?: string })
      .find((a) => a.meta?.purpose === 'boot');

    expect(boot).toBeDefined();
    expect(boot!.result).toBe('dispatched');
  });

  it('defaults to unknown attribution for an un-instrumented caller', async () => {
    const agent = await runningAgent();
    mockRecordAttempt.mockClear();

    agent.injectMessage('no meta supplied');

    expect(mockRecordAttempt.mock.calls[0][0]).toMatchObject({ meta: undefined });
  });
});

// ---------------------------------------------------------------------------
// No content leaves the call site as an identifier
// ---------------------------------------------------------------------------

describe('call sites pass identifiers, not content', () => {
  it('never puts payload text into a meta field', async () => {
    const agent = await runningAgent();
    mockRecordAttempt.mockClear();
    const body = 'SECRET-BODY-TEXT-do-not-attribute';

    agent.injectMessageDetailed(`=== TELEGRAM ===\n${body}`, {
      source: 'telegram',
      purpose: 'telegram-message',
      requestId: '12345',
    });

    const call = mockRecordAttempt.mock.calls[0][0] as {
      meta: unknown;
      payload: { payloadBytes: number; messageCount: number | null };
    };

    // Nothing handed to the ledger contains the body — not the meta, and not
    // the payload descriptor. The reduction happens at this call site.
    expect(JSON.stringify(call)).not.toContain(body);
    expect(call.payload.payloadBytes).toBeGreaterThan(0);
    // Schema allowlist: the metadata object can only ever carry these two
    // content-free fields, so no content-derived field can reach the ledger.
    expect(Object.keys(call.payload).sort()).toEqual(['messageCount', 'payloadBytes']);
  });

  it('passes a descriptor, never a string, as the ledger payload', async () => {
    const agent = await runningAgent();
    mockRecordAttempt.mockClear();
    agent.injectMessageDetailed('some content');

    const { payload } = mockRecordAttempt.mock.calls[0][0] as { payload: unknown };
    expect(typeof payload).toBe('object');
    expect(Object.keys(payload as object).sort()).toEqual(['messageCount', 'payloadBytes']);
  });
});
