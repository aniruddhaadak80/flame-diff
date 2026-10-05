import { z } from 'zod'

/**
 * The single source of truth for configuration. The settings UI in apps/web derives its
 * form from `configJsonSchema()` — that schema is never hand-written, so the two cannot drift.
 */
export const ConfigSchema = z.object({
  productEnv: z.enum(['development', 'test', 'production']).default('development'),
  dataDir: z.string().min(1).default('.data'),
  engine: z
    .object({
      python: z.string().min(1).default('python'),
      timeoutMs: z.number().int().positive().max(120_000).default(10_000),
      /**
       * When the Python reference engine is unreachable, fall back to the TypeScript port.
       * The port is held to the Python output by a shared golden file, so the fallback is a
       * deployment convenience (Vercel has no Python runtime), never a silent behaviour change.
       */
      allowTypeScriptFallback: z.boolean().default(true),
    })
    .default({ python: 'python', timeoutMs: 10_000, allowTypeScriptFallback: true }),
  diff: z
    .object({
      /** A duration is a regression only past this multiple. 1.25 = 25% slower. */
      regressionRatio: z.number().min(1).default(1.25),
      /** Ignore spans shorter than this in both recordings, in nanoseconds. */
      minDurationNs: z.number().int().min(0).default(0),
      /** Cap on emitted hunks, so a pathological pair cannot produce an unbounded report. */
      maxHunks: z.number().int().positive().max(100_000).default(5_000),
    })
    .default({ regressionRatio: 1.25, minDurationNs: 0, maxHunks: 5_000 }),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof ConfigSchema>

export const defaultConfig = (): Config => ConfigSchema.parse({})

/** JSON Schema for the settings UI, derived from the zod schema. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: 'input' }) as Record<string, unknown>
}
