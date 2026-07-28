import {
  PROVIDER_IDS,
  type FallbackPolicy,
  type GlobalProviderConfiguration,
  type ProviderErrorCategory,
  type ProviderId,
  type ProviderRetryPolicy,
  type ProviderRetryPolicyOverride,
  type ProviderScopeConfiguration,
  type ProviderTimeout,
  type StructuredProviderError,
} from './types.js';

export const DEFAULT_PROVIDER_ID: ProviderId = 'anthropic';

export const DEFAULT_RETRY_POLICY: Readonly<ProviderRetryPolicy> = Object.freeze({
  maxRetries: 0,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  retryableCategories: [],
});

export const DEFAULT_FALLBACK_POLICY: Readonly<FallbackPolicy> = Object.freeze({
  enabled: false,
  on: [],
  maxAttempts: 0,
  requireSafeReplay: true,
});

const ERROR_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  'configuration',
  'authentication',
  'quota',
  'rate_limit',
  'timeout',
  'provider_unavailable',
  'model_unsupported',
  'tool_error',
  'process_exit',
  'unknown',
]);

type ConfigurationErrorCode =
  | 'UNSUPPORTED_PROVIDER'
  | 'MULTIPLE_PROVIDERS_NOT_ALLOWED'
  | 'MISSING_MODEL'
  | 'INVALID_MODEL'
  | 'INVALID_TIMEOUT'
  | 'INVALID_RETRY_POLICY'
  | 'INVALID_FALLBACK_POLICY';

export class ProviderConfigurationError
  extends Error
  implements StructuredProviderError
{
  readonly name = 'ProviderError' as const;
  readonly category = 'configuration' as const;
  readonly retryable = false;
  readonly fallbackEligible = false;
  readonly safeToReplay = true;

  constructor(
    readonly code: ConfigurationErrorCode,
    message: string,
    readonly provider?: ProviderId,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function parseProviderId(value: unknown, fieldName: string): ProviderId | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    throw new ProviderConfigurationError(
      'MULTIPLE_PROVIDERS_NOT_ALLOWED',
      `${fieldName} must select exactly one provider, not an array`,
    );
  }

  if (typeof value !== 'string' || !PROVIDER_IDS.includes(value as ProviderId)) {
    throw new ProviderConfigurationError(
      'UNSUPPORTED_PROVIDER',
      `${fieldName} must be one of: ${PROVIDER_IDS.join(', ')}`,
    );
  }

  return value as ProviderId;
}

export function validateProviderScope(
  value: ProviderScopeConfiguration | undefined,
  scopeName: 'routine' | 'agent',
): ProviderScopeConfiguration | undefined {
  if (value === undefined) {
    return undefined;
  }

  const provider = parseProviderId(
    (value as { provider?: unknown }).provider,
    `${scopeName}.provider`,
  );

  validateModels(value.models, `${scopeName}.models`);
  validateTimeout(value.timeout, `${scopeName}.timeout`);
  validateRetryOverride(value.retry, `${scopeName}.retry`);
  validateFallbackOverride(value.fallback, `${scopeName}.fallback`);

  return {
    ...value,
    provider,
  };
}

export function validateGlobalProviderConfiguration(
  value: GlobalProviderConfiguration | undefined,
): GlobalProviderConfiguration | undefined {
  if (value === undefined) {
    return undefined;
  }

  const defaultProvider = parseProviderId(
    (value as { defaultProvider?: unknown }).defaultProvider,
    'global.defaultProvider',
  );

  validateModels(value.models, 'global.models');
  validateTimeout(value.timeout, 'global.timeout');
  validateRetryOverride(value.retry, 'global.retry');
  validateFallbackOverride(value.fallback, 'global.fallback');

  return {
    ...value,
    defaultProvider,
  };
}

export function normalizeTimeout(
  ...overrides: Array<ProviderTimeout | undefined>
): ProviderTimeout {
  const taskMs = firstDefined(overrides.map((override) => override?.taskMs));
  return taskMs === undefined ? {} : { taskMs };
}

export function normalizeRetryPolicy(
  globalOverride?: ProviderRetryPolicyOverride,
  agentOverride?: ProviderRetryPolicyOverride,
  routineOverride?: ProviderRetryPolicyOverride,
): ProviderRetryPolicy {
  const merged: ProviderRetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    retryableCategories: [...DEFAULT_RETRY_POLICY.retryableCategories],
  };

  for (const override of [globalOverride, agentOverride, routineOverride]) {
    if (!override) continue;
    if (override.maxRetries !== undefined) merged.maxRetries = override.maxRetries;
    if (override.initialDelayMs !== undefined) {
      merged.initialDelayMs = override.initialDelayMs;
    }
    if (override.maxDelayMs !== undefined) merged.maxDelayMs = override.maxDelayMs;
    if (override.backoffMultiplier !== undefined) {
      merged.backoffMultiplier = override.backoffMultiplier;
    }
    if (override.retryableCategories !== undefined) {
      merged.retryableCategories = [...override.retryableCategories];
    }
  }

  return merged;
}

export function normalizeFallbackPolicy(
  globalOverride?: Partial<FallbackPolicy>,
  agentOverride?: Partial<FallbackPolicy>,
  routineOverride?: Partial<FallbackPolicy>,
): FallbackPolicy {
  const merged: FallbackPolicy = {
    ...DEFAULT_FALLBACK_POLICY,
    on: [...DEFAULT_FALLBACK_POLICY.on],
  };

  for (const override of [globalOverride, agentOverride, routineOverride]) {
    if (!override) continue;
    if (override.enabled !== undefined) merged.enabled = override.enabled;
    if (override.provider !== undefined) merged.provider = override.provider;
    if (override.on !== undefined) merged.on = [...override.on];
    if (override.maxAttempts !== undefined) merged.maxAttempts = override.maxAttempts;
    if (override.requireSafeReplay !== undefined) {
      merged.requireSafeReplay = override.requireSafeReplay;
    }
  }

  if (!merged.enabled) {
    return {
      enabled: false,
      on: [],
      maxAttempts: 0,
      requireSafeReplay: merged.requireSafeReplay,
    };
  }

  if (!merged.provider) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      'Enabled fallback requires exactly one fallback provider',
    );
  }

  if (merged.maxAttempts < 1) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      'Enabled fallback requires maxAttempts of at least 1',
      merged.provider,
    );
  }

  return merged;
}

export function missingModelError(provider: ProviderId): ProviderConfigurationError {
  return new ProviderConfigurationError(
    'MISSING_MODEL',
    `Explicit provider "${provider}" requires an explicit model configuration`,
    provider,
  );
}

function validateModels(
  models: ProviderScopeConfiguration['models'],
  fieldName: string,
): void {
  if (models === undefined) return;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new ProviderConfigurationError(
      'INVALID_MODEL',
      `${fieldName} must be an object keyed by provider ID`,
    );
  }

  for (const [providerKey, config] of Object.entries(models)) {
    const provider = parseProviderId(providerKey, `${fieldName} key`);
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new ProviderConfigurationError(
        'INVALID_MODEL',
        `${fieldName}.${provider} must be a model configuration object`,
        provider,
      );
    }
    if (typeof config.model !== 'string' || config.model.trim() === '') {
      throw new ProviderConfigurationError(
        'INVALID_MODEL',
        `${fieldName}.${provider}.model must be a non-empty string`,
        provider,
      );
    }
  }
}

function validateTimeout(timeout: ProviderTimeout | undefined, fieldName: string): void {
  if (timeout?.taskMs === undefined) return;
  if (!Number.isInteger(timeout.taskMs) || timeout.taskMs <= 0) {
    throw new ProviderConfigurationError(
      'INVALID_TIMEOUT',
      `${fieldName}.taskMs must be a positive integer`,
    );
  }
}

function validateRetryOverride(
  retry: ProviderRetryPolicyOverride | undefined,
  fieldName: string,
): void {
  if (!retry) return;

  for (const [key, value] of [
    ['maxRetries', retry.maxRetries],
    ['initialDelayMs', retry.initialDelayMs],
    ['maxDelayMs', retry.maxDelayMs],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new ProviderConfigurationError(
        'INVALID_RETRY_POLICY',
        `${fieldName}.${key} must be a non-negative integer`,
      );
    }
  }

  if (
    retry.backoffMultiplier !== undefined
    && (!Number.isFinite(retry.backoffMultiplier) || retry.backoffMultiplier < 1)
  ) {
    throw new ProviderConfigurationError(
      'INVALID_RETRY_POLICY',
      `${fieldName}.backoffMultiplier must be at least 1`,
    );
  }

  if (
    retry.retryableCategories !== undefined
    && (!Array.isArray(retry.retryableCategories)
      || retry.retryableCategories.some((category) => !ERROR_CATEGORIES.has(category)))
  ) {
    throw new ProviderConfigurationError(
      'INVALID_RETRY_POLICY',
      `${fieldName}.retryableCategories contains an unsupported error category`,
    );
  }
}

function validateFallbackOverride(
  fallback: Partial<FallbackPolicy> | undefined,
  fieldName: string,
): void {
  if (!fallback) return;

  if (fallback.provider !== undefined) {
    parseProviderId(fallback.provider, `${fieldName}.provider`);
  }
  if (fallback.enabled !== undefined && typeof fallback.enabled !== 'boolean') {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      `${fieldName}.enabled must be a boolean`,
    );
  }
  if (
    fallback.maxAttempts !== undefined
    && (!Number.isInteger(fallback.maxAttempts) || fallback.maxAttempts < 0)
  ) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      `${fieldName}.maxAttempts must be a non-negative integer`,
    );
  }
  if (
    fallback.on !== undefined
    && (!Array.isArray(fallback.on)
      || fallback.on.some((category) => !ERROR_CATEGORIES.has(category)))
  ) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      `${fieldName}.on contains an unsupported error category`,
    );
  }
  if (
    fallback.requireSafeReplay !== undefined
    && typeof fallback.requireSafeReplay !== 'boolean'
  ) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      `${fieldName}.requireSafeReplay must be a boolean`,
    );
  }
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}
