import { createLogger } from '@company-brain/core';
import type { Connector } from '@company-brain/ingest';
import { createWebsiteConnector } from '@company-brain/ingest';
import { PermanentJobError } from '@company-brain/queue';
import type { Source, SourceConfig } from './types';

const log = createLogger('worker.connectors');

/**
 * Builds a live connector for a source row.
 *
 * A source type with no implementation throws `PermanentJobError` rather than a
 * plain `Error`: the queue retries ordinary errors until the attempt budget is
 * gone, and retrying a missing implementation just burns that budget slowly.
 */
export function buildConnector(source: Source): Connector {
  const config = (source.config ?? {}) as SourceConfig;

  switch (source.type) {
    case 'website':
    case 'url':
      return websiteConnector(source, config);

    case 'github':
    case 'notion':
    case 'confluence':
    case 'slack':
    case 'gdrive':
    case 's3':
      // Explicit rather than silently wrong: an unimplemented connector that
      // returns no items would look like a source that legitimately has no
      // content, and the org would never notice its docs are missing.
      log.error('connector.unimplemented', 'this source type has no connector yet', {
        sourceId: source.id,
        type: source.type,
      });
      throw new PermanentJobError(
        `source type "${source.type}" is not implemented yet; connect it once an adapter lands`,
      );

    case 'text':
    case 'file':
      // Inline text and uploaded files have no origin to crawl: the body arrives
      // with the request and is chunked by the API path, not by a worker. A sync
      // job for one of these means something upstream is confused.
      throw new PermanentJobError(
        `source type "${source.type}" has no crawlable content; re-upload the file instead of syncing`,
      );

    default: {
      const exhaustive: never = source.type;
      throw new PermanentJobError(`unhandled source type "${String(exhaustive)}"`);
    }
  }
}

function websiteConnector(source: Source, config: SourceConfig): Connector {
  const rootUrl = config.startUrls?.[0];
  if (!rootUrl) {
    throw new PermanentJobError(`website source ${source.id} has no startUrls entry configured`);
  }

  // The crawler honours path prefixes, not regexes. Saying so is better than
  // accepting an `excludePatterns` the operator believes is being applied.
  if (config.excludePatterns?.length || config.includePatterns?.length) {
    log.warn(
      'connector.unsupported_config',
      'include/exclude patterns are not supported by the website crawler and were ignored',
      { sourceId: source.id },
    );
  }

  return createWebsiteConnector({
    rootUrl,
    excludePrefixes: config.excludePaths,
    maxPages: config.maxPages,
    maxDepth: config.maxDepth,
  });
}
