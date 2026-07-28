import type { ProviderId, ProviderRequest, ProviderResult } from './types.js';

export interface ProviderAdapter<TInput = string, TOutput = string> {
  readonly provider: ProviderId;
  execute(request: ProviderRequest<TInput>): Promise<ProviderResult<TOutput>>;
}

export type ProviderAdapterFactory = () => ProviderAdapter;

/**
 * A smoke request performs one scalar lookup, instantiates the returned
 * adapter once, and invokes it once. Registries contain factories rather than
 * adapter instances so unselected providers are never initialized.
 */
export interface ProviderAdapterRegistry {
  get(provider: ProviderId): ProviderAdapterFactory | undefined;
}
