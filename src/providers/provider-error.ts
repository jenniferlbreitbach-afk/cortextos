import type {
  ProviderErrorCategory,
  ProviderId,
  StructuredProviderError,
} from './types.js';

export interface ProviderErrorOptions {
  category: ProviderErrorCategory;
  code: string;
  message: string;
  provider?: ProviderId;
  retryable?: boolean;
  fallbackEligible?: boolean;
  safeToReplay?: boolean;
  httpStatus?: number;
  exitCode?: number;
  signal?: string;
  retryAfterMs?: number;
}

export class ProviderError extends Error implements StructuredProviderError {
  readonly name = 'ProviderError' as const;
  readonly category: ProviderErrorCategory;
  readonly code: string;
  readonly provider?: ProviderId;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;
  readonly safeToReplay: boolean;
  readonly httpStatus?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly retryAfterMs?: number;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.category = options.category;
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.fallbackEligible = options.fallbackEligible ?? false;
    this.safeToReplay = options.safeToReplay ?? false;
    this.httpStatus = options.httpStatus;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function toStructuredProviderError(
  error: unknown,
  fallbackProvider?: ProviderId,
  credentialValues: readonly string[] = [],
): StructuredProviderError {
  if (isStructuredProviderError(error)) {
    return {
      name: 'ProviderError',
      category: error.category,
      code: error.code,
      message: redactCredentialText(error.message, credentialValues),
      provider: error.provider ?? fallbackProvider,
      retryable: error.retryable,
      fallbackEligible: error.fallbackEligible,
      safeToReplay: error.safeToReplay,
      httpStatus: error.httpStatus,
      exitCode: error.exitCode,
      signal: error.signal,
      retryAfterMs: error.retryAfterMs,
    };
  }

  return {
    name: 'ProviderError',
    category: 'unknown',
    code: 'UNEXPECTED_PROVIDER_ERROR',
    message: 'Provider execution failed with an unexpected error',
    provider: fallbackProvider,
    retryable: false,
    fallbackEligible: false,
    safeToReplay: false,
  };
}

export function redactCredentialText(
  value: string,
  credentialValues: readonly string[] = [],
): string {
  let redacted = value;
  for (const credential of credentialValues) {
    if (credential) {
      redacted = redacted.split(credential).join('[REDACTED]');
    }
  }

  return redacted
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1[REDACTED]');
}

function isStructuredProviderError(error: unknown): error is StructuredProviderError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<StructuredProviderError>;
  return candidate.name === 'ProviderError'
    && typeof candidate.category === 'string'
    && typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
    && typeof candidate.retryable === 'boolean'
    && typeof candidate.fallbackEligible === 'boolean'
    && typeof candidate.safeToReplay === 'boolean';
}
