export const PROVIDER_IDS = ['anthropic', 'openai'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderSelectionSource = 'routine' | 'agent' | 'global' | 'legacy';

export type ProviderErrorCategory =
  | 'configuration'
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'provider_unavailable'
  | 'model_unsupported'
  | 'tool_error'
  | 'process_exit'
  | 'unknown';

export interface ProviderModelConfiguration {
  model: string;
}

export type ProviderModelMap = Partial<Record<ProviderId, ProviderModelConfiguration>>;

export interface ProviderTimeout {
  /**
   * Maximum wall-clock time for one provider task. When omitted, the
   * provider adapter retains its existing/default timeout behavior.
   */
  taskMs?: number;
}

export interface ProviderRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableCategories: ProviderErrorCategory[];
}

export interface ProviderRetryPolicyOverride {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableCategories?: ProviderErrorCategory[];
}

export interface FallbackPolicy {
  enabled: boolean;
  provider?: ProviderId;
  on: ProviderErrorCategory[];
  maxAttempts: number;
  requireSafeReplay: boolean;
}

export interface ProviderScopeConfiguration {
  /**
   * A scalar by design: one task resolves to exactly one active provider.
   */
  provider?: ProviderId;
  models?: ProviderModelMap;
  timeout?: ProviderTimeout;
  retry?: ProviderRetryPolicyOverride;
  fallback?: Partial<FallbackPolicy>;
}

export interface GlobalProviderConfiguration
  extends Omit<ProviderScopeConfiguration, 'provider'> {
  defaultProvider?: ProviderId;
}

export interface ProviderResolutionInput {
  routine?: ProviderScopeConfiguration;
  agent?: ProviderScopeConfiguration;
  global?: GlobalProviderConfiguration;

  /**
   * The pre-provider `AgentConfig.model` value. It is only eligible as an
   * Anthropic model and only when provider selection follows the legacy path.
   */
  legacyModel?: string;
}

export interface ResolvedProviderConfiguration {
  /**
   * Singular by construction. A fallback target is policy, not a concurrently
   * selected provider.
   */
  provider: ProviderId;
  model?: string;
  selectionSource: ProviderSelectionSource;
  modelSource?: ProviderSelectionSource;
  timeout: ProviderTimeout;
  retry: ProviderRetryPolicy;
  fallback: FallbackPolicy;
  usesProviderDefaultModel: boolean;
}

export interface ProviderRequest<TInput = string> {
  taskId: string;
  agentId: string;
  routineId?: string;
  provider: ProviderId;
  model?: string;
  input: TInput;
  timeout: ProviderTimeout;
  retry: ProviderRetryPolicy;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface ProviderLatency {
  startedAt: string;
  completedAt: string;
  totalMs: number;
  timeToFirstTokenMs?: number;
}

export interface ProviderResult<TOutput = string> {
  taskId: string;
  provider: ProviderId;
  model?: string;
  output: TOutput;
  usage: ProviderUsage;
  latency: ProviderLatency;
  providerRequestId?: string;
  stopReason?: string;
}

export interface StructuredProviderError {
  name: 'ProviderError';
  category: ProviderErrorCategory;
  code: string;
  message: string;
  provider?: ProviderId;
  retryable: boolean;
  fallbackEligible: boolean;
  safeToReplay: boolean;
  httpStatus?: number;
  exitCode?: number;
  signal?: string;
  retryAfterMs?: number;
}
