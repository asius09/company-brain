/**
 * Token accounting shared by the chunker, the retriever and the cost guardrail.
 *
 * Uses `js-tiktoken` (cl100k_base) as a provider-neutral approximation. Real
 * billing still comes from each provider's reported `usage`, so this is used for
 * chunk sizing and pre-flight budget checks only.
 */

import { encodingForModel, getEncoding, type Tiktoken } from 'js-tiktoken';

let encoder: Tiktoken | undefined;
let encoderModel: string | undefined;

function getEncoder(): Tiktoken {
  if (!encoder) {
    try {
      encoder = getEncoding('cl100k_base');
      encoderModel = 'cl100k_base';
    } catch {
      // Extremely defensive: fall back to a 4-chars-per-token heuristic.
      encoder = {
        encode: (text: string) => Array.from({ length: Math.ceil(text.length / 4) }, () => 0),
        decode: (tokens: number[]) => tokens.map(() => '').join(''),
      } as unknown as Tiktoken;
      encoderModel = 'heuristic';
    }
  }
  return encoder;
}

/** Exact-ish token count for a model, falling back to cl100k_base. */
export function countTokens(text: string, model?: string): number {
  if (!text) return 0;
  if (model) {
    try {
      const specific = encodingForModel(model as never);
      return specific.encode(text).length;
    } catch {
      // Unsupported model id — fall through to the shared encoder.
    }
  }
  return getEncoder().encode(text).length;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function tokenEncoderModel(): string {
  getEncoder();
  return encoderModel ?? 'cl100k_base';
}

/* -------------------------------------------------------------------------- */
/* Text normalisation                                                         */
/* -------------------------------------------------------------------------- */

/** Collapses whitespace runs but preserves paragraph breaks. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes control characters that confuse embeddings and tokenisers. */
export function stripControlCharacters(text: string): string {
  // Keeps \t (\x09) and \n (\x0A), drops the rest of the C0 range plus DEL.
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function truncate(text: string, maxChars: number, suffix = '…'): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix;
}

/** Naive but effective language guess, used to label chunks for the UI. */
export function detectLanguage(text: string): string {
  if (!text.trim()) return 'und';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/[\u3040-\u30FF]/.test(text)) return 'ja';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
  return 'en';
}
