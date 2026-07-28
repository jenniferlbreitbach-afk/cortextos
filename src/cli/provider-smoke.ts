import { Command, InvalidArgumentError } from 'commander';
import type { ProviderAdapterFactory, ProviderAdapterRegistry } from '../providers/adapter.js';
import { OpenAIResponsesAdapter } from '../providers/openai-responses.js';
import { redactCredentialText } from '../providers/provider-error.js';
import {
  runProviderSmoke,
  type ProviderSmokeResult,
} from '../providers/smoke-runner.js';
import type { ProviderId, ProviderUsage } from '../providers/types.js';

interface ProviderSmokeCommandOptions {
  provider: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  json?: boolean;
}

export interface ProviderSmokeCommandDependencies {
  registry?: ProviderAdapterRegistry;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  setExitCode?: (code: number) => void;
  credentialValues?: () => readonly string[];
}

export function createProviderSmokeCommand(
  dependencies: ProviderSmokeCommandDependencies = {},
): Command {
  const registry = dependencies.registry ?? createDefaultSmokeRegistry();
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  const setExitCode = dependencies.setExitCode ?? ((code) => {
    process.exitCode = code;
  });
  const credentialValues = dependencies.credentialValues
    ?? (() => [process.env.OPENAI_API_KEY ?? '']);

  return new Command('provider-smoke')
    .description('Send one isolated prompt to one explicitly selected provider and model')
    .requiredOption('--provider <provider>', 'Provider ID: openai')
    .requiredOption('--model <model>', 'Explicit provider model ID')
    .requiredOption('--prompt <text>', 'Single prompt to send')
    .option(
      '--timeout-ms <milliseconds>',
      'Request timeout in milliseconds',
      parsePositiveInteger,
      120_000,
    )
    .option('--json', 'Emit the provider-neutral result as JSON')
    .addHelpText(
      'after',
      "\nPowerShell example:\n  cortextos provider-smoke --provider openai --model 'gpt-5.6' --prompt 'Reply with exactly: smoke-ok'\n\nRequires OPENAI_API_KEY in the process environment. API keys are not accepted as command arguments.\n",
    )
    .action(async (options: ProviderSmokeCommandOptions) => {
      const result = await runProviderSmoke(
        {
          provider: options.provider,
          model: options.model,
          prompt: options.prompt,
          timeoutMs: options.timeoutMs,
        },
        {
          registry,
          credentialValues: credentialValues(),
        },
      );

      const output = redactCredentialText(
        options.json ? JSON.stringify(result, null, 2) : formatSmokeResult(result),
        credentialValues(),
      );
      const write = result.success ? stdout : stderr;
      write(`${output}\n`);
      if (!result.success) setExitCode(1);
    });
}

export const providerSmokeCommand = createProviderSmokeCommand();

function createDefaultSmokeRegistry(): ProviderAdapterRegistry {
  const factories = new Map<ProviderId, ProviderAdapterFactory>([
    ['openai', () => new OpenAIResponsesAdapter()],
  ]);
  return factories;
}

function formatSmokeResult(result: ProviderSmokeResult): string {
  const lines = [
    `Provider: ${result.provider}`,
    `Model: ${result.model}`,
    `Success: ${result.success}`,
    `Latency: ${result.latencyMs} ms`,
  ];

  if (result.success) {
    if (result.usage) {
      lines.push(`Usage: ${formatUsage(result.usage)}`);
    } else {
      lines.push('Usage: unavailable');
    }
    lines.push('Response:', result.responseText);
  } else {
    lines.push(
      `Error category: ${result.error.category}`,
      `Error code: ${result.error.code}`,
      `Error: ${result.error.message}`,
    );
  }

  return lines.join('\n');
}

function formatUsage(usage: ProviderUsage): string {
  const fields = [
    ['input', usage.inputTokens],
    ['output', usage.outputTokens],
    ['cached_input', usage.cachedInputTokens],
    ['reasoning', usage.reasoningTokens],
    ['total', usage.totalTokens],
  ]
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  return fields.length > 0 ? fields.join(', ') : 'unavailable';
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('timeout must be a positive integer');
  }
  return parsed;
}
