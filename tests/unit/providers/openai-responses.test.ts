import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesAdapter,
  type FetchLike,
  type FetchResponseLike,
} from '../../../src/providers/openai-responses.js';
import type { ProviderRequest } from '../../../src/providers/types.js';

const TEST_KEY = 'sk-test-secret-value';

describe('OpenAIResponsesAdapter', () => {
  it('performs one tool-free Responses API request and returns normalized output', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(200, {
      id: 'resp_test',
      model: 'gpt-test-snapshot',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'smoke-ok' }],
        },
      ],
      usage: {
        input_tokens: 8,
        output_tokens: 3,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }));
    const ticks = [100, 142];
    const dates = [
      new Date('2026-07-28T10:00:00.000Z'),
      new Date('2026-07-28T10:00:00.042Z'),
    ];
    const adapter = new OpenAIResponsesAdapter({
      fetchImpl,
      env: { OPENAI_API_KEY: TEST_KEY },
      monotonicNow: () => ticks.shift() ?? 142,
      wallClockNow: () => dates.shift() ?? new Date('2026-07-28T10:00:00.042Z'),
    });

    const result = await adapter.execute(request());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      model: 'gpt-test',
      input: 'Reply with smoke-ok',
      store: false,
    });
    expect(body).not.toHaveProperty('tools');

    expect(result).toMatchObject({
      taskId: 'task-test',
      provider: 'openai',
      model: 'gpt-test-snapshot',
      output: 'smoke-ok',
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        cachedInputTokens: 2,
        reasoningTokens: 1,
        totalTokens: 11,
      },
      latency: {
        totalMs: 42,
      },
      providerRequestId: 'resp_test',
      stopReason: 'completed',
    });
  });

  it('uses top-level output_text and omits unavailable usage values', async () => {
    const adapter = new OpenAIResponsesAdapter({
      fetchImpl: vi.fn<FetchLike>().mockResolvedValue(response(200, {
        output_text: 'direct text',
      })),
      env: { OPENAI_API_KEY: TEST_KEY },
    });

    const result = await adapter.execute(request());

    expect(result.output).toBe('direct text');
    expect(result.usage).toEqual({});
  });

  it('does not call fetch when OPENAI_API_KEY is missing', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const adapter = new OpenAIResponsesAdapter({ fetchImpl, env: {} });

    await expect(adapter.execute(request())).rejects.toMatchObject({
      name: 'ProviderError',
      category: 'configuration',
      code: 'MISSING_OPENAI_API_KEY',
      provider: 'openai',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies authentication errors and redacts the credential', async () => {
    const adapter = new OpenAIResponsesAdapter({
      fetchImpl: vi.fn<FetchLike>().mockResolvedValue(response(401, {
        error: {
          code: 'invalid_api_key',
          message: `Incorrect API key provided: ${TEST_KEY}`,
        },
      })),
      env: { OPENAI_API_KEY: TEST_KEY },
    });

    const error = await adapter.execute(request()).catch((caught) => caught);

    expect(error).toMatchObject({
      name: 'ProviderError',
      category: 'authentication',
      code: 'invalid_api_key',
      httpStatus: 401,
    });
    expect(error.message).not.toContain(TEST_KEY);
    expect(error.message).toContain('[REDACTED]');
  });

  it.each([
    ['insufficient_quota', 'quota', false],
    ['rate_limit_exceeded', 'rate_limit', true],
  ])('classifies 429 code %s as %s', async (code, category, retryable) => {
    const adapter = new OpenAIResponsesAdapter({
      fetchImpl: vi.fn<FetchLike>().mockResolvedValue(response(
        429,
        { error: { code, message: code } },
        { 'retry-after': '2' },
      )),
      env: { OPENAI_API_KEY: TEST_KEY },
    });

    await expect(adapter.execute(request())).rejects.toMatchObject({
      name: 'ProviderError',
      category,
      code,
      retryable,
      retryAfterMs: 2_000,
    });
  });

  it('classifies aborts as structured timeouts', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const adapter = new OpenAIResponsesAdapter({
      fetchImpl: vi.fn<FetchLike>().mockRejectedValue(abort),
      env: { OPENAI_API_KEY: TEST_KEY },
    });

    await expect(adapter.execute(request())).rejects.toMatchObject({
      name: 'ProviderError',
      category: 'timeout',
      code: 'OPENAI_REQUEST_TIMEOUT',
      retryable: true,
    });
  });

  it('classifies model errors without retrying or issuing another request', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(400, {
      error: {
        code: 'model_not_found',
        param: 'model',
        message: 'The requested model does not exist',
      },
    }));
    const adapter = new OpenAIResponsesAdapter({
      fetchImpl,
      env: { OPENAI_API_KEY: TEST_KEY },
    });

    await expect(adapter.execute(request())).rejects.toMatchObject({
      name: 'ProviderError',
      category: 'model_unsupported',
      code: 'model_not_found',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function request(): ProviderRequest {
  return {
    taskId: 'task-test',
    agentId: 'provider-smoke',
    provider: 'openai',
    model: 'gpt-test',
    input: 'Reply with smoke-ok',
    timeout: { taskMs: 1_000 },
    retry: {
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      backoffMultiplier: 1,
      retryableCategories: ['rate_limit'],
    },
  };
}

function response(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => normalized[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(body),
  };
}
