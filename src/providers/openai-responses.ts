import type { ProviderAdapter } from './adapter.js';
import { ProviderError, redactCredentialText } from './provider-error.js';
import type {
  ProviderRequest,
  ProviderResult,
  ProviderUsage,
} from './types.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export interface FetchRequestOptions {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type FetchLike = (
  url: string,
  options: FetchRequestOptions,
) => Promise<FetchResponseLike>;

export interface OpenAIResponsesAdapterOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  monotonicNow?: () => number;
  wallClockNow?: () => Date;
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;

  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly monotonicNow: () => number;
  private readonly wallClockNow: () => Date;

  constructor(options: OpenAIResponsesAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.env = options.env ?? process.env;
    this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.wallClockNow = options.wallClockNow ?? (() => new Date());
  }

  async execute(request: ProviderRequest): Promise<ProviderResult> {
    if (request.provider !== this.provider) {
      throw new ProviderError({
        category: 'configuration',
        code: 'PROVIDER_MISMATCH',
        message: `OpenAI adapter cannot execute provider "${request.provider}"`,
        provider: this.provider,
        safeToReplay: true,
      });
    }

    const model = request.model?.trim();
    if (!model) {
      throw new ProviderError({
        category: 'configuration',
        code: 'MISSING_MODEL',
        message: 'OpenAI smoke requests require an explicit model',
        provider: this.provider,
        safeToReplay: true,
      });
    }

    if (typeof request.input !== 'string' || request.input.trim() === '') {
      throw new ProviderError({
        category: 'configuration',
        code: 'MISSING_PROMPT',
        message: 'OpenAI smoke requests require a non-empty prompt',
        provider: this.provider,
        safeToReplay: true,
      });
    }

    const apiKey = this.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new ProviderError({
        category: 'configuration',
        code: 'MISSING_OPENAI_API_KEY',
        message: 'OPENAI_API_KEY is not set in the server environment',
        provider: this.provider,
        safeToReplay: true,
      });
    }

    const startedAt = this.wallClockNow().toISOString();
    const started = this.monotonicNow();
    const controller = new AbortController();
    const timeoutMs = request.timeout.taskMs;
    const timeoutHandle = timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Phase 2 is deliberately one request, no retries, no tools, and no
      // fallback. The request's retry policy is retained for future phases but
      // is not executed by this smoke adapter.
      const response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: request.input,
          store: false,
        }),
        signal: controller.signal,
      });

      const payload = await readJsonObject(response);
      if (!response.ok) {
        throw classifyOpenAIHttpError(response, payload, apiKey);
      }

      const output = extractResponseText(payload);
      if (output === undefined) {
        throw new ProviderError({
          category: 'unknown',
          code: 'MISSING_RESPONSE_TEXT',
          message: 'OpenAI response did not contain response text',
          provider: this.provider,
          safeToReplay: true,
        });
      }

      const completedAt = this.wallClockNow().toISOString();
      const totalMs = elapsedMs(started, this.monotonicNow());
      const responseModel = stringValue(payload.model) ?? model;
      const usage = extractUsage(payload.usage);

      return {
        taskId: request.taskId,
        provider: this.provider,
        model: responseModel,
        output,
        usage,
        latency: {
          startedAt,
          completedAt,
          totalMs,
        },
        providerRequestId: stringValue(payload.id),
        stopReason: stringValue(payload.status),
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      if (controller.signal.aborted || isAbortError(error)) {
        throw new ProviderError({
          category: 'timeout',
          code: 'OPENAI_REQUEST_TIMEOUT',
          message: 'OpenAI request exceeded the configured timeout',
          provider: this.provider,
          retryable: true,
          safeToReplay: false,
        });
      }

      throw new ProviderError({
        category: 'provider_unavailable',
        code: 'OPENAI_TRANSPORT_ERROR',
        message: 'OpenAI request failed before a response was received',
        provider: this.provider,
        retryable: true,
        safeToReplay: false,
      });
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

const defaultFetch: FetchLike = async (url, options) => fetch(url, options);

async function readJsonObject(response: FetchResponseLike): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return asRecord(value) ?? {};
  } catch {
    if (!response.ok) return {};
    throw new ProviderError({
      category: 'unknown',
      code: 'INVALID_OPENAI_RESPONSE',
      message: 'OpenAI returned a response that was not valid JSON',
      provider: 'openai',
      safeToReplay: true,
    });
  }
}

function classifyOpenAIHttpError(
  response: FetchResponseLike,
  payload: Record<string, unknown>,
  apiKey: string,
): ProviderError {
  const error = asRecord(payload.error);
  const apiCode = stringValue(error?.code);
  const apiType = stringValue(error?.type);
  const parameter = stringValue(error?.param);
  const rawMessage = stringValue(error?.message)
    ?? `OpenAI request failed with HTTP ${response.status}`;
  const message = redactCredentialText(rawMessage, [apiKey]);
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

  if (response.status === 401 || response.status === 403) {
    return new ProviderError({
      category: 'authentication',
      code: apiCode ?? 'OPENAI_AUTHENTICATION_ERROR',
      message,
      provider: 'openai',
      httpStatus: response.status,
      safeToReplay: true,
    });
  }

  if (response.status === 429) {
    const quota = apiCode === 'insufficient_quota'
      || apiType === 'insufficient_quota'
      || /\bquota\b|\bbilling\b|\bcredits?\b/i.test(rawMessage);
    return new ProviderError({
      category: quota ? 'quota' : 'rate_limit',
      code: apiCode ?? (quota ? 'OPENAI_QUOTA_EXHAUSTED' : 'OPENAI_RATE_LIMIT'),
      message,
      provider: 'openai',
      retryable: !quota,
      httpStatus: response.status,
      retryAfterMs,
      safeToReplay: true,
    });
  }

  if (response.status === 408) {
    return new ProviderError({
      category: 'timeout',
      code: apiCode ?? 'OPENAI_REQUEST_TIMEOUT',
      message,
      provider: 'openai',
      retryable: true,
      httpStatus: response.status,
      retryAfterMs,
      safeToReplay: false,
    });
  }

  if (
    response.status === 404
    || parameter === 'model'
    || apiCode === 'model_not_found'
    || apiCode === 'unsupported_model'
  ) {
    return new ProviderError({
      category: 'model_unsupported',
      code: apiCode ?? 'OPENAI_MODEL_UNSUPPORTED',
      message,
      provider: 'openai',
      httpStatus: response.status,
      safeToReplay: true,
    });
  }

  if (response.status >= 500) {
    return new ProviderError({
      category: 'provider_unavailable',
      code: apiCode ?? 'OPENAI_PROVIDER_UNAVAILABLE',
      message,
      provider: 'openai',
      retryable: true,
      httpStatus: response.status,
      retryAfterMs,
      safeToReplay: true,
    });
  }

  return new ProviderError({
    category: 'configuration',
    code: apiCode ?? 'OPENAI_REQUEST_REJECTED',
    message,
    provider: 'openai',
    httpStatus: response.status,
    safeToReplay: true,
  });
}

function extractResponseText(payload: Record<string, unknown>): string | undefined {
  const direct = stringValue(payload.output_text);
  if (direct !== undefined) return direct;

  if (!Array.isArray(payload.output)) return undefined;
  const parts: string[] = [];
  for (const item of payload.output) {
    const itemRecord = asRecord(item);
    if (!itemRecord || !Array.isArray(itemRecord.content)) continue;
    for (const content of itemRecord.content) {
      const contentRecord = asRecord(content);
      if (contentRecord?.type === 'output_text') {
        const text = stringValue(contentRecord.text);
        if (text !== undefined) parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function extractUsage(value: unknown): ProviderUsage {
  const usage = asRecord(value);
  if (!usage) return {};
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return compactUsage({
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    cachedInputTokens: numberValue(inputDetails?.cached_tokens),
    reasoningTokens: numberValue(outputDetails?.reasoning_tokens),
    totalTokens: numberValue(usage.total_tokens),
  });
}

function compactUsage(usage: ProviderUsage): ProviderUsage {
  return Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  ) as ProviderUsage;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}

function elapsedMs(start: number, end: number): number {
  return Math.max(0, Math.round(end - start));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
