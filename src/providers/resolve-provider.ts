import {
  DEFAULT_PROVIDER_ID,
  ProviderConfigurationError,
  missingModelError,
  normalizeFallbackPolicy,
  normalizeRetryPolicy,
  normalizeTimeout,
  validateGlobalProviderConfiguration,
  validateProviderScope,
} from './config.js';
import type {
  ProviderId,
  ProviderModelConfiguration,
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
): ResolvedProviderConfiguration {
  const routine = validateProviderScope(input.routine, 'routine');
  const agent = validateProviderScope(input.agent, 'agent');
  const global = validateGlobalProviderConfiguration(input.global);

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
    selection.source === 'legacy' ? input.legacyModel : undefined,
  );

  if (selection.source !== 'legacy' && modelSelection.model === undefined) {
    throw missingModelError(selection.provider);
  }

  const fallback = normalizeFallbackPolicy(
    global?.fallback,
    agent?.fallback,
    routine?.fallback,
  );

  if (fallback.enabled && fallback.provider === selection.provider) {
    throw new ProviderConfigurationError(
      'INVALID_FALLBACK_POLICY',
      `Fallback provider must differ from selected provider "${selection.provider}"`,
      selection.provider,
    );
  }

  return {
    provider: selection.provider,
    model: modelSelection.model,
    selectionSource: selection.source,
    modelSource: modelSelection.source,
    timeout: normalizeTimeout(routine?.timeout, agent?.timeout, global?.timeout),
    retry: normalizeRetryPolicy(global?.retry, agent?.retry, routine?.retry),
    fallback,
    usesProviderDefaultModel:
      selection.source === 'legacy' && modelSelection.model === undefined,
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
    return { model: routineModel.model, source: 'routine' };
  }
  if (agentModel !== undefined) {
    return { model: agentModel.model, source: 'agent' };
  }
  if (globalModel !== undefined) {
    return { model: globalModel.model, source: 'global' };
  }
  if (legacyModel !== undefined) {
    const normalized = legacyModel.trim();
    if (normalized !== '') {
      return { model: normalized, source: 'legacy' };
    }
  }
  return {};
}
