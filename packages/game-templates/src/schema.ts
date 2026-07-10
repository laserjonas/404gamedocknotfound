import { z } from 'zod';

/**
 * Zod schema for the GameDock game template format.
 *
 * Templates are JSON files in the `templates/` directory of this package
 * (or in the user template directory, see loader). Adding a new game means
 * adding one JSON file - no backend code changes required.
 */

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'template id must be lowercase alphanumeric with dashes');

/** Variable keys are used as {{KEY}} placeholders and env var names. */
const variableKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'variable keys must be UPPER_SNAKE_CASE');

export const portSchema = z.object({
  name: z.string().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp', 'both']),
});

export const templateVariableSchema = z.object({
  key: variableKey,
  label: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
  default: z.string().max(1024),
  required: z.boolean(),
  secret: z.boolean().optional(),
  /** Optional regex the value must match (anchored automatically). */
  pattern: z.string().max(256).optional(),
});

export const gameTemplateSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(128),
    description: z.string().max(2048).default(''),
    installMethod: z.enum(['steamcmd', 'url', 'manual']),
    steam: z
      .object({
        appId: z.number().int().positive(),
        anonymous: z.boolean().default(true),
        extraArgs: z.array(z.string().max(256)).max(16).optional(),
      })
      .optional(),
    urlInstall: z
      .object({
        /** Required unless "resolver" is set - may contain {{VAR}} placeholders. */
        url: z.string().min(1).max(2048).optional(),
        archive: z.enum(['none', 'zip', 'tar']).default('none'),
        targetFile: z.string().max(256).optional(),
        /**
         * When set, the download URL is resolved dynamically at install time
         * instead of using "url". "versionVariable" names the template
         * variable whose value is passed to the resolver (e.g. a version
         * string picked by the user). Lets templates offer a version picker
         * without hardcoding a single download URL.
         */
        resolver: z.enum(['mojang-version-manifest']).optional(),
        versionVariable: z.string().max(64).optional(),
      })
      .optional(),
    os: z.array(z.enum(['linux', 'windows'])).min(1),
    ports: z.array(portSchema).max(32).default([]),
    start: z.object({
      executable: z.string().min(1).max(512),
      args: z.array(z.string().max(2048)).max(128).default([]),
      workingDir: z.string().max(512).default('.'),
    }),
    env: z.record(z.string().max(2048)).default({}),
    stop: z.object({
      method: z.enum(['command', 'sigint', 'sigterm']),
      command: z.string().max(256).optional(),
      timeoutSeconds: z.number().int().min(1).max(600).default(30),
    }),
    console: z.object({
      supportsInput: z.boolean(),
    }),
    configFiles: z
      .array(
        z.object({
          path: z.string().min(1).max(512),
          description: z.string().max(512).default(''),
          createdByServer: z.boolean().optional(),
        }),
      )
      .max(32)
      .default([]),
    /** Files written into the instance directory after install (placeholders allowed). */
    setupFiles: z
      .array(
        z.object({
          path: z.string().min(1).max(512),
          content: z.string().max(65536),
          /**
           * "properties": treat content as KEY=value lines and merge them into
           * an existing file instead of overwriting it (replacing those keys'
           * lines, keeping everything else). Applied on updates too, unlike
           * plain setup files which never touch an existing file on update.
           * For files the game or a modpack may legitimately own, like
           * Minecraft's server.properties.
           */
          merge: z.enum(['properties']).optional(),
        }),
      )
      .max(16)
      .default([]),
    variables: z.array(templateVariableSchema).max(64).default([]),
    notes: z.string().max(4096).optional(),
  })
  .superRefine((tpl, ctx) => {
    if (tpl.installMethod === 'steamcmd' && !tpl.steam) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'installMethod "steamcmd" requires a "steam" section',
        path: ['steam'],
      });
    }
    if (tpl.installMethod === 'url' && !tpl.urlInstall) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'installMethod "url" requires a "urlInstall" section',
        path: ['urlInstall'],
      });
    }
    if (tpl.urlInstall) {
      const { url, resolver, versionVariable } = tpl.urlInstall;
      if (resolver) {
        if (!versionVariable) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'urlInstall.resolver requires urlInstall.versionVariable',
            path: ['urlInstall', 'versionVariable'],
          });
        } else if (!tpl.variables.some((v) => v.key === versionVariable)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `urlInstall.versionVariable "${versionVariable}" does not match any declared variable`,
            path: ['urlInstall', 'versionVariable'],
          });
        }
      } else if (!url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'urlInstall requires either "url" or "resolver"',
          path: ['urlInstall', 'url'],
        });
      }
    }
    if (tpl.stop.method === 'command' && !tpl.stop.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stop.method "command" requires stop.command',
        path: ['stop', 'command'],
      });
    }
    if (tpl.stop.method === 'command' && !tpl.console.supportsInput) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stop via console command requires console.supportsInput = true',
        path: ['console', 'supportsInput'],
      });
    }
    const seenKeys = new Set<string>();
    for (const [i, v] of tpl.variables.entries()) {
      if (seenKeys.has(v.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate variable key "${v.key}"`,
          path: ['variables', i, 'key'],
        });
      }
      seenKeys.add(v.key);
    }
  });

export type GameTemplate = z.infer<typeof gameTemplateSchema>;
