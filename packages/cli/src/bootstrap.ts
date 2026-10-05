import { join } from 'node:path'
import { ToolRegistry, ValidationError, type Tool, type ToolContext } from '@flamediff/core'
import { buildRegistry } from '@flamediff/plugins'
import { loadCatalog } from '@flamediff/skills'

export const ENGINE_MODULE = 'flame_diff'

/**
 * The one registry every surface shares.
 *
 * Every capability here is a product capability: these are the five trace tools, plus the
 * catalog readers. There is no second list of tools anywhere — the CLI, the REST API and the
 * MCP server all read this registry, so a capability cannot exist on one surface and be
 * missing from another.
 *
 * Each tool name matches ^[a-z][a-z0-9_]*$ so it is directly exposable over MCP.
 */
export function buildToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register(
    {
      name: 'list_skills',
      description:
        'List the skill catalog with each skill name, version and description. Use this to discover what the agent can do before guessing a command.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBodies: { type: 'boolean', description: 'Include each skill body.' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          issues: { type: 'array', items: { type: 'string' } },
          skills: { type: 'array', items: { type: 'object' } },
        },
        required: ['count', 'issues', 'skills'],
      },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async (input: { includeBodies?: boolean }) => {
        const { skills, issues } = loadCatalog(join(cwd, 'skills'))
        return {
          count: skills.length,
          issues: [...issues],
          skills: skills.map((skill) => ({
            name: skill.name,
            version: skill.version,
            description: skill.description,
            ...(input.includeBodies === true ? { body: skill.body } : {}),
          })),
        }
      },
    } satisfies Tool<{ includeBodies?: boolean }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'list_plugins',
      description:
        'List the resolved plugin registry, including plugins that were shadowed, disabled or rejected and why. Use this to explain why an expected capability is missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object' },
      permissions: ['fs:read'],
      surface: 'core',
      handler: async () => {
        const result = buildRegistry(join(cwd, 'plugins'))
        return {
          active: result.active.map((plugin) => ({
            name: plugin.manifest.name,
            version: plugin.manifest.version,
            capabilities: plugin.manifest.capabilities,
            shadowed: plugin.shadowed,
          })),
          disabled: result.disabled.map((plugin) => plugin.manifest.name),
          rejected: result.rejected.map((plugin) => ({ path: plugin.path, issues: plugin.issues })),
        }
      },
    } satisfies Tool<Record<string, never>, unknown>,
    { source: 'core' },
  )

  const run = async (op: string, input: unknown): Promise<unknown> => {
    const { EngineRunner } = await import('@flamediff/engine-client')
    const result = await new EngineRunner({ root: cwd }).call(op, input)
    // Which implementation answered travels with the payload. A caller that needs the
    // reference specifically can read it and decide; a caller that does not care is spared
    // the branching.
    return { ...(result.value as Record<string, unknown>), engine: result.flavour }
  }

  const traceSchema = {
    traceId: { type: 'string', description: 'Recording identifier, e.g. "run-a".' },
    label: { type: 'string', description: 'Human label for the recording.' },
    spans: {
      type: 'array',
      description: 'The recorded spans, in any order — the engine canonicalises them.',
      items: {
        type: 'object',
        properties: {
          span_id: { type: 'string', description: 'Stable id, unique within the recording.' },
          parent_id: {
            type: ['string', 'null'],
            description: 'Parent span id, or null for a root. A missing parent is reported as detached.',
          },
          name: { type: 'string', description: 'What the work is called, e.g. "db.query".' },
          start_ns: { type: 'number', description: 'Start offset in nanoseconds.' },
          dur_ns: { type: 'number', description: 'Duration in nanoseconds.' },
        },
        required: ['span_id', 'name', 'start_ns', 'dur_ns'],
      },
    },
  } as const

  const pairSchema = {
    base: {
      type: 'object',
      description: 'The recording before the change.',
      properties: traceSchema,
      required: ['traceId', 'spans'],
    },
    head: {
      type: 'object',
      description: 'The recording after the change.',
      properties: traceSchema,
      required: ['traceId', 'spans'],
    },
    regressionRatio: {
      type: 'number',
      description: 'A duration counts as a regression past this multiple. Default 1.25.',
    },
    minDurationNs: {
      type: 'number',
      description: 'Ignore duration changes on spans shorter than this, in nanoseconds.',
    },
  } as const

  const engineSchema = {
    type: 'object',
    properties: traceSchema,
    required: ['traceId', 'spans'],
    additionalProperties: false,
  }

  const pairSchemaLoose = {
    type: 'object',
    properties: pairSchema,
    required: ['base', 'head'],
    additionalProperties: false,
  }

  /**
   * Shape-check only. Field-name normalisation is the engine's job, not this layer's: the
   * reference and the TypeScript port both accept snake_case and camelCase, so duplicating a
   * coercion here would be a second place for the two implementations to disagree.
   */
  const trace = (value: unknown, field: string): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ValidationError(`"${field}" must be an object`, { field })
    }
    const raw = value as Record<string, unknown>
    if (!Array.isArray(raw['spans'])) {
      throw new ValidationError(`"${field}.spans" must be an array`, { field: `${field}.spans` })
    }
    return raw
  }

  const pair = (input: unknown): { base: unknown; head: unknown } => {
    const raw = (input ?? {}) as Record<string, unknown>
    return { base: trace(raw['base'], 'base'), head: trace(raw['head'], 'head') }
  }

  registry.register(
    {
      name: 'trace_diff',
      description:
        'Compare two execution recordings and report what appeared, vanished, got renamed, moved deeper, or got slower. Deterministic: the same two recordings always produce the same report. Spans are matched by span_id, so a renamed function is a rename rather than a delete plus an unrelated add. Returns the report plus `edit_cost`, the number of tokens the minimal edit script had to change, and `roundtrip`, the proof that both recordings survived their own token streams intact. Use this instead of eyeballing two flame graphs.',
      inputSchema: pairSchemaLoose,
      outputSchema: {
        type: 'object',
        properties: {
          stats: { type: 'object' },
          rows: { type: 'array', items: { type: 'object' } },
          column_deltas: { type: 'array', items: { type: 'object' } },
          hunks: { type: 'array', items: { type: 'object' } },
          edit_cost: { type: 'number' },
          roundtrip: { type: 'object' },
          engine: { type: 'string' },
        },
        required: ['stats', 'rows', 'column_deltas', 'hunks', 'edit_cost', 'roundtrip', 'engine'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const { base, head } = pair(input)
        const raw = (input ?? {}) as Record<string, unknown>
        return await run('diff', {
          base,
          head,
          regression_ratio: raw['regressionRatio'] ?? 1.25,
          min_duration_ns: raw['minDurationNs'] ?? 0,
        })
      },
    } satisfies Tool<Record<string, unknown>, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'trace_canonicalize',
      description:
        'Render one execution recording in canonical form: the stack tree written as a nested s-expression, with the children of every node ordered by when they started, so the flame graph reads as time moving downward. Order-independent and idempotent, so two recordings that differ only in the order their spans were appended produce identical text. Use this before comparing anything, and read `detached` to find spans whose parent is missing or on a cycle.',
      inputSchema: engineSchema,
      outputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          byte_length: { type: 'number' },
          span_count: { type: 'number' },
          detached: { type: 'number' },
          lossless: { type: 'boolean' },
          token_count: { type: 'number' },
          significant_count: { type: 'number' },
          engine: { type: 'string' },
        },
        required: ['text', 'byte_length', 'span_count', 'detached', 'lossless', 'token_count', 'engine'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => await run('canonicalize', { trace: trace(input, 'trace') }),
    } satisfies Tool<Record<string, unknown>, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'trace_tokenize',
      description:
        'Split a canonical rendering into typed tokens with byte-exact character offsets. Every input is either tokenized losslessly or refused with a stable error code — whitespace is a token too, so concatenating every token reproduces the input exactly. Use `significant_count` for the number of tokens worth comparing.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A canonical rendering, from trace_canonicalize.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          tokens: { type: 'array', items: { type: 'object' } },
          lossless: { type: 'boolean' },
          token_count: { type: 'number' },
          significant_count: { type: 'number' },
          byte_length: { type: 'number' },
          engine: { type: 'string' },
        },
        required: ['tokens', 'lossless', 'token_count', 'significant_count', 'byte_length', 'engine'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const raw = (input ?? {}) as Record<string, unknown>
        if (typeof raw['text'] !== 'string') {
          throw new ValidationError('"text" must be a string', { field: 'text' })
        }
        return await run('tokenize', { text: raw['text'] })
      },
    } satisfies Tool<{ text: string }, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'trace_verify_roundtrip',
      description:
        'Prove a comparison is faithful: canonicalise each recording, tokenise it, and reassemble the text from its own tokens, then report whether it came back byte-identical. This is the check that makes a diff report trustworthy — run it whenever a comparison is about to be acted on.',
      inputSchema: pairSchemaLoose,
      outputSchema: {
        type: 'object',
        properties: {
          base: { type: 'object' },
          head: { type: 'object' },
          lossless: { type: 'boolean' },
          engine: { type: 'string' },
        },
        required: ['base', 'head', 'lossless', 'engine'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const { base, head } = pair(input)
        const [baseResult, headResult] = await Promise.all([
          run('canonicalize', { trace: base }),
          run('canonicalize', { trace: head }),
        ])
        const baseValue = baseResult as { text: string; lossless: boolean }
        const headValue = headResult as { text: string; lossless: boolean }
        return {
          base: baseValue,
          head: headValue,
          lossless: baseValue.lossless === true && headValue.lossless === true,
        }
      },
    } satisfies Tool<Record<string, unknown>, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'trace_columns',
      description:
        'Report how each column of the columnar storage moved between two recordings — matched by span_id, so an insertion does not report every column below it as changed. This answers "which attributes actually moved?", which a row-per-span store cannot answer without a full scan.',
      inputSchema: pairSchemaLoose,
      outputSchema: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'object' } },
          engine: { type: 'string' },
        },
        required: ['columns', 'engine'],
      },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const { base, head } = pair(input)
        return await run('columns', { base, head })
      },
    } satisfies Tool<Record<string, unknown>, unknown>,
    { source: 'core' },
  )

  registry.register(
    {
      name: 'trace_container',
      description:
        'Encode a recording into the FLDC columnar container, or decode one back. The container stores one column per attribute in canonical order, so encode(decode(x)) is byte-stable and two recordings that differ only in append order produce identical bytes.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['encode', 'decode'] },
          trace: { type: 'object', description: 'Required when mode is "encode".' },
          text: { type: 'string', description: 'The FLDC container text. Required when mode is "decode".' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      permissions: ['proc:spawn'],
      surface: 'core',
      handler: async (input) => {
        const raw = (input ?? {}) as Record<string, unknown>
        if (raw['mode'] === 'encode') {
          return await run('encode', { trace: trace(raw['trace'], 'trace') })
        }
        if (raw['mode'] === 'decode') {
          if (typeof raw['text'] !== 'string') {
            throw new ValidationError('"text" must be a string when mode is "decode"', {
              field: 'text',
            })
          }
          return await run('decode', { text: raw['text'] })
        }
        throw new ValidationError('"mode" must be "encode" or "decode"', { field: 'mode' })
      },
    } satisfies Tool<Record<string, unknown>, unknown>,
    { source: 'core' },
  )

  return registry
}

/** A minimal, dependency-free logger for the tool context. */
export function createContext(requestId = 'cli'): ToolContext {
  return {
    requestId,
    now: () => Date.now(),
    log: (level, message, fields) => {
      process.stderr.write(`${JSON.stringify({ level, message, requestId, ...fields })}\n`)
    },
    dataDir: process.env['PRODUCT_DATA_DIR'] ?? '.data',
  }
}
