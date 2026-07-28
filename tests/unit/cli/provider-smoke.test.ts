import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderSmokeCommand,
  type ProviderSmokeCommandDependencies,
} from '../../../src/cli/provider-smoke.js';
import type {
  ProviderAdapter,
  ProviderAdapterRegistry,
} from '../../../src/providers/adapter.js';
import { ProviderError } from '../../../src/providers/provider-error.js';

const originalKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalKey;
  }
});

describe('provider-smoke CLI', () => {
  it('prints the provider-neutral success contract as JSON', async () => {
    const stdout: string[] = [];
    const command = createProviderSmokeCommand(dependencies({
      registry: registryWith(adapterResolving('smoke-ok')),
      stdout: (text) => stdout.push(text),
    }));

    await command.parseAsync([
      'node',
      'provider-smoke',
      '--provider', 'openai',
      '--model', 'gpt-test',
      '--prompt', 'smoke',
      '--json',
    ]);

    const result = JSON.parse(stdout.join(''));
    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      success: true,
      latencyMs: 7,
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      },
      responseText: 'smoke-ok',
    });
  });

  it('prints human-readable provider, model, latency, usage, and response text', async () => {
    const stdout: string[] = [];
    const command = createProviderSmokeCommand(dependencies({
      registry: registryWith(adapterResolving('human smoke')),
      stdout: (text) => stdout.push(text),
    }));

    await command.parseAsync([
      'node',
      'provider-smoke',
      '--provider', 'openai',
      '--model', 'gpt-test',
      '--prompt', 'smoke',
    ]);

    const output = stdout.join('');
    expect(output).toContain('Provider: openai');
    expect(output).toContain('Model: gpt-test');
    expect(output).toContain('Success: true');
    expect(output).toContain('Latency: 7 ms');
    expect(output).toContain('Usage: input=2, output=1, total=3');
    expect(output).toContain('Response:\nhuman smoke');
  });

  it('prints structured failures to stderr and redacts credentials', async () => {
    const secret = 'sk-test-cli-secret';
    process.env.OPENAI_API_KEY = secret;
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const failingAdapter: ProviderAdapter = {
      provider: 'openai',
      execute: vi.fn().mockRejectedValue(new ProviderError({
        category: 'authentication',
        code: 'INVALID_KEY',
        message: `Rejected credential ${secret}`,
        provider: 'openai',
        safeToReplay: true,
      })),
    };
    const command = createProviderSmokeCommand(dependencies({
      registry: registryWith(failingAdapter),
      stderr: (text) => stderr.push(text),
      setExitCode: (code) => exitCodes.push(code),
      credentialValues: () => [secret],
    }));

    await command.parseAsync([
      'node',
      'provider-smoke',
      '--provider', 'openai',
      '--model', 'gpt-test',
      '--prompt', 'smoke',
      '--json',
    ]);

    const output = stderr.join('');
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
    expect(JSON.parse(output)).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      success: false,
      error: {
        category: 'authentication',
        code: 'INVALID_KEY',
      },
    });
    expect(exitCodes).toEqual([1]);
  });

  it('does not expose an API-key command option', () => {
    const command = createProviderSmokeCommand(dependencies());
    expect(command.options.map((option) => option.long)).not.toContain('--api-key');
  });
});

function dependencies(
  overrides: Partial<ProviderSmokeCommandDependencies> = {},
): ProviderSmokeCommandDependencies {
  return {
    registry: { get: vi.fn().mockReturnValue(undefined) },
    stdout: vi.fn(),
    stderr: vi.fn(),
    setExitCode: vi.fn(),
    ...overrides,
  };
}

function registryWith(adapter: ProviderAdapter): ProviderAdapterRegistry {
  return {
    get: vi.fn().mockReturnValue(() => adapter),
  };
}

function adapterResolving(responseText: string): ProviderAdapter {
  return {
    provider: 'openai',
    execute: vi.fn().mockImplementation(async (request) => ({
      taskId: request.taskId,
      provider: 'openai',
      model: request.model,
      output: responseText,
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      },
      latency: {
        startedAt: '2026-07-28T10:00:00.000Z',
        completedAt: '2026-07-28T10:00:00.007Z',
        totalMs: 7,
      },
    })),
  };
}
