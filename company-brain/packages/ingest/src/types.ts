/**
 * Ingestion data model.
 *
 * A source connector produces `FetchedResource`s. A parser turns one into a
 * `ParsedDocument` of heading-delimited `Section`s. The chunker then slices
 * sections into `ChunkDraft`s that respect the embedding model's token budget.
 *
 * Keeping those three stages separate is what makes re-embedding cheap: once a
 * document is parsed its sections can be stored and re-chunked without touching
 * the original file, and re-chunked without re-parsing.
 */

export type ResourceKind = 'html' | 'markdown' | 'text' | 'pdf' | 'docx' | 'binary';

/** A single retrieved artefact from a connector. */
export interface FetchedResource {
  /** Stable id derived from the connector, used for document de-duplication. */
  externalId: string;
  /** URL or path the resource came from, for citations. */
  uri: string;
  title: string;
  contentType: string;
  kind: ResourceKind;
  /** Raw bytes for binary formats, decoded text for text formats. */
  body: string | Uint8Array;
  /** Connector-supplied change token (etag, mtime, revision). */
  version?: string;
  /** Free-form provenance, e.g. `{ repo, path, branch, commit }`. */
  metadata?: Record<string, string | number | boolean | null>;
  /** ISO timestamp the source last changed, if known. */
  modifiedAt?: Date;
}

export interface Section {
  /**
   * Heading breadcrumb, e.g. `['Handbook', 'Benefits', 'Equity']`.
   *
   * Stored denormalized on each chunk as `headingText` because Postgres cannot
   * build a generated `tsvector` from an array (`array_to_string` is STABLE, and
   * generated columns require IMMUTABLE). Re-derive it whenever headings change.
   */
  headings: string[];
  text: string;
  /** Byte offset of the section in the original document, for diagnostics. */
  offset?: number;
}

export interface ParsedDocument {
  title: string;
  sections: Section[];
  /** Language tag when the parser can detect one. */
  language?: string;
  metadata?: Record<string, string | number | boolean | null>;
  /** Warnings that did not prevent parsing, surfaced in the sync run. */
  warnings: string[];
}

export interface ChunkDraft {
  content: string;
  headings: string[];
  /** Denormalized `headings.join(' > ')` for the search vector. */
  headingText: string;
  /** 0-based position within the document, so ordering survives re-retrieval. */
  index: number;
  /** Fraction of the document already covered, 0..1. */
  startRatio: number;
  endRatio: number;
  tokenCount: number;
}

export interface ChunkOptions {
  /**
   * Token budget per chunk. Defaults to a value that fits the common
   * 1536-dimension embedding models with room for the heading prefix.
   */
  maxTokens?: number;
  /**
   * Fraction of the previous chunk repeated at the start of the next one, so a
   * sentence split across a boundary is still retrievable. Expressed in tokens.
   */
  overlapTokens?: number;
  /** Chunks smaller than this are merged forward to avoid useless fragments. */
  minTokens?: number;
}

/** Raised when a resource cannot be parsed at all. */
export class ParseError extends Error {
  override readonly name = 'ParseError';

  constructor(
    message: string,
    readonly uri: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
