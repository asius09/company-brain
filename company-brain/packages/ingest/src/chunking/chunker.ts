import { countTokens, normalizeWhitespace } from '@company-brain/core';
import type { ChunkDraft, ChunkOptions, ParsedDocument, Section } from '../types';

/**
 * Defaults tuned for the common 1536-dimension embedding models.
 *
 * 512 leaves generous headroom inside a 8192-token context and, more
 * importantly, keeps chunks small enough that a retrieved chunk carries a
 * coherent idea — retrieval quality degrades badly once a chunk holds several
 * unrelated paragraphs.
 */
const DEFAULTS: Required<ChunkOptions> = {
  maxTokens: 512,
  overlapTokens: 64,
  minTokens: 48,
};

/** Joins a heading breadcrumb the way citations should display it. */
export function formatHeadings(headings: string[]): string {
  return headings.filter(Boolean).join(' > ');
}

/**
 * Splits a paragraph into sentence-ish units.
 *
 * Deliberately regex-based rather than a full NLP segmenter: the only hard
 * requirement is that a chunk boundary is *unlikely* to fall mid-sentence, and a
 * dependency on language models for that is not worth the weight. Abbreviations
 * that do trip it ("Dr.", "e.g.") only cost a slightly early boundary.
 */
export function splitSentences(text: string): string[] {
  const guarded = text
    // Protect the common abbreviations that end in a period.
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Inc|Ltd|Co)\./gi, '$1<DOT>')
    // Protect decimal numbers and version numbers.
    .replace(/(\d)\.(\d)/g, '$1<DOT>$2');

  return guarded
    .split(/(?<=[.!?])\s+(?=["'(\w])|\n{2,}/)
    .map((part) => part.replace(/<DOT>/g, '.').trim())
    .filter(Boolean);
}

/** Hard ceiling on sentences per chunk, so a runaway list cannot blow the budget. */
const MAX_SENTENCES_PER_CHUNK = 40;

/**
 * Slices one section's text into token-bounded pieces, preferring sentence
 * boundaries and never splitting a word.
 */
function sliceText(text: string, maxTokens: number): string[] {
  const pieces: string[] = [];
  const sentences = splitSentences(text);

  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length > 0) {
      pieces.push(current.join(' '));
      current = [];
      currentTokens = 0;
    }
  };

  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence);

    // A single sentence longer than the whole budget (minified JSON, a base64
    // blob) can never fit: cut it on token boundaries directly.
    if (sentenceTokens > maxTokens) {
      flush();
      pieces.push(...hardSplit(sentence, maxTokens));
      continue;
    }

    if (currentTokens + sentenceTokens > maxTokens && current.length > 0) {
      flush();
    }

    current.push(sentence);
    currentTokens += sentenceTokens;

    if (current.length >= MAX_SENTENCES_PER_CHUNK) {
      flush();
    }
  }

  flush();
  return pieces;
}

/**
 * Word-window slicing for text with no sentence structure to respect.
 *
 * Also handles the pathological case the outer loop cannot: a single
 * whitespace-free run longer than the whole budget — minified JavaScript, a
 * base64 blob, a long data URI. There is no word boundary to cut on, so it is
 * bisected on characters, using the real tokenizer rather than a chars-per-token
 * guess so the budget is respected exactly.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push(current.join(' '));
    current = [];
    currentTokens = 0;
  };

  for (const word of words) {
    const wordTokens = countTokens(word);

    if (wordTokens > maxTokens) {
      // The word cannot fit alongside anything already buffered.
      flush();
      out.push(...splitUnsplittable(word, maxTokens));
      continue;
    }

    if (currentTokens + wordTokens > maxTokens) flush();
    current.push(word);
    currentTokens += wordTokens;
  }

  flush();
  return out;
}

/** Largest prefix of `word` whose token count fits `maxTokens`, bisected. */
function splitUnsplittable(word: string, maxTokens: number): string[] {
  const pieces: string[] = [];
  let rest = word;

  while (rest.length > 0) {
    // ~3 chars/token is a safe starting guess for a mid-document sample; the
    // bisection below corrects it against the real encoder either way.
    let low = 1;
    let high = Math.min(rest.length, Math.max(1, maxTokens * 3));
    let best = '';

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (countTokens(rest.slice(0, mid)) <= maxTokens) {
        best = rest.slice(0, mid);
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    // One character alone exceeds the budget; emit it and make progress.
    if (best === '') best = rest.slice(0, 1);
    pieces.push(best);
    rest = rest.slice(best.length);
  }

  return pieces;
}

/**
 * Re-opens a chunk with the tail of its predecessor.
 *
 * Overlap exists so a passage that straddles a boundary is still fully present
 * in at least one chunk. It is taken from whole sentences at the end of the
 * previous piece, and the overlap text is counted against the budget so a chunk
 * never exceeds `maxTokens`.
 */
function buildOverlap(previous: string, budget: number): string {
  if (budget <= 0 || !previous) return '';
  const sentences = splitSentences(previous);
  const picked: string[] = [];
  let tokens = 0;

  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i] as string;
    const sentenceTokens = countTokens(sentence);
    if (tokens + sentenceTokens > budget) break;
    picked.unshift(sentence);
    tokens += sentenceTokens;
  }

  return picked.join(' ');
}

/**
 * Heading-aware, token-bounded chunking.
 *
 * Three rules, in priority order:
 *
 *  1. A chunk never spans two sections. Keeping chunks inside a section means
 *     the heading breadcrumb attached to a chunk is always accurate, which is
 *     what makes citations readable.
 *  2. Within a section, boundaries land on sentence ends where possible.
 *  3. Chunks under `minTokens` are merged into their successor, because a
 *     three-word chunk retrieves almost nothing useful.
 */
export function chunkDocument(
  document: ParsedDocument,
  options: ChunkOptions = {},
): ChunkDraft[] {
  const { maxTokens, overlapTokens, minTokens } = { ...DEFAULTS, ...options };

  const sections = document.sections.filter((section) => section.text.trim().length > 0);
  if (sections.length === 0) return [];

  // 1. Flatten to token-bounded pieces, remembering where each came from.
  interface Piece {
    text: string;
    headings: string[];
  }

  const pieces: Piece[] = [];
  for (const section of sections) {
    const headingText = formatHeadings(section.headings);
    const budget = headingText ? Math.max(32, maxTokens - countTokens(headingText)) : maxTokens;

    let previous: Piece | undefined;
    for (const slice of sliceText(normalizeWhitespace(section.text), budget)) {
      const overlap = previous && overlapTokens > 0 ? buildOverlap(previous.text, overlapTokens) : '';

      // Overlap is prepended, not accounted for: a chunk carrying `overlap`
      // plus a full-budget slice would exceed the budget and get truncated or
      // rejected by the embedding API. Trim the slice until the pair fits.
      let content = overlap ? `${overlap} ${slice}` : slice;
      if (overlap && countTokens(content) > budget) {
        const sliceWords = slice.split(/\s+/).filter(Boolean);
        while (sliceWords.length > 1 && countTokens(`${overlap} ${sliceWords.join(' ')}`) > budget) {
          sliceWords.pop();
        }
        content = sliceWords.length > 0 ? `${overlap} ${sliceWords.join(' ')}` : overlap;
      }

      pieces.push({ text: content, headings: section.headings });
      previous = pieces[pieces.length - 1];
    }
  }

  if (pieces.length === 0) return [];

  // 2. Merge undersized pieces forward. Trailing tiny pieces merge backward.
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.headings.join(' ') === piece.headings.join(' ') &&
      countTokens(previous.text) < minTokens
    ) {
      previous.text = `${previous.text} ${piece.text}`.trim();
      continue;
    }
    merged.push({ ...piece });
  }

  const lastIndex = merged.length - 1;
  if (merged.length > 1) {
    const last = merged[lastIndex]!;
    const previous = merged[lastIndex - 1]!;
    if (countTokens(last.text) < minTokens && previous.headings.join(' ') === last.headings.join(' ')) {
      previous.text = `${previous.text} ${last.text}`.trim();
      merged.pop();
    }
  }

  // 3. Re-check the budget: merging can push a chunk over `maxTokens`, and an
  //    over-budget chunk is silently truncated or rejected by the embedding API.
  const finalPieces: Piece[] = [];
  for (const piece of merged) {
    if (countTokens(piece.text) <= maxTokens) {
      finalPieces.push(piece);
      continue;
    }
    for (const slice of hardSplit(piece.text, maxTokens)) {
      finalPieces.push({ text: slice, headings: piece.headings });
    }
  }

  // Character offsets drive the ratios stored on each chunk.
  const totalChars = finalPieces.reduce((sum, piece) => sum + piece.text.length, 0) || 1;
  let cursor = 0;

  return finalPieces.map((piece, index) => {
    const startRatio = cursor / totalChars;
    cursor += piece.text.length;
    const endRatio = cursor / totalChars;
    const headingText = formatHeadings(piece.headings);

    return {
      content: piece.text,
      headings: piece.headings,
      headingText,
      index,
      startRatio: round4(startRatio),
      endRatio: round4(endRatio),
      tokenCount: countTokens(piece.text),
    };
  });
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export type { Section };
