/**
 * String escaping, mirrored from `services/engine/src/flame_diff/escape.py`.
 *
 * Everything outside printable ASCII is escaped as \uXXXX so the canonical form is pure
 * ASCII. That is not cosmetic: it makes a token offset mean the same thing in Python (code
 * points) and TypeScript (UTF-16 units). Without it, one astral character in a span name
 * would make the two implementations disagree about every offset after it, and the golden
 * test would fail for a reason unrelated to the engine.
 */

import { EngineError } from './types.js'

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

const SIMPLE_UNESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  '"': '"',
  n: '\n',
  r: '\r',
  t: '\t',
}

const HEX = '0123456789abcdef'

export function escape(value: string): string {
  let out = '"'
  for (const character of value) {
    const simple = SIMPLE_ESCAPES[character]
    if (simple !== undefined) {
      out += simple
      continue
    }
    const point = character.codePointAt(0) ?? 0
    if (point >= 0x20 && point <= 0x7e) {
      out += character
      continue
    }
    out += '\\u'
    out += HEX[(point >> 12) & 0xf]
    out += HEX[(point >> 8) & 0xf]
    out += HEX[(point >> 4) & 0xf]
    out += HEX[point & 0xf]
  }
  return `${out}"`
}

export function unescape(token: string): string {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') {
    throw new EngineError('BAD_TOKEN', `expected a quoted string, got ${JSON.stringify(token)}`)
  }

  let out = ''
  let index = 1
  const end = token.length - 1

  while (index < end) {
    const character = token[index] as string
    if (character !== '\\') {
      if (character === '"') {
        throw new EngineError('BAD_TOKEN', `unescaped quote inside ${JSON.stringify(token)}`)
      }
      out += character
      index += 1
      continue
    }

    index += 1
    if (index >= end) {
      throw new EngineError('BAD_TOKEN', `dangling escape in ${JSON.stringify(token)}`)
    }
    const following = token[index] as string
    const simple = SIMPLE_UNESCAPES[following]
    if (simple !== undefined) {
      out += simple
      index += 1
      continue
    }
    if (following !== 'u') {
      throw new EngineError('BAD_TOKEN', `unknown escape \\${following}`)
    }
    const digits = token.slice(index + 1, index + 5)
    if (digits.length !== 4 || [...digits].some((digit) => !HEX.includes(digit))) {
      throw new EngineError('BAD_TOKEN', `malformed \\u escape in ${JSON.stringify(token)}`)
    }
    const point = Number.parseInt(digits, 16)
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new EngineError('BAD_TOKEN', `lone surrogate escape in ${JSON.stringify(token)}`)
    }
    if (point > 0x10ffff) {
      throw new EngineError('BAD_TOKEN', `escape out of range in ${JSON.stringify(token)}`)
    }
    out += String.fromCodePoint(point)
    index += 5
  }

  return out
}
