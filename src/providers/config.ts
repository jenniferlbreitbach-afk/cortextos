import {
  PROVIDER_IDS,
  type FallbackPolicy,
  type FallbackPolicyOverride,
  type GlobalProviderConfiguration,
  type ProviderErrorCategory,
  type ProviderId,
  type ProviderModelMap,
  type ProviderResolutionInput,
  type ProviderRetryPolicy,
  type ProviderRetryPolicyOverride,
  type ProviderScopeConfiguration,
  type ProviderTimeout,
  type StructuredProviderError,
} from './types.js';

export const DEFAULT_PROVIDER_ID: ProviderId = 'anthropic';

export const MAX_PROVIDER_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MAX_PROVIDER_RETRIES = 10;
export const MAX_PROVIDER_RETRY_DELAY_MS = 5 * 60 * 1_000;
export const MAX_PROVIDER_BACKOFF_MULTIPLIER = 10;
export const MAX_PROVIDER_FALLBACK_ATTEMPTS = 3;

const EMPTY_ERROR_CATEGORIES: readonly ProviderErrorCategory[] = Object.freeze(
  [] as ProviderErrorCategory[],
);

export const DEFAULT_RETRY_POLICY: Readonly<ProviderRetryPolicy> = Object.freeze({
  maxRetries: 0,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  retryableCategories: EMPTY_ERROR_CATEGORIES,
});

export const DEFAULT_FALLBACK_POLICY: Readonly<FallbackPolicy> = Object.freeze({
  enabled: false,
  on: EMPTY_ERROR_CATEGORIES,
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

export type ConfigurationErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'UNSUPPORTED_PROVIDER'
  | 'MULTIPLE_PROVIDERS_NOT_ALLOWED'
  | 'MISSING_MODEL'
  | 'MISSING_FALLBACK_MODEL'
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

export function validateProviderResolutionInput(value: unknown): ProviderResolutionInput {
  const record = requirePlainRecord(value, 'provider configuration');

  return {
    routine: validateProviderScope(record.routine, 'routine'),
    agent: validateProviderScope(record.agent, 'agent'),
    global: validateGlobalProviderConfiguration(record.global),
    legacyModel: normalizeModelValue(record.legacyModel, 'legacyModel'),
  };
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
  value: unknown,
  scopeName: 'routine' | 'agent',
): ProviderScopeConfiguration | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requirePlainRecord(value, scopeName);

  return {
    provider: parseProviderId(record.provider, `${scopeName}.provider`),
    models: validateModels(record.models, `${scopeName}.models`),
    timeout: validateTimeout(record.timeout, `${scopeName}.timeout`),
    retry: validateRetryOverride(record.retry, `${scopeName}.retry`),
    fallback: validateFallbackOverride(record.fallback, `${scopeName}.fallback`),
  };
}

export function validateGlobalProviderConfiguration(
  value: unknown,
): GlobalProviderConfiguration | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = requirePlainRecord(value, 'global');

  return {
    defaultProvider: parseProviderId(record.defaultProvider, 'global.defaultProvider'),
    models: validateModels(record.models, 'global.models'),
    timeout: validateTimeout(record.timeout, 'global.timeout'),
    retry: validateRetryOverride(record.retry, 'global.retry'),
    fallback: validateFallbackOverride(record.fallback, 'global.fallback'),
  };
}

export function normalizeTimeout(...overrides: unknown[]): ProviderTimeout {
  const validated = overrides.map((override, index) =>
    validateTimeout(override, `timeout override ${index + 1}`));
  const taskMs = firstDefined(validated.map((override) => override?.taskMs));
  return taskMs === undefined ? {} : { taskMs };
}

export function normalizeRetryPolicy(
  globalOverride?: unknown,
  agentOverride?: unknown,
  routineOverride?: unknown,
): ProviderRetryPolicy {
  const overrides = [
    validateRetryOverride(globalOverride, 'global.retry'),
    validateRetryOverride(agentOverride, 'agent.retry'),
    validateRetryOverride(routineOverride, 'routine.retry'),
  ];
  const merged: ProviderRetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    retryableCategories: [...DEFAULT_RETRY_POLICY.retryableCategories],
  };

  for (const override of overrides) {
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

  if (merged.maxDelayMs < merged.initialDelayMs) {
    throw new ProviderConfigurationError(
      'INVALID_RETRY_POLICY',
      'retry.maxDelayMs must be greater than or equal to retry.initialDelayMs',
    );
  }

  return merged;
}

export function normalizeFallbackPolicy(
  globalOverride?: unknown,
  agentOverride?: unknown,
  routineOverride?: unknown,
): FallbackPolicy {
  const overrides = [
    validateFallbackOverride(globalOverride, 'global.fallback'),
    validateFallbackOverride(agentOverride, 'agent.fallback'),
    validateFallbackOverride(routineOverride, 'routine.fallback'),
  ];
  const merged: FallbackPolicy = {
    ...DEFAULT_FALLBACK_POLICY,
    on: [...DEFAULT_FALLBACK_POLICY.on],
  };

  for (const override of overrides) {
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

  if (merged.on.length === 0) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      'Enabled fallback requires at least one trigger category',
      merged.provider,
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

export function missingFallbackModelError(
  provider: ProviderId,
): ProviderConfigurationError {
  return new ProviderConfigurationError(
    'MISSING_FALLBACK_MODEL',
    `Fallback provider "${provider}" requires an explicit model configuration`,
    provider,
  );
}

function validateModels(value: unknown, fieldName: string): ProviderModelMap | undefined {
  if (value === undefined) return undefined;
  const models = requirePlainRecord(value, fieldName, 'INVALID_MODEL');
  const validated: ProviderModelMap = {};

  for (const [providerKey, configValue] of Object.entries(models)) {
    const provider = parseProviderId(providerKey, `${fieldName} key`);
    if (provider === undefined) {
      throw new ProviderConfigurationError(
        'UNSUPPORTED_PROVIDER',
        `${fieldName} contains an undefined provider key`,
      );
    }
    const config = requirePlainRecord(
      configValue,
      `${fieldName}.${provider}`,
      'INVALID_MODEL',
      provider,
    );
    const model = normalizeModelValue(
      config.model,
      `${fieldName}.${provider}.model`,
      provider,
    );
    if (model === undefined) {
      throw new ProviderConfigurationError(
        'INVALID_MODEL',
        `${fieldName}.${provider}.model is required`,
        provider,
      );
    }
    validated[provider] = { model };
  }

  return validated;
}

function validateTimeout(value: unknown, fieldName: string): ProviderTimeout | undefined {
  if (value === undefined) return undefined;
  const timeout = requirePlainRecord(value, fieldName, 'INVALID_TIMEOUT');
  if (timeout.taskMs === undefined) return {};

  return {
    taskMs: validateBoundedInteger(
      timeout.taskMs,
      `${fieldName}.taskMs`,
      1,
      MAX_PROVIDER_TASK_TIMEOUT_MS,
      'INVALID_TIMEOUT',
    ),
  };
}

function validateRetryOverride(
  value: unknown,
  fieldName: string,
): ProviderRetryPolicyOverride | undefined {
  if (value === undefined) return undefined;
  const retry = requirePlainRecord(value, fieldName, 'INVALID_RETRY_POLICY');
  const validated: ProviderRetryPolicyOverride = {};

  if (retry.maxRetries !== undefined) {
    validated.maxRetries = validateBoundedInteger(
      retry.maxRetries,
      `${fieldName}.maxRetries`,
      0,
      MAX_PROVIDER_RETRIES,
      'INVALID_RETRY_POLICY',
    );
  }
  if (retry.initialDelayMs !== undefined) {
    validated.initialDelayMs = validateBoundedInteger(
      retry.initialDelayMs,
      `${fieldName}.initialDelayMs`,
      0,
      MAX_PROVIDER_RETRY_DELAY_MS,
      'INVALID_RETRY_POLICY',
    );
  }
  if (retry.maxDelayMs !== undefined) {
    validated.maxDelayMs = validateBoundedInteger(
      retry.maxDelayMs,
      `${fieldName}.maxDelayMs`,
      0,
      MAX_PROVIDER_RETRY_DELAY_MS,
      'INVALID_RETRY_POLICY',
    );
  }
  if (retry.backoffMultiplier !== undefined) {
    validated.backoffMultiplier = validateBoundedInteger(
      retry.backoffMultiplier,
      `${fieldName}.backoffMultiplier`,
      1,
      MAX_PROVIDER_BACKOFF_MULTIPLIER,
      'INVALID_RETRY_POLICY',
    );
  }
  if (retry.retryableCategories !== undefined) {
    validated.retryableCategories = validateErrorCategories(
      retry.retryableCategories,
      `${fieldName}.retryableCategories`,
      'INVALID_RETRY_POLICY',
    );
  }

  if (
    validated.initialDelayMs !== undefined
    && validated.maxDelayMs !== undefined
    && validated.maxDelayMs < validated.initialDelayMs
  ) {
    throw new ProviderConfigurationError(
      'INVALID_RETRY_POLICY',
      `${fieldName}.maxDelayMs must be greater than or equal to ${fieldName}.initialDelayMs`,
    );
  }

  return validated;
}

function validateFallbackOverride(
  value: unknown,
  fieldName: string,
): FallbackPolicyOverride | undefined {
  if (value === undefined) return undefined;
  const fallback = requirePlainRecord(value, fieldName, 'INVALID_FALLBACK_POLICY');
  const validated: FallbackPolicyOverride = {};

  if (fallback.provider !== undefined) {
    validated.provider = parseProviderId(fallback.provider, `${fieldName}.provider`);
  }
  if (fallback.enabled !== undefined) {
    if (typeof fallback.enabled !== 'boolean') {
      throw new ProviderConfigurationError(
        'INVALID_FALLBACK_POLICY',
        `${fieldName}.enabled must be a boolean`,
      );
    }
    validated.enabled = fallback.enabled;
  }
  if (fallback.maxAttempts !== undefined) {
    validated.maxAttempts = validateBoundedInteger(
      fallback.maxAttempts,
      `${fieldName}.maxAttempts`,
      0,
      MAX_PROVIDER_FALLBACK_ATTEMPTS,
      'INVALID_FALLBACK_POLICY',
    );
  }
  if (fallback.on !== undefined) {
    validated.on = validateErrorCategories(
      fallback.on,
      `${fieldName}.on`,
      'INVALID_FALLBACK_POLICY',
    );
  }
  if (fallback.requireSafeReplay !== undefined) {
    if (typeof fallback.requireSafeReplay !== 'boolean') {
      throw new ProviderConfigurationError(
        'INVALID_FALLBACK_POLICY',
        `${fieldName}.requireSafeReplay must be a boolean`,
      );
    }
    validated.requireSafeReplay = fallback.requireSafeReplay;
  }

  return validated;
}

function validateErrorCategories(
  value: unknown,
  fieldName: string,
  code: 'INVALID_RETRY_POLICY' | 'INVALID_FALLBACK_POLICY',
): readonly ProviderErrorCategory[] {
  if (
    !Array.isArray(value)
    || value.some((category) => typeof category !== 'string'
      || !ERROR_CATEGORIES.has(category as ProviderErrorCategory))
  ) {
    throw new ProviderConfigurationError(
      code,
      `${fieldName} contains an unsupported error category`,
    );
  }

  return value.map((category) => category as ProviderErrorCategory);
}

function normalizeModelValue(
  value: unknown,
  fieldName: string,
  provider?: ProviderId,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProviderConfigurationError(
      'INVALID_MODEL',
      `${fieldName} must be a non-empty string`,
      provider,
    );
  }
  return value.trim();
}

function validateBoundedInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
  code: 'INVALID_TIMEOUT' | 'INVALID_RETRY_POLICY' | 'INVALID_FALLBACK_POLICY',
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new ProviderConfigurationError(
      code,
      `${fieldName} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requirePlainRecord(
  value: unknown,
  fieldName: string,
  code: ConfigurationErrorCode = 'INVALID_CONFIGURATION',
  provider?: ProviderId,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderConfigurationError(
      code,
      `${fieldName} must be a non-null object`,
      provider,
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProviderConfigurationError(
      code,
      `${fieldName} must be a plain object`,
      provider,
    );
  }

  return value as Record<string, unknown>;
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}
