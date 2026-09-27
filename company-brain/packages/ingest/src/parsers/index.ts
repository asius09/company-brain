import { normalizeWhitespace } from '@company-brain/core';
import { ParseError, type FetchedResource, type ParsedDocument, type Section } from '../types';

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Infers the format from content type first, then from the URI extension. */
export function detectKind(resource: FetchedResource): FetchedResource['kind'] {
  const contentType = resource.contentType.toLowerCase();

  if (contentType.includes('text/html')) return 'html';
  if (contentType.includes('text/markdown') || contentType.includes('text/x-markdown')) return 'markdown';
  if (contentType.includes('application/pdf')) return 'pdf';
  if (
    contentType.includes('wordprocessingml') ||
    contentType.includes('msword')
  ) {
    return 'docx';
  }
  if (contentType.startsWith('text/')) return 'text';

  const path = resource.uri.split('?')[0]?.toLowerCase() ?? '';
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'html';
  if (path.endsWith('.md') || path.endsWith('.markdown') || path.endsWith('.mdx')) return 'markdown';
  if (path.endsWith('.pdf')) return 'pdf';
  if (path.endsWith('.docx')) return 'docx';
  if (path.endsWith('.txt') || path.endsWith('.csv') || path.endsWith('.json')) return 'text';

  return 'binary';
}

function asText(resource: FetchedResource): string {
  if (typeof resource.body === 'string') return resource.body;
  return new TextDecoder('utf-8', { fatal: false }).decode(resource.body);
}

function singleSection(headings: string[], text: string): Section[] {
  return [{ headings, text: normalizeWhitespace(text) }];
}

/* -------------------------------------------------------------------------- */
/* Plain text                                                                  */
/* -------------------------------------------------------------------------- */

export function parseText(resource: FetchedResource): ParsedDocument {
  const text = asText(resource);
  if (!text.trim()) {
    throw new ParseError('document is empty', resource.uri);
  }

  // Treat a run of blank lines as a soft section break so a plain-text file with
  // topic breaks still produces usable citations instead of one giant section.
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const sections: Section[] = blocks.length > 1
    ? blocks.map((block, index) => ({
        headings: [],
        text: normalizeWhitespace(block),
        // `offset` is the block's position in document order, which is the most
        // that is meaningful without a heading structure to key off.
        offset: index,
      }))
    : singleSection([], text);

  return {
    title: resource.title,
    sections,
    warnings: [],
    metadata: resource.metadata,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* -------------------------------------------------------------------------- */

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE = /^(\s*)(```+|~~~+)/;

export function parseMarkdown(resource: FetchedResource): ParsedDocument {
  const raw = asText(resource);
  if (!raw.trim()) {
    throw new ParseError('document is empty', resource.uri);
  }

  const lines = raw.split(/\r?\n/);
  const sections: Section[] = [];

  // A stack of { level, text } is the current heading breadcrumb.
  const stack: { level: number; text: string }[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let offset = 0;
  let consumed = 0;
  let h1Text: string | null = null;

  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length === 0) return;
    sections.push({ headings: stack.map((h) => h.text), text, offset });
  };

  for (const line of lines) {
    consumed += line.length + 1;

    if (FENCE.test(line)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }

    // A `#` inside a fenced code block is data, not a heading.
    if (!inFence) {
      const heading = ATX_HEADING.exec(line);
      if (heading) {
        flush();
        const level = (heading[1] as string).length;
        const text = (heading[2] as string).trim();

        while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) {
          stack.pop();
        }
        if (level === 1 && h1Text === null) h1Text = text;
        stack.push({ level, text });
        offset = consumed;
        continue;
      }
    }

    buffer.push(line);
  }

  if (inFence) {
    return {
      title: resource.title,
      sections: sections.length > 0 ? sections : singleSection([], raw),
      warnings: ['unterminated fenced code block'],
      metadata: resource.metadata,
    };
  }

  flush();

  return {
    // The first H1 is a better title than the file name — and it is the heading
    // text itself, not the body that happens to follow it.
    title: h1Text ?? resource.title,
    sections: sections.length > 0 ? sections : singleSection([], raw),
    warnings: [],
    metadata: resource.metadata,
  };
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                        */
/* -------------------------------------------------------------------------- */

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'ul',
]);
/**
 * Tags whose *content* is never a retrievable answer: code, embeds, and
 * metadata.
 */
const STRIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas']);

/**
 * Site furniture — navigation, headers, footers, sidebars.
 *
 * Skipped because its text is repeated on every page and drowns out the real
 * content, which measurably hurts retrieval. This is the same judgement
 * Readability makes, and the reason `parseResource` is the better entry point
 * for messy third-party pages.
 */
const CHROME_TAGS = new Set(['nav', 'header', 'footer', 'aside']);

type Token =
  | { kind: 'open'; tag: string }
  | { kind: 'close'; tag: string }
  | { kind: 'text'; value: string };

/**
 * Tokenises HTML into a flat event list.
 *
 * A tokenizer pass up front keeps the section builder below free of regex
 * bookkeeping, and makes it straightforward to skip whole subtrees (a
 * `<script>` containing `<` characters) by index arithmetic instead of trying to
 * track nesting mid-stream.
 */
function tokenizeHtml(html: string): Token[] {
  const tokens: Token[] = [];
  // `<!...>` (doctype) and `<?...>` (processing instruction) are declarations,
  // not tags, and must not fall through to the character-data branch.
  const pattern = /<!--[\s\S]*?-->|<[!?][^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const raw = match[0];
    const tag = match[1]?.toLowerCase();

    if (raw.startsWith('<!--')) continue;

    if (tag) {
      if (raw.startsWith('</')) {
        tokens.push({ kind: 'close', tag });
      } else if (!raw.endsWith('/>')) {
        tokens.push({ kind: 'open', tag });
      }
      continue;
    }

    if (match[2]) tokens.push({ kind: 'text', value: match[2] });
  }

  return tokens;
}

/** Index of the token that closes `tag` opened at `from`, or -1 if unclosed. */
function findClose(tokens: Token[], from: number, tag: string): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind === 'open' && token.tag === tag) depth += 1;
    if (token.kind === 'close' && token.tag === tag) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function nextText(tokens: Token[], from: number): string {
  const token = tokens[from];
  return token?.kind === 'text' ? token.value : '';
}

/**
 * Extracts heading-delimited sections from HTML.
 *
 * Walks the token list once, maintaining a heading breadcrumb and accumulating
 * character data into the current section. A heading closes the section above
 * it, which is what gives every chunk an accurate breadcrumb.
 */
export function parseHtml(resource: FetchedResource): ParsedDocument {
  const html = asText(resource);
  if (!html.trim()) {
    throw new ParseError('document is empty', resource.uri);
  }

  const tokens = tokenizeHtml(html).filter((token) => {
    if (token.kind === 'text') return token.value.trim().length > 0;
    return true;
  });

  const warnings: string[] = [];
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let buffer: string[] = [];
  let documentTitle = '';

  const flush = () => {
    const text = normalizeWhitespace(buffer.join(' '));
    buffer = [];
    if (!text) return;
    sections.push({ headings: stack.map((entry) => entry.text), text });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;

    if (token.kind === 'text') {
      buffer.push(token.value);
      continue;
    }

    if (token.kind === 'open') {
      if (STRIPPED_TAGS.has(token.tag) || CHROME_TAGS.has(token.tag)) {
        // Skip the entire subtree, including any markup nested inside it.
        const close = findClose(tokens, i, token.tag);
        i = close === -1 ? tokens.length : close;
        continue;
      }

      if (token.tag === 'title' && !documentTitle) {
        documentTitle = normalizeWhitespace(nextText(tokens, i + 1));
        const close = findClose(tokens, i, 'title');
        i = close === -1 ? tokens.length : close;
        continue;
      }

      if (HEADING_TAGS.has(token.tag)) {
        const close = findClose(tokens, i, token.tag);
        const headingText = close === -1 ? '' : normalizeWhitespace(nextText(tokens, i + 1));

        // A heading ends the section that preceded it.
        flush();

        const level = Number(token.tag.slice(1));
        while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) {
          stack.pop();
        }
        stack.push({ level, text: headingText });

        i = close === -1 ? tokens.length : close;
        continue;
      }

      if (BLOCK_TAGS.has(token.tag)) buffer.push('\n\n');
      continue;
    }

    // `token.kind === 'close'`: nothing to do. Sections are flushed on the next
    // heading, and trailing text is flushed after the loop.
  }

  flush();

  const title = stack.find((entry) => entry.level === 1)?.text || documentTitle || resource.title;
  if (sections.length === 0) warnings.push('no textual content found');

  return { title, sections, warnings, metadata: resource.metadata };
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

/** Parses a fetched resource into heading-delimited sections. */
export function parseResource(resource: FetchedResource): ParsedDocument {
  const kind = detectKind(resource);

  switch (kind) {
    case 'markdown':
      return parseMarkdown(resource);
    case 'html':
      return parseHtml(resource);
    case 'text':
      return parseText(resource);
    default:
      throw new ParseError(
        `no parser for ${kind} (${resource.contentType || 'unknown content type'})`,
        resource.uri,
      );
  }
}
