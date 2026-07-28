import { randomUUID } from 'crypto';
import type { ProviderAdapterRegistry } from './adapter.js';
import {
  DEFAULT_RETRY_POLICY,
  ProviderConfigurationError,
  parseProviderId,
} from './config.js';
import { ProviderError, toStructuredProviderError } from './provider-error.js';
import type {
  ProviderId,
  ProviderUsage,
  StructuredProviderError,
} from './types.js';

export interface ProviderSmokeInput {
  provider: unknown;
  model: unknown;
  prompt: unknown;
  timeoutMs?: unknown;
}

export interface ProviderSmokeSuccess {
  provider: string;
  model: string;
  success: true;
  latencyMs: number;
  usage?: ProviderUsage;
  responseText: string;
}

export interface ProviderSmokeFailure {
  provider: string;
  model: string;
  success: false;
  latencyMs: number;
  error: StructuredProviderError;
}

export type ProviderSmokeResult = ProviderSmokeSuccess | ProviderSmokeFailure;

export interface ProviderSmokeRunnerDependencies {
  registry: ProviderAdapterRegistry;
  monotonicNow?: () => number;
  createTaskId?: () => string;
  credentialValues?: readonly string[];
}

const DEFAULT_SMOKE_TIMEOUT_MS = 120_000;

/**
 * Executes one smoke request against exactly one explicitly selected adapter.
 * It performs one registry lookup, one factory call, and one adapter invocation.
 * It never retries, falls back, or initializes an unselected provider.
 */
export async function runProviderSmoke(
  input: ProviderSmokeInput,
  dependencies: ProviderSmokeRunnerDependencies,
): Promise<ProviderSmokeResult> {
  const now = dependencies.monotonicNow ?? performance.now.bind(performance);
  const started = now();
  const providerLabel = scalarLabel(input.provider);
  const modelLabel = scalarLabel(input.model);
  let provider: ProviderId | undefined;

  try {
    provider = parseProviderId(input.provider, 'smoke.provider');
    if (!provider) {
      throw new ProviderError({
        category: 'configuration',
        code: 'MISSING_PROVIDER',
        message: 'Smoke requests require an explicit provider',
        safeToReplay: true,
      });
    }

    const model = requiredString(input.model, 'MISSING_MODEL', 'model');
    const prompt = requiredString(input.prompt, 'MISSING_PROMPT', 'prompt');
    const timeoutMs = parseTimeout(input.timeoutMs);

    // Deliberately one scalar lookup. Do not iterate or pre-initialize a
    // provider registry here.
    const factory = dependencies.registry.get(provider);
    if (!factory) {
      throw new ProviderError({
        category: 'configuration',
        code: 'PROVIDER_ADAPTER_UNAVAILABLE',
        message: `No smoke adapter is registered for provider "${provider}"`,
        provider,
        safeToReplay: true,
      });
    }

    const adapter = factory();
    if (adapter.provider !== provider) {
      throw new ProviderError({
        category: 'configuration',
        code: 'PROVIDER_ADAPTER_MISMATCH',
        message: `Selected provider "${provider}" returned a mismatched adapter`,
        provider,
        safeToReplay: true,
      });
    }

    const result = await adapter.execute({
      taskId: (dependencies.createTaskId ?? randomUUID)(),
      agentId: 'provider-smoke',
      provider,
      model,
      input: prompt,
      timeout: { taskMs: timeoutMs },
      retry: {
        ...DEFAULT_RETRY_POLICY,
        maxRetries: 0,
        retryableCategories: [],
      },
      metadata: {
        source: 'provider-smoke',
      },
    });

    if (result.provider !== provider) {
      throw new ProviderError({
        category: 'configuration',
        code: 'PROVIDER_RESULT_MISMATCH',
        message: `Selected provider "${provider}" returned a mismatched result`,
        provider,
        safeToReplay: true,
      });
    }

    const usage = hasUsage(result.usage) ? result.usage : undefined;
    return {
      provider,
      model: result.model ?? model,
      success: true,
      latencyMs: result.latency.totalMs,
      usage,
      responseText: String(result.output),
    };
  } catch (error) {
    const credentialValues = dependencies.credentialValues
      ?? [process.env.OPENAI_API_KEY ?? ''];
    return {
      provider: provider ?? providerLabel,
      model: modelLabel,
      success: false,
      latencyMs: elapsedMs(started, now()),
      error: toStructuredProviderError(error, provider, credentialValues),
    };
  }
}

function requiredString(
  value: unknown,
  code: 'MISSING_MODEL' | 'MISSING_PROMPT',
  fieldName: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProviderError({
      category: 'configuration',
      code,
      message: `Smoke requests require an explicit ${fieldName}`,
      safeToReplay: true,
    });
  }
  return value.trim();
}

function parseTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_SMOKE_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ProviderConfigurationError(
      'INVALID_TIMEOUT',
      'smoke.timeoutMs must be a positive integer',
    );
  }
  return value;
}

function scalarLabel(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function elapsedMs(start: number, end: number): number {
  return Math.max(0, Math.round(end - start));
}

function hasUsage(usage: ProviderUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}
