import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FALLBACK_POLICY,
  ProviderConfigurationError,
  resolveProviderConfiguration,
  type ProviderResolutionInput,
} from '../../../src/providers/index.js';

describe('provider resolution', () => {
  it('uses routine, agent, global, then legacy precedence', () => {
    const resolved = resolveProviderConfiguration({
      routine: {
        provider: 'openai',
        models: { openai: { model: 'routine-openai' } },
      },
      agent: {
        provider: 'anthropic',
        models: { anthropic: { model: 'agent-anthropic' } },
      },
      global: {
        defaultProvider: 'openai',
        models: { openai: { model: 'global-openai' } },
      },
      legacyModel: 'legacy-anthropic',
    });

    expect(resolved).toMatchObject({
      provider: 'openai',
      model: 'routine-openai',
      selectionSource: 'routine',
      modelSource: 'routine',
    });
  });

  it('uses the agent override when no routine override exists', () => {
    const resolved = resolveProviderConfiguration({
      agent: {
        provider: 'anthropic',
        models: { anthropic: { model: 'agent-anthropic' } },
      },
      global: {
        defaultProvider: 'openai',
        models: { openai: { model: 'global-openai' } },
      },
    });

    expect(resolved).toMatchObject({
      provider: 'anthropic',
      model: 'agent-anthropic',
      selectionSource: 'agent',
    });
  });

  it('uses the global default when no narrower override exists', () => {
    const resolved = resolveProviderConfiguration({
      global: {
        defaultProvider: 'openai',
        models: { openai: { model: 'global-openai' } },
      },
    });

    expect(resolved).toMatchObject({
      provider: 'openai',
      model: 'global-openai',
      selectionSource: 'global',
    });
  });

  it('preserves legacy Anthropic behavior and treats legacy model as Anthropic-only', () => {
    const resolved = resolveProviderConfiguration({
      legacyModel: 'claude-sonnet-4-6',
    });

    expect(resolved).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      selectionSource: 'legacy',
      modelSource: 'legacy',
      usesProviderDefaultModel: false,
    });
  });

  it('allows legacy Claude configuration to retain the Claude CLI default model', () => {
    const resolved = resolveProviderConfiguration({});

    expect(resolved).toMatchObject({
      provider: 'anthropic',
      selectionSource: 'legacy',
      usesProviderDefaultModel: true,
    });
    expect(resolved.model).toBeUndefined();
  });

  it('rejects an unsupported provider', () => {
    const input = {
      agent: {
        provider: 'unsupported',
      },
    } as unknown as ProviderResolutionInput;

    expect(() => resolveProviderConfiguration(input)).toThrowError(
      expect.objectContaining({
        name: 'ProviderError',
        category: 'configuration',
        code: 'UNSUPPORTED_PROVIDER',
      }),
    );
  });

  it('requires a model for explicit provider selection', () => {
    expect(() =>
      resolveProviderConfiguration({
        agent: { provider: 'openai' },
        legacyModel: 'claude-sonnet-4-6',
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'ProviderError',
        category: 'configuration',
        code: 'MISSING_MODEL',
        provider: 'openai',
      }),
    );
  });

  it('disables fallback by default', () => {
    const resolved = resolveProviderConfiguration({
      legacyModel: 'claude-sonnet-4-6',
    });

    expect(resolved.fallback).toEqual(DEFAULT_FALLBACK_POLICY);
    expect(resolved.fallback.enabled).toBe(false);
  });

  it('rejects simultaneous provider selection', () => {
    const input = {
      routine: {
        provider: ['anthropic', 'openai'],
      },
    } as unknown as ProviderResolutionInput;

    expect(() => resolveProviderConfiguration(input)).toThrowError(
      expect.objectContaining({
        name: 'ProviderError',
        category: 'configuration',
        code: 'MULTIPLE_PROVIDERS_NOT_ALLOWED',
      }),
    );
  });

  it('returns exactly one selected provider for a task', () => {
    const resolved = resolveProviderConfiguration({
      routine: {
        provider: 'openai',
        models: { openai: { model: 'openai-test' } },
      },
      agent: {
        provider: 'anthropic',
        models: { anthropic: { model: 'anthropic-test' } },
      },
    });

    expect(resolved.provider).toBe('openai');
    expect(Array.isArray(resolved.provider)).toBe(false);
    expect(Object.keys(resolved).filter((key) => key === 'provider')).toHaveLength(1);
  });

  it('isolates a routine override to the task that supplies it', () => {
    const sharedAgent = {
      provider: 'anthropic' as const,
      models: { anthropic: { model: 'agent-anthropic' } },
    };

    const routineTask = resolveProviderConfiguration({
      agent: sharedAgent,
      routine: {
        provider: 'openai',
        models: { openai: { model: 'routine-openai' } },
      },
    });
    const nextTask = resolveProviderConfiguration({ agent: sharedAgent });

    expect(routineTask.provider).toBe('openai');
    expect(nextTask.provider).toBe('anthropic');
    expect(sharedAgent.provider).toBe('anthropic');
  });

  it('isolates an agent override from other agents using the same global config', () => {
    const global = {
      defaultProvider: 'anthropic' as const,
      models: { anthropic: { model: 'global-anthropic' } },
    };

    const openaiAgent = resolveProviderConfiguration({
      global,
      agent: {
        provider: 'openai',
        models: { openai: { model: 'agent-openai' } },
      },
    });
    const defaultAgent = resolveProviderConfiguration({ global });

    expect(openaiAgent.provider).toBe('openai');
    expect(defaultAgent.provider).toBe('anthropic');
    expect(global.defaultProvider).toBe('anthropic');
  });

  it('uses structured configuration errors', () => {
    try {
      resolveProviderConfiguration({
        global: { defaultProvider: 'openai' },
      });
      throw new Error('expected provider resolution to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigurationError);
      expect(error).toMatchObject({
        name: 'ProviderError',
        category: 'configuration',
        retryable: false,
        fallbackEligible: false,
        safeToReplay: true,
      });
    }
  });
});
