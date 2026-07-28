import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderAdapter,
  ProviderAdapterFactory,
  ProviderAdapterRegistry,
} from '../../../src/providers/adapter.js';
import { ProviderError } from '../../../src/providers/provider-error.js';
import { runProviderSmoke } from '../../../src/providers/smoke-runner.js';
import type { ProviderId, ProviderRequest, ProviderResult } from '../../../src/providers/types.js';

describe('runProviderSmoke', () => {
  it('instantiates and invokes only the one explicitly selected adapter', async () => {
    const openaiExecute = vi.fn().mockResolvedValue(successResult('openai'));
    const anthropicExecute = vi.fn().mockResolvedValue(successResult('anthropic'));
    const openaiFactory = vi.fn<ProviderAdapterFactory>(
      () => adapter('openai', openaiExecute),
    );
    const anthropicFactory = vi.fn<ProviderAdapterFactory>(
      () => adapter('anthropic', anthropicExecute),
    );
    const registry: ProviderAdapterRegistry = {
      get: vi.fn((provider) => (
        provider === 'openai' ? openaiFactory : anthropicFactory
      )),
    };

    const result = await runProviderSmoke(
      {
        provider: 'openai',
        model: 'gpt-test',
        prompt: 'smoke',
      },
      {
        registry,
        createTaskId: () => 'task-smoke',
      },
    );

    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(registry.get).toHaveBeenCalledWith('openai');
    expect(openaiFactory).toHaveBeenCalledTimes(1);
    expect(openaiExecute).toHaveBeenCalledTimes(1);
    expect(anthropicFactory).not.toHaveBeenCalled();
    expect(anthropicExecute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: 'openai',
      model: 'openai-model',
      success: true,
      latencyMs: 12,
      responseText: 'openai-response',
    });
  });

  it('does not fall back or perform a second lookup after an adapter error', async () => {
    const execute = vi.fn().mockRejectedValue(new ProviderError({
      category: 'rate_limit',
      code: 'TEST_RATE_LIMIT',
      message: 'rate limited',
      provider: 'openai',
      retryable: true,
      safeToReplay: true,
    }));
    const selectedFactory = vi.fn<ProviderAdapterFactory>(() => adapter('openai', execute));
    const unselectedFactory = vi.fn<ProviderAdapterFactory>(
      () => adapter('anthropic', vi.fn()),
    );
    const registry: ProviderAdapterRegistry = {
      get: vi.fn((provider) => (
        provider === 'openai' ? selectedFactory : unselectedFactory
      )),
    };
    const ticks = [10, 25];

    const result = await runProviderSmoke(
      { provider: 'openai', model: 'gpt-test', prompt: 'smoke' },
      {
        registry,
        monotonicNow: () => ticks.shift() ?? 25,
      },
    );

    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(selectedFactory).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(unselectedFactory).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      success: false,
      latencyMs: 15,
      error: {
        category: 'rate_limit',
        code: 'TEST_RATE_LIMIT',
      },
    });
  });

  it('returns a structured unavailable-adapter error without invoking Claude', async () => {
    const registry: ProviderAdapterRegistry = {
      get: vi.fn().mockReturnValue(undefined),
    };

    const result = await runProviderSmoke(
      { provider: 'anthropic', model: 'claude-test', prompt: 'smoke' },
      { registry },
    );

    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test',
      success: false,
      error: {
        category: 'configuration',
        code: 'PROVIDER_ADAPTER_UNAVAILABLE',
      },
    });
  });

  it('rejects a missing model before looking up or invoking an adapter', async () => {
    const registry: ProviderAdapterRegistry = {
      get: vi.fn(),
    };

    const result = await runProviderSmoke(
      { provider: 'openai', model: '', prompt: 'smoke' },
      { registry },
    );

    expect(registry.get).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: 'openai',
      success: false,
      error: {
        category: 'configuration',
        code: 'MISSING_MODEL',
      },
    });
  });
});

function adapter(
  provider: ProviderId,
  execute: (request: ProviderRequest) => Promise<ProviderResult>,
): ProviderAdapter {
  return { provider, execute };
}

function successResult(provider: ProviderId): ProviderResult {
  return {
    taskId: 'task-smoke',
    provider,
    model: `${provider}-model`,
    output: `${provider}-response`,
    usage: {
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
    },
    latency: {
      startedAt: '2026-07-28T10:00:00.000Z',
      completedAt: '2026-07-28T10:00:00.012Z',
      totalMs: 12,
    },
  };
}
