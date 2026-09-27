import { createLogger, getEnv } from '@company-brain/core';
import type { FetchedResource } from '../types';
import { ConnectorError, httpFetch, type Connector, type ListResult } from './base';

const log = createLogger('ingest.connector.website');

/**
 * Same-origin website crawler.
 *
 * Scope is deliberately narrow and safe-by-default:
 *
 *  - strictly same-origin, so a crawl cannot wander into an attacker's domain
 *    via a link on a trusted page;
 *  - `robots.txt` is fetched and honoured, including `Disallow` for the
 *    crawler user-agent;
 *  - a hard page and depth cap, so a misconfigured source cannot fan out into
 *    a denial-of-service against someone else's site or exhaust our own budget.
 */
export interface WebsiteConnectorOptions {
  rootUrl: string;
  /** Extra path prefixes to ignore, e.g. `/admin`, `/wp-login.php`. */
  excludePrefixes?: string[];
  maxPages?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export function createWebsiteConnector(options: WebsiteConnectorOptions): Connector {
  const env = getEnv();
  const root = new URL(options.rootUrl);
  const maxPages = options.maxPages ?? env.CRAWL_MAX_PAGES;
  const maxDepth = options.maxDepth ?? env.CRAWL_MAX_DEPTH;
  const fetchImpl = options.fetchImpl ?? fetch;

  // Path segments that are never content. Skipping these by default avoids the
  // single largest source of junk pages on real sites.
  const defaultExcludes = [
    '/login', '/logout', '/signin', '/signup', '/register', '/admin', '/wp-admin',
    '/cart', '/checkout', '/account', '/search', '/tag/', '/author/', '/feed',
    '/rss', '/sitemap', '/privacy', '/terms', '/cookie',
  ];
  const excludes = [...defaultExcludes, ...(options.excludePrefixes ?? [])].map(
    (prefix) => prefix.toLowerCase(),
  );

  const isSameOrigin = (url: URL): boolean => url.origin === root.origin;

  const shouldSkip = (url: URL): boolean => {
    const path = url.pathname.toLowerCase();
    if (excludes.some((prefix) => path.startsWith(prefix))) return true;
    // Binary assets are not documents; indexing a stylesheet helps nobody.
    return /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|woff2?|ttf|eot|mp4|webm|mp3|zip|pdf)$/i.test(
      url.pathname,
    );
  };

  async function isAllowed(url: URL): Promise<boolean> {
    let robots: string | null = null;
    try {
      const response = await httpFetch(new URL('/robots.txt', root).toString(), {
        signal: options.signal,
        headers: { 'user-agent': env.CRAWL_USER_AGENT },
      });
      robots = await response.text();
    } catch {
      // No robots.txt (or unreachable) is not an error: crawl on.
      return true;
    }
    return isAllowedByRobots(robots as string, url.pathname, env.CRAWL_USER_AGENT);
  }

  async function list(): Promise<ListResult> {
    if (!(await isAllowed(root))) {
      throw new ConnectorError(`robots.txt disallows ${root.pathname}`, 'website');
    }

    const seen = new Set<string>();
    const queue: { url: URL; depth: number }[] = [{ url: root, depth: 0 }];
    const items: FetchedResource[] = [];

    while (queue.length > 0 && items.length < maxPages) {
      if (options.signal?.aborted) break;
      const next = queue.shift();
      if (!next) break;

      const key = next.url.toString();
      if (seen.has(key)) continue;
      seen.add(key);

      let response: Response;
      try {
        response = await httpFetch(key, { signal: options.signal });
      } catch (error) {
        log.debug('crawl.fetch_failed', 'skipping an unreachable page', {
          url: key,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) continue;

      const html = await response.text();
      const title = extractTitle(html) ?? next.url.pathname;

      items.push({
        externalId: stableId(next.url),
        uri: next.url.toString(),
        title,
        contentType,
        kind: 'html',
        body: html,
        version: response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined,
        metadata: { depth: next.depth, crawledFrom: root.toString() },
        modifiedAt: parseHttpDate(response.headers.get('last-modified')),
      });

      if (next.depth >= maxDepth) continue;

      for (const href of extractLinks(html, next.url)) {
        if (seen.size >= maxPages) break;
        if (!isSameOrigin(href) || shouldSkip(href) || seen.has(href.toString())) continue;
        // robots.txt is checked per-URL, not just for the root, so a crawl
        // cannot walk into a disallowed area by following an internal link.
        if (!(await isAllowed(href))) continue;
        queue.push({ url: href, depth: next.depth + 1 });
      }
    }

    log.info('crawl.complete', 'website crawl finished', {
      root: root.toString(),
      pages: items.length,
      discovered: seen.size,
    });

    return { items };
  }

  return {
    sourceType: 'website',
    list,
    async fetch(externalId: string): Promise<FetchedResource> {
      // `externalId` is the encoded page URL, not a URL itself: the contract
      // only hands the connector an id, so it has to be decoded here.
      const url = urlFromExternalId(externalId);

      // A document row is tenant-supplied data, so an id read back out of the
      // database must never be able to steer the worker at an arbitrary host.
      // `list` already enforces both of these; `fetch` re-checks because it runs
      // on ids that have made a round trip through storage.
      if (!isSameOrigin(url)) {
        throw new ConnectorError(
          `refusing to fetch ${url.origin}: outside the source origin ${root.origin}`,
          'website',
        );
      }
      if (!(await isAllowed(url))) {
        throw new ConnectorError(`robots.txt disallows ${url.pathname}`, 'website');
      }

      const response = await httpFetch(url.toString(), { signal: options.signal });
      const contentType = response.headers.get('content-type') ?? 'text/html';
      const body = await response.text();

      return {
        externalId,
        uri: url.toString(),
        title: extractTitle(body) ?? url.pathname,
        contentType,
        kind: 'html',
        body,
        version: response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined,
        modifiedAt: parseHttpDate(response.headers.get('last-modified')),
      };
    },
  };
}

/**
 * Minimal `robots.txt` evaluation: honours `User-agent` groups that match the
 * token in our User-Agent, and its `Allow`/`Disallow` rules.
 *
 * Longest-match wins, and `Allow` beats `Disallow` at equal length, which is the
 * rule the de-facto standard specifies.
 */
export function isAllowedByRobots(robots: string, path: string, userAgent: string): boolean {
  const agentToken = userAgent.split('/')[0]?.toLowerCase() ?? '*';
  const lines = robots.split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim());

  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let expectingAgents = false;

  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current?.agents.push(value.toLowerCase());
      continue;
    }

    expectingAgents = false;
    if ((field === 'allow' || field === 'disallow') && current) {
      // An empty Disallow means "allow everything"; skip it as a rule.
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }

  // The most specific matching group wins; `*` is the fallback.
  const matching = groups.find((group) => group.agents.includes(agentToken)) ??
    groups.find((group) => group.agents.includes('*'));
  if (!matching) return true;

  let best: { allow: boolean; length: number } | null = null;

  for (const rule of matching.rules) {
    if (!robotsPatternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }

  return best ? best.allow : true;
}

/** Matches a robots path pattern, supporting the `*` and `$` wildcards. */
function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

function extractLinks(html: string, base: URL): URL[] {
  const links: URL[] = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const href = match[2] ?? match[3] ?? match[4];
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      links.push(new URL(href, base));
    } catch {
      // Malformed href: ignore it rather than failing the page.
    }
  }

  return links;
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.replace(/\s+/g, ' ').trim();
  return title && title.length > 0 ? title : null;
}

function parseHttpDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Deterministic id so re-crawls update rather than duplicate a document.
 *
 * The encoding is the URL itself, base64url'd, because `fetch` receives only
 * this id and has to recover the URL from it. It is deliberately *not*
 * truncated: a truncated id cannot be decoded, and an undecodable id turns every
 * later re-ingest into a permanent failure. `text` columns and indexes absorb
 * the extra length, and real-world URLs are far shorter than the 8KB limit.
 */
function stableId(url: URL): string {
  return Buffer.from(url.toString()).toString('base64url');
}

/** Recovers the page URL from the id minted by {@link stableId}. */
function urlFromExternalId(externalId: string): URL {
  let url: URL;
  try {
    url = new URL(Buffer.from(externalId, 'base64url').toString('utf8'));
  } catch (error) {
    throw new ConnectorError(
      `externalId ${JSON.stringify(externalId.slice(0, 40))} is not a website page id`,
      'website',
      error instanceof Error ? error : undefined,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConnectorError(`refusing to fetch a ${url.protocol} URL`, 'website');
  }
  return url;
}
