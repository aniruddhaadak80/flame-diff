/**
 * The tokenizer, mirrored from `services/engine/src/flame_diff/tokenizer.py`.
 *
 * The contract is stated as a total function, because the lexer is deliberately strict:
 *
 *   for every string s, EITHER tokenize(s) yields tokens whose concatenated `text` is s
 *   byte for byte, OR it throws with a stable code.
 *
 * An unterminated string in a recording is corruption, not text to guess at. A tokenizer
 * that quietly accepted garbage would be a worse product, so refusal is a first-class
 * outcome rather than something the guarantee has to be weakened for.
 *
 * The differ does not diff whitespace — it filters to significant tokens at use time, which
 * is why the lossless stream is kept intact in the first place.
 */

import { EngineError, type Token, type TokenKind } from './types.js'

export const KIND_WS: TokenKind = 'ws'
export const KIND_LPAREN: TokenKind = 'lparen'
export const KIND_RPAREN: TokenKind = 'rparen'
export const KIND_SYM: TokenKind = 'sym'
export const KIND_STRING: TokenKind = 'string'
export const KIND_NUMBER: TokenKind = 'number'

/** Token kinds that carry meaning. Whitespace is deliberately absent. */
export const SIGNIFICANT_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  KIND_LPAREN,
  KIND_RPAREN,
  KIND_SYM,
  KIND_STRING,
  KIND_NUMBER,
])

const WHITESPACE = new Set([' ', '\t', '\r', '\n'])
const DIGITS = '0123456789'
const SYMBOL_BODY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  const length = text.length

  while (index < length) {
    const character = text[index] as string

    if (WHITESPACE.has(character)) {
      let end = index + 1
      while (end < length && WHITESPACE.has(text[end] as string)) end += 1
      tokens.push({ kind: KIND_WS, text: text.slice(index, end), start: index, end })
      index = end
      continue
    }

    if (character === '(') {
      tokens.push({ kind: KIND_LPAREN, text: '(', start: index, end: index + 1 })
      index += 1
      continue
    }

    if (character === ')') {
      tokens.push({ kind: KIND_RPAREN, text: ')', start: index, end: index + 1 })
      index += 1
      continue
    }

    if (character === '"') {
      let end = index + 1
      let closed = false
      while (end < length) {
        if (text[end] === '\\') {
          end += 2
          continue
        }
        if (text[end] === '"') {
          end += 1
          closed = true
          break
        }
        end += 1
      }
      if (!closed || end > length) {
        throw new EngineError('UNTERMINATED_STRING', `unterminated string at offset ${index}`)
      }
      tokens.push({ kind: KIND_STRING, text: text.slice(index, end), start: index, end })
      index = end
      continue
    }

    if (
      DIGITS.includes(character) ||
      (character === '-' && index + 1 < length && DIGITS.includes(text[index + 1] as string))
    ) {
      let end = index + 1
      while (end < length && DIGITS.includes(text[end] as string)) end += 1
      tokens.push({ kind: KIND_NUMBER, text: text.slice(index, end), start: index, end })
      index = end
      continue
    }

    if (SYMBOL_BODY.includes(character)) {
      let end = index + 1
      while (end < length && SYMBOL_BODY.includes(text[end] as string)) end += 1
      tokens.push({ kind: KIND_SYM, text: text.slice(index, end), start: index, end })
      index = end
      continue
    }

    throw new EngineError(
      'UNEXPECTED_CHARACTER',
      `unexpected character ${JSON.stringify(character)} at offset ${index}`,
    )
  }

  return tokens
}

export function detokenize(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text).join('')
}

export function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter((token) => SIGNIFICANT_KINDS.has(token.kind))
}

export interface RoundtripProbe {
  readonly lossless: boolean
  readonly token_count: number
  readonly significant_count: number
  readonly byte_length: number
  readonly rebuilt_byte_length: number
}

/** UTF-8 byte length without depending on Node's Buffer, so this stays runtime-agnostic. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function verifyRoundtrip(text: string): RoundtripProbe {
  const tokens = tokenize(text)
  const rebuilt = detokenize(tokens)
  return {
    lossless: rebuilt === text,
    token_count: tokens.length,
    significant_count: significant(tokens).length,
    byte_length: byteLength(text),
    rebuilt_byte_length: byteLength(rebuilt),
  }
}
