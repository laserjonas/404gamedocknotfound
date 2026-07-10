import type { GameTemplate } from '@gamedock/game-templates';
import { badRequest } from '../errors.js';

/**
 * Template placeholder substitution and startup command construction.
 *
 * Commands are NEVER passed through a shell. The executable and each
 * argument are separate strings handed to spawn(), so there is no shell
 * injection surface. Substituted values are still validated to reject
 * control characters, which keeps logs and stdin-based consoles safe.
 */

const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export class UnknownPlaceholderError extends Error {
  constructor(public readonly key: string) {
    super(`Unknown template variable "${key}"`);
    this.name = 'UnknownPlaceholderError';
  }
}

export function containsControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0a-\x1f\x7f]/.test(value);
}

/**
 * Validate user-supplied variable values against the template definition:
 * unknown keys are rejected, required values enforced, defaults applied,
 * per-variable regex patterns anchored and checked.
 */
export function resolveVariableValues(
  template: GameTemplate,
  values: Record<string, string>,
): Record<string, string> {
  const known = new Map(template.variables.map((v) => [v.key, v]));

  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      throw badRequest(`Unknown variable "${key}" for template "${template.id}"`);
    }
  }

  const resolved: Record<string, string> = {};
  for (const variable of template.variables) {
    const raw = values[variable.key];
    const value = raw !== undefined && raw !== '' ? raw : variable.default;

    if (variable.required && value === '') {
      throw badRequest(`Variable "${variable.key}" is required`);
    }
    if (containsControlChars(value)) {
      throw badRequest(`Variable "${variable.key}" contains control characters`);
    }
    if (value.length > 1024) {
      throw badRequest(`Variable "${variable.key}" is too long`);
    }
    if (variable.pattern && value !== '') {
      const re = new RegExp(`^(?:${variable.pattern})$`);
      if (!re.test(value)) {
        throw badRequest(`Variable "${variable.key}" does not match the required format`);
      }
    }
    resolved[variable.key] = value;
  }
  return resolved;
}

/** Replace {{KEY}} placeholders. Throws on unknown keys. */
export function substitutePlaceholders(input: string, vars: Record<string, string>): string {
  return input.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new UnknownPlaceholderError(key);
    }
    return value;
  });
}

export interface StartCommand {
  executable: string;
  args: string[];
  workingDir: string;
  env: Record<string, string>;
}

export interface BuildStartCommandInput {
  template: GameTemplate;
  instanceDir: string;
  instanceId: string;
  instanceName: string;
  /** Shared cluster data directory, exposed as GAMEDOCK_CLUSTER_DIR. */
  clusterDir?: string;
  /** Resolved template variable values. */
  variables: Record<string, string>;
  /** Extra env vars configured on the instance. */
  instanceEnv: Record<string, string>;
  /** Optional startup overrides configured on the instance. */
  overrideExecutable?: string | null;
  overrideArgs?: string[] | null;
}

/** Variables available to every template in addition to its own. */
export function builtinVariables(input: {
  instanceDir: string;
  instanceId: string;
  instanceName: string;
  clusterDir?: string;
}): Record<string, string> {
  return {
    GAMEDOCK_INSTANCE_DIR: input.instanceDir,
    GAMEDOCK_INSTANCE_ID: input.instanceId,
    GAMEDOCK_INSTANCE_NAME: input.instanceName,
    // Shared across all instances - lets multi-server setups (ARK clusters)
    // point every member at the same transfer directory.
    ...(input.clusterDir !== undefined ? { GAMEDOCK_CLUSTER_DIR: input.clusterDir } : {}),
  };
}

/**
 * Build the full start command for an instance. Arguments that resolve to
 * an empty string after substitution are dropped (lets optional values
 * like empty passwords disappear cleanly).
 */
export function buildStartCommand(input: BuildStartCommandInput): StartCommand {
  const { template } = input;
  const vars: Record<string, string> = {
    ...input.variables,
    ...builtinVariables(input),
  };

  const rawExecutable = input.overrideExecutable ?? template.start.executable;
  const rawArgs = input.overrideArgs ?? template.start.args;

  const executable = substitutePlaceholders(rawExecutable, vars);
  if (executable.trim() === '' || containsControlChars(executable)) {
    throw badRequest('Startup executable is empty or contains control characters');
  }

  const args: string[] = [];
  for (const rawArg of rawArgs) {
    // Object args are dropped wholesale when their gate variable is empty -
    // for flags like "-clusterid={{CLUSTER_ID}}" that must not appear at all
    // (not as "-clusterid=") when the feature is unconfigured.
    let raw: string;
    if (typeof rawArg === 'string') {
      raw = rawArg;
    } else {
      if ((vars[rawArg.omitIfEmpty] ?? '') === '') continue;
      raw = rawArg.value;
    }
    const arg = substitutePlaceholders(raw, vars);
    if (containsControlChars(arg)) {
      throw badRequest('A startup argument contains control characters');
    }
    if (arg === '') continue;
    args.push(arg);
  }

  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(template.env)) {
    env[key] = substitutePlaceholders(rawValue, vars);
  }
  for (const [key, value] of Object.entries(input.instanceEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw badRequest(`Invalid environment variable name "${key}"`);
    }
    if (containsControlChars(value)) {
      throw badRequest(`Environment variable "${key}" contains control characters`);
    }
    env[key] = value;
  }

  const workingDir = substitutePlaceholders(template.start.workingDir, vars);

  return { executable, args, workingDir, env };
}
