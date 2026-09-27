export * from './enums';

/** Fields every record carries for auditability. */
export interface Timestamped {
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantScoped {
  /** Better Auth `organization.id` — the unit of tenancy. */
  organizationId: string;
}

/** A document/chunk that a user is allowed to see. */
export interface VisibilityFilter {
  organizationId: string;
  userId: string;
  /** Roles the user holds; used to widen `restricted` visibility. */
  roles: string[];
}

export interface CitationSource {
  documentId: string;
  chunkId: string;
  title: string;
  uri?: string | null;
  sourceType: string;
  sourceName: string;
  /** Character offsets of the cited span within the chunk. */
  startOffset?: number;
  endOffset?: number;
  /** Heading breadcrumb, e.g. ["Handbook", "Leave policy"]. */
  headingPath?: string[];
  score: number;
  snippet: string;
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  vectorRank?: number;
  keywordRank?: number;
  rerankScore?: number;
  metadata: Record<string, unknown>;
}

export interface UsageRecord {
  provider: string;
  model: string;
  kind: 'chat' | 'embedding' | 'rerank' | 'vision';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ConnectorDescriptor {
  type: string;
  label: string;
  /** Auth mode the UI should start. */
  auth: 'none' | 'api-key' | 'oauth';
  /** Fields the user must supply, used to render the connect form. */
  fields: Array<{
    name: string;
    label: string;
    type: 'text' | 'password' | 'url' | 'number' | 'select' | 'multiselect';
    required?: boolean;
    placeholder?: string;
    options?: Array<{ label: string; value: string }>;
    help?: string;
  }>;
  docsUrl?: string;
  scopes?: string[];
}
