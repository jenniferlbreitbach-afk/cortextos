import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FALLBACK_POLICY,
  DEFAULT_RETRY_POLICY,
  MAX_PROVIDER_BACKOFF_MULTIPLIER,
  MAX_PROVIDER_FALLBACK_ATTEMPTS,
  MAX_PROVIDER_RETRIES,
  MAX_PROVIDER_RETRY_DELAY_MS,
  MAX_PROVIDER_TASK_TIMEOUT_MS,
  ProviderConfigurationError,
  resolveProviderConfiguration,
  type ConfigurationErrorCode,
  type ProviderErrorCategory,
} from '../../../src/providers/index.js';

function expectConfigurationError(
  action: () => unknown,
  code: ConfigurationErrorCode,
  expected: Record<string, unknown> = {},
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ProviderConfigurationError);
  expect(thrown).toMatchObject({
    name: 'ProviderError',
    category: 'configuration',
    code,
    retryable: false,
    fallbackEligible: false,
    safeToReplay: true,
    ...expected,
  });
}

describe('provider resolution', () => {
  describe('Phase 1 selection behavior', () => {
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

    it('preserves legacy Anthropic behavior', () => {
      const resolved = resolveProviderConfiguration({
        legacyModel: ' claude-sonnet-4-6 ',
      });

      expect(resolved).toMatchObject({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        selectionSource: 'legacy',
        modelSource: 'legacy',
        usesProviderDefaultModel: false,
      });
    });

    it('allows the legacy Claude CLI default model when no model is configured', () => {
      const resolved = resolveProviderConfiguration({});

      expect(resolved).toMatchObject({
        provider: 'anthropic',
        selectionSource: 'legacy',
        usesProviderDefaultModel: true,
      });
      expect(resolved.model).toBeUndefined();
    });

    it('allows explicit Anthropic selection to use the legacy model', () => {
      const resolved = resolveProviderConfiguration({
        agent: { provider: 'anthropic' },
        legacyModel: ' claude-sonnet-4-6 ',
      });

      expect(resolved).toMatchObject({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        selectionSource: 'agent',
        modelSource: 'legacy',
        usesProviderDefaultModel: false,
      });
    });

    it('does not apply the legacy Anthropic model to OpenAI', () => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            agent: { provider: 'openai' },
            legacyModel: 'claude-sonnet-4-6',
          }),
        'MISSING_MODEL',
        { provider: 'openai' },
      );
    });

    it('rejects unsupported and simultaneous provider selection', () => {
      expectConfigurationError(
        () => resolveProviderConfiguration({ agent: { provider: 'unsupported' } }),
        'UNSUPPORTED_PROVIDER',
      );
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: { provider: ['anthropic', 'openai'] },
          }),
        'MULTIPLE_PROVIDERS_NOT_ALLOWED',
      );
    });

    it('isolates routine and agent overrides without mutating inputs', () => {
      const global = {
        defaultProvider: 'anthropic' as const,
        models: { anthropic: { model: 'global-anthropic' } },
      };
      const agent = {
        provider: 'anthropic' as const,
        models: { anthropic: { model: 'agent-anthropic' } },
      };

      const routineTask = resolveProviderConfiguration({
        global,
        agent,
        routine: {
          provider: 'openai',
          models: { openai: { model: 'routine-openai' } },
        },
      });
      const agentTask = resolveProviderConfiguration({ global, agent });
      const globalTask = resolveProviderConfiguration({ global });

      expect(routineTask.provider).toBe('openai');
      expect(agentTask.provider).toBe('anthropic');
      expect(globalTask.provider).toBe('anthropic');
      expect(agent.provider).toBe('anthropic');
      expect(global.defaultProvider).toBe('anthropic');
    });
  });

  describe('untyped configuration validation', () => {
    it.each([null, [], 'configuration', 42, true, new Date()])(
      'rejects malformed root input %#',
      (value) => {
        expectConfigurationError(
          () => resolveProviderConfiguration(value),
          'INVALID_CONFIGURATION',
        );
      },
    );

    it.each(['routine', 'agent', 'global'] as const)(
      'rejects malformed %s scope values',
      (scope) => {
        for (const value of [null, [], 'scope', 42, true, new Date()]) {
          expectConfigurationError(
            () =>
              resolveProviderConfiguration({
                [scope]: value,
                legacyModel: 'claude-sonnet-4-6',
              }),
            'INVALID_CONFIGURATION',
          );
        }
      },
    );

    it('always returns structured configuration errors', () => {
      expectConfigurationError(
        () => resolveProviderConfiguration({ global: { defaultProvider: 'openai' } }),
        'MISSING_MODEL',
        { provider: 'openai' },
      );
    });
  });

  describe('model validation and normalization', () => {
    it('trims configured model values before returning them', () => {
      const resolved = resolveProviderConfiguration({
        routine: {
          provider: 'openai',
          models: { openai: { model: ' gpt-phase-1 ' } },
        },
      });

      expect(resolved.model).toBe('gpt-phase-1');
    });

    it.each(['', ' ', '\t\r\n'])('rejects blank configured model %j', (model) => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: {
              provider: 'openai',
              models: { openai: { model } },
            },
          }),
        'INVALID_MODEL',
        { provider: 'openai' },
      );
    });

    it.each(['', ' ', '\t\r\n'])('rejects blank legacy model %j', (legacyModel) => {
      expectConfigurationError(
        () => resolveProviderConfiguration({ legacyModel }),
        'INVALID_MODEL',
      );
    });

    it.each([null, [], 'models', 42, true])(
      'rejects malformed model map %#',
      (models) => {
        expectConfigurationError(
          () =>
            resolveProviderConfiguration({
              routine: { provider: 'openai', models },
            }),
          'INVALID_MODEL',
        );
      },
    );

    it.each([
      null,
      [],
      'model',
      42,
      {},
      { model: null },
      { model: 42 },
    ])('rejects malformed provider model configuration %#', (modelConfiguration) => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: {
              provider: 'openai',
              models: { openai: modelConfiguration },
            },
          }),
        'INVALID_MODEL',
        { provider: 'openai' },
      );
    });

    it('rejects unsupported model-map provider keys', () => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: {
              provider: 'openai',
              models: { unsupported: { model: 'model' } },
            },
          }),
        'UNSUPPORTED_PROVIDER',
      );
    });
  });

  describe('timeout policy', () => {
    it('uses routine, agent, then global timeout precedence', () => {
      const resolved = resolveProviderConfiguration({
        routine: { timeout: { taskMs: 1_000 } },
        agent: { timeout: { taskMs: 2_000 } },
        global: { timeout: { taskMs: 3_000 } },
        legacyModel: 'claude-sonnet-4-6',
      });

      expect(resolved.timeout).toEqual({ taskMs: 1_000 });
    });

    it.each([
      null,
      [],
      'timeout',
      42,
      true,
      { taskMs: 0 },
      { taskMs: -1 },
      { taskMs: 1.5 },
      { taskMs: Number.NaN },
      { taskMs: Number.POSITIVE_INFINITY },
      { taskMs: MAX_PROVIDER_TASK_TIMEOUT_MS + 1 },
    ])('rejects malformed timeout %#', (timeout) => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: { timeout },
            legacyModel: 'claude-sonnet-4-6',
          }),
        'INVALID_TIMEOUT',
      );
    });
  });

  describe('retry policy', () => {
    it('uses isolated default retry values', () => {
      const resolved = resolveProviderConfiguration({
        legacyModel: 'claude-sonnet-4-6',
      });

      expect(resolved.retry).toEqual(DEFAULT_RETRY_POLICY);
      expect(resolved.retry).not.toBe(DEFAULT_RETRY_POLICY);
      expect(resolved.retry.retryableCategories).not.toBe(
        DEFAULT_RETRY_POLICY.retryableCategories,
      );
    });

    it('merges global, agent, and routine retry overrides', () => {
      const resolved = resolveProviderConfiguration({
        global: {
          retry: {
            maxRetries: 1,
            initialDelayMs: 100,
            maxDelayMs: 2_000,
            retryableCategories: ['timeout'],
          },
        },
        agent: {
          retry: {
            maxRetries: 2,
            backoffMultiplier: 3,
          },
        },
        routine: {
          retry: {
            maxDelayMs: 4_000,
            retryableCategories: ['rate_limit', 'provider_unavailable'],
          },
        },
        legacyModel: 'claude-sonnet-4-6',
      });

      expect(resolved.retry).toEqual({
        maxRetries: 2,
        initialDelayMs: 100,
        maxDelayMs: 4_000,
        backoffMultiplier: 3,
        retryableCategories: ['rate_limit', 'provider_unavailable'],
      });
    });

    it.each([null, [], 'retry', 42, true])(
      'rejects malformed retry object %#',
      (retry) => {
        expectConfigurationError(
          () =>
            resolveProviderConfiguration({
              routine: { retry },
              legacyModel: 'claude-sonnet-4-6',
            }),
          'INVALID_RETRY_POLICY',
        );
      },
    );

    it.each([
      { maxRetries: -1 },
      { maxRetries: 1.5 },
      { maxRetries: Number.POSITIVE_INFINITY },
      { maxRetries: MAX_PROVIDER_RETRIES + 1 },
      { initialDelayMs: -1 },
      { initialDelayMs: 1.5 },
      { initialDelayMs: MAX_PROVIDER_RETRY_DELAY_MS + 1 },
      { maxDelayMs: Number.NaN },
      { maxDelayMs: MAX_PROVIDER_RETRY_DELAY_MS + 1 },
      { backoffMultiplier: 1.5 },
      { backoffMultiplier: MAX_PROVIDER_BACKOFF_MULTIPLIER + 1 },
    ])('rejects invalid retry numeric values %#', (retry) => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: { retry },
            legacyModel: 'claude-sonnet-4-6',
          }),
        'INVALID_RETRY_POLICY',
      );
    });

    it('rejects invalid retry categories', () => {
      for (const retryableCategories of ['timeout', [42], ['unsupported']]) {
        expectConfigurationError(
          () =>
            resolveProviderConfiguration({
              routine: { retry: { retryableCategories } },
              legacyModel: 'claude-sonnet-4-6',
            }),
          'INVALID_RETRY_POLICY',
        );
      }
    });

    it('rejects delay inconsistency within one scope or after merging', () => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: { retry: { initialDelayMs: 2_000, maxDelayMs: 1_000 } },
            legacyModel: 'claude-sonnet-4-6',
          }),
        'INVALID_RETRY_POLICY',
      );
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            global: { retry: { initialDelayMs: 2_000 } },
            routine: { retry: { maxDelayMs: 1_000 } },
            legacyModel: 'claude-sonnet-4-6',
          }),
        'INVALID_RETRY_POLICY',
      );
    });
  });

  describe('fallback policy', () => {
    it('disables fallback by default with isolated category arrays', () => {
      const resolved = resolveProviderConfiguration({
        legacyModel: 'claude-sonnet-4-6',
      });

      expect(resolved.fallback).toEqual(DEFAULT_FALLBACK_POLICY);
      expect(resolved.fallback).not.toBe(DEFAULT_FALLBACK_POLICY);
      expect(resolved.fallback.on).not.toBe(DEFAULT_FALLBACK_POLICY.on);
    });

    it('resolves an enabled fallback provider and model', () => {
      const resolved = resolveProviderConfiguration({
        routine: {
          provider: 'anthropic',
          models: {
            anthropic: { model: 'primary-anthropic' },
            openai: { model: ' fallback-openai ' },
          },
          fallback: {
            enabled: true,
            provider: 'openai',
            on: ['timeout', 'provider_unavailable'],
            maxAttempts: 1,
          },
        },
      });

      expect(resolved.fallback).toEqual({
        enabled: true,
        provider: 'openai',
        model: 'fallback-openai',
        modelSource: 'routine',
        on: ['timeout', 'provider_unavailable'],
        maxAttempts: 1,
        requireSafeReplay: true,
      });
    });

    it('resolves an Anthropic fallback from the legacy model', () => {
      const resolved = resolveProviderConfiguration({
        routine: {
          provider: 'openai',
          models: { openai: { model: 'primary-openai' } },
          fallback: {
            enabled: true,
            provider: 'anthropic',
            on: ['timeout'],
            maxAttempts: 1,
          },
        },
        legacyModel: ' legacy-anthropic ',
      });

      expect(resolved.fallback).toMatchObject({
        provider: 'anthropic',
        model: 'legacy-anthropic',
        modelSource: 'legacy',
      });
    });

    it('merges fallback overrides by scope', () => {
      const resolved = resolveProviderConfiguration({
        global: {
          models: { openai: { model: 'fallback-openai' } },
          fallback: {
            enabled: true,
            provider: 'openai',
            on: ['timeout'],
            maxAttempts: 1,
          },
        },
        routine: {
          fallback: {
            requireSafeReplay: false,
          },
        },
        legacyModel: 'primary-anthropic',
      });

      expect(resolved.fallback).toMatchObject({
        enabled: true,
        provider: 'openai',
        model: 'fallback-openai',
        requireSafeReplay: false,
      });
    });

    it('rejects fallback to the selected primary provider', () => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: {
              provider: 'openai',
              models: { openai: { model: 'primary-openai' } },
              fallback: {
                enabled: true,
                provider: 'openai',
                on: ['timeout'],
                maxAttempts: 1,
              },
            },
          }),
        'INVALID_FALLBACK_POLICY',
        { provider: 'openai' },
      );
    });

    it('rejects enabled fallback with no trigger category', () => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: {
              fallback: {
                enabled: true,
                provider: 'openai',
                on: [],
                maxAttempts: 1,
              },
              models: { openai: { model: 'fallback-openai' } },
            },
            legacyModel: 'primary-anthropic',
          }),
        'INVALID_FALLBACK_POLICY',
        { provider: 'openai' },
      );
    });

    it('rejects enabled fallback without a resolvable model', () => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: {
              fallback: {
                enabled: true,
                provider: 'openai',
                on: ['timeout'],
                maxAttempts: 1,
              },
            },
            legacyModel: 'primary-anthropic',
          }),
        'MISSING_FALLBACK_MODEL',
        { provider: 'openai' },
      );
    });

    it.each([null, [], 'fallback', 42, true])(
      'rejects malformed fallback objects %#',
      (fallback) => {
        expectConfigurationError(
          () =>
            resolveProviderConfiguration({
              routine: { fallback },
              legacyModel: 'primary-anthropic',
            }),
          'INVALID_FALLBACK_POLICY',
        );
      },
    );

    it.each([
      { enabled: 'yes' },
      { requireSafeReplay: 'yes' },
      { maxAttempts: -1 },
      { maxAttempts: 1.5 },
      { maxAttempts: Number.POSITIVE_INFINITY },
      { maxAttempts: MAX_PROVIDER_FALLBACK_ATTEMPTS + 1 },
      { on: 'timeout' },
      { on: [42] },
      { on: ['unsupported'] },
    ])('rejects invalid fallback combinations %#', (fallback) => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: { fallback },
            legacyModel: 'primary-anthropic',
          }),
        'INVALID_FALLBACK_POLICY',
      );
    });

    it('rejects enabled fallback with zero attempts', () => {
      expectConfigurationError(
        () =>
          resolveProviderConfiguration({
            routine: {
              fallback: {
                enabled: true,
                provider: 'openai',
                on: ['timeout'],
                maxAttempts: 0,
              },
              models: { openai: { model: 'fallback-openai' } },
            },
            legacyModel: 'primary-anthropic',
          }),
        'INVALID_FALLBACK_POLICY',
        { provider: 'openai' },
      );
    });
  });

  describe('immutability', () => {
    it('deep-freezes exported defaults', () => {
      expect(Object.isFrozen(DEFAULT_RETRY_POLICY)).toBe(true);
      expect(Object.isFrozen(DEFAULT_RETRY_POLICY.retryableCategories)).toBe(true);
      expect(Object.isFrozen(DEFAULT_FALLBACK_POLICY)).toBe(true);
      expect(Object.isFrozen(DEFAULT_FALLBACK_POLICY.on)).toBe(true);

      expect(() =>
        (DEFAULT_RETRY_POLICY.retryableCategories as ProviderErrorCategory[]).push(
          'timeout',
        )).toThrow();
      expect(() =>
        (DEFAULT_FALLBACK_POLICY.on as ProviderErrorCategory[]).push('timeout'))
        .toThrow();
    });

    it('does not share returned category arrays with defaults or other resolutions', () => {
      const first = resolveProviderConfiguration({
        legacyModel: 'claude-sonnet-4-6',
      });
      const second = resolveProviderConfiguration({
        legacyModel: 'claude-sonnet-4-6',
      });

      (first.retry.retryableCategories as ProviderErrorCategory[]).push('timeout');
      (first.fallback.on as ProviderErrorCategory[]).push('quota');

      expect(second.retry.retryableCategories).toEqual([]);
      expect(second.fallback.on).toEqual([]);
      expect(DEFAULT_RETRY_POLICY.retryableCategories).toEqual([]);
      expect(DEFAULT_FALLBACK_POLICY.on).toEqual([]);
    });

    it('clones configured category arrays', () => {
      const retryableCategories: ProviderErrorCategory[] = ['timeout'];
      const fallbackCategories: ProviderErrorCategory[] = ['provider_unavailable'];
      const resolved = resolveProviderConfiguration({
        routine: {
          provider: 'anthropic',
          models: {
            anthropic: { model: 'primary-anthropic' },
            openai: { model: 'fallback-openai' },
          },
          retry: {
            maxRetries: 1,
            retryableCategories,
          },
          fallback: {
            enabled: true,
            provider: 'openai',
            on: fallbackCategories,
            maxAttempts: 1,
          },
        },
      });

      retryableCategories.push('rate_limit');
      fallbackCategories.push('timeout');

      expect(resolved.retry.retryableCategories).toEqual(['timeout']);
      expect(resolved.fallback.on).toEqual(['provider_unavailable']);
    });
  });
});
