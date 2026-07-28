import {
  DEFAULT_PROVIDER_ID,
  ProviderConfigurationError,
  missingFallbackModelError,
  missingModelError,
  normalizeFallbackPolicy,
  normalizeRetryPolicy,
  normalizeTimeout,
  validateProviderResolutionInput,
} from './config.js';
import type {
  FallbackPolicy,
  ProviderId,
  ProviderModelConfiguration,
  ProviderModelMap,
  ProviderResolutionInput,
  ProviderSelectionSource,
  ResolvedProviderConfiguration,
} from './types.js';

/**
 * Resolves configuration only. It never creates, starts, or invokes a provider.
 *
 * Provider precedence is deterministic:
 * routine -> agent -> global -> legacy Anthropic.
 */
export function resolveProviderConfiguration(
  input: ProviderResolutionInput,
): ResolvedProviderConfiguration;
export function resolveProviderConfiguration(
  input: unknown,
): ResolvedProviderConfiguration;
export function resolveProviderConfiguration(
  input: unknown,
): ResolvedProviderConfiguration {
  const validatedInput = validateProviderResolutionInput(input);
  const { routine, agent, global, legacyModel } = validatedInput;

  const selection = selectProvider(
    routine?.provider,
    agent?.provider,
    global?.defaultProvider,
  );

  const modelSelection = selectModel(
    selection.provider,
    routine?.models?.[selection.provider],
    agent?.models?.[selection.provider],
    global?.models?.[selection.provider],
    selection.provider === 'anthropic' ? legacyModel : undefined,
  );

  if (selection.source !== 'legacy' && modelSelection.model === undefined) {
    throw missingModelError(selection.provider);
  }

  const fallback = normalizeFallbackPolicy(
    global?.fallback,
    agent?.fallback,
    routine?.fallback,
  );

  const resolvedFallback = resolveFallback(
    fallback,
    selection.provider,
    routine?.models,
    agent?.models,
    global?.models,
    legacyModel,
  );

  if (selection.source === 'legacy' && modelSelection.model === undefined) {
    return {
      provider: selection.provider,
      model: modelSelection.model,
      selectionSource: selection.source,
      modelSource: modelSelection.source,
      timeout: normalizeTimeout(routine?.timeout, agent?.timeout, global?.timeout),
      retry: normalizeRetryPolicy(global?.retry, agent?.retry, routine?.retry),
      fallback: resolvedFallback,
      usesProviderDefaultModel: true,
    };
  }

  return {
    provider: selection.provider,
    model: modelSelection.model,
    selectionSource: selection.source,
    modelSource: modelSelection.source,
    timeout: normalizeTimeout(routine?.timeout, agent?.timeout, global?.timeout),
    retry: normalizeRetryPolicy(global?.retry, agent?.retry, routine?.retry),
    fallback: resolvedFallback,
    usesProviderDefaultModel: false,
  };
}

function selectProvider(
  routineProvider: ProviderId | undefined,
  agentProvider: ProviderId | undefined,
  globalProvider: ProviderId | undefined,
): { provider: ProviderId; source: ProviderSelectionSource } {
  if (routineProvider !== undefined) {
    return { provider: routineProvider, source: 'routine' };
  }
  if (agentProvider !== undefined) {
    return { provider: agentProvider, source: 'agent' };
  }
  if (globalProvider !== undefined) {
    return { provider: globalProvider, source: 'global' };
  }
  return { provider: DEFAULT_PROVIDER_ID, source: 'legacy' };
}

function selectModel(
  provider: ProviderId,
  routineModel: ProviderModelConfiguration | undefined,
  agentModel: ProviderModelConfiguration | undefined,
  globalModel: ProviderModelConfiguration | undefined,
  legacyModel: string | undefined,
): { model?: string; source?: ProviderSelectionSource } {
  if (routineModel !== undefined) {
    return { model: routineModel.model.trim(), source: 'routine' };
  }
  if (agentModel !== undefined) {
    return { model: agentModel.model.trim(), source: 'agent' };
  }
  if (globalModel !== undefined) {
    return { model: globalModel.model.trim(), source: 'global' };
  }
  if (legacyModel !== undefined) {
    const normalized = legacyModel.trim();
    if (normalized !== '') {
      return { model: normalized, source: 'legacy' };
    }
  }
  return {};
}

function resolveFallback(
  fallback: FallbackPolicy,
  primaryProvider: ProviderId,
  routineModels: ProviderModelMap | undefined,
  agentModels: ProviderModelMap | undefined,
  globalModels: ProviderModelMap | undefined,
  legacyModel: string | undefined,
): FallbackPolicy {
  if (!fallback.enabled || fallback.provider === undefined) {
    return fallback;
  }

  if (fallback.provider === primaryProvider) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      `Fallback provider must differ from selected provider "${primaryProvider}"`,
      primaryProvider,
    );
  }

  const modelSelection = selectModel(
    fallback.provider,
    routineModels?.[fallback.provider],
    agentModels?.[fallback.provider],
    globalModels?.[fallback.provider],
    fallback.provider === 'anthropic' ? legacyModel : undefined,
  );
  if (modelSelection.model === undefined) {
    throw missingFallbackModelError(fallback.provider);
  }

  return {
    ...fallback,
    model: modelSelection.model,
    modelSource: modelSelection.source,
    on: [...fallback.on],
  };
}
