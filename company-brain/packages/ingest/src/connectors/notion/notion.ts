import { createLogger, getEnv } from '@company-brain/core';
import type { FetchedResource } from '../../types';
import { Connector } from '../base';

const NOTION_API_BASE = 'https://api.notion.com/v1';

export interface NotionConnectorOptions {
  authToken: string;
  rootPageId?: string;
  maxPages?: number;
}

const NOTION_DOC_ID_REGEX = /^[0-9a-f]{32}$/;

function extractTextFromBlock(block: any): string {
  const type = block.type;
  const hasRichText = 'rich_text' in block;
  const hasChildren = 'children' in block;

  if (!hasRichText && !hasChildren) return '';

  let textParts: string[] = [];

  if (hasRichText && block[type]?.rich_text) {
    for (const item of block[type]?.rich_text as any[]) {
      if (item.type === 'text') {
        textParts.push(item.plain_text ?? '');
      } else if (item.type === 'mention') {
        if ('annotation' in item && item.annotation?.text) {
          textParts.push(item.annotation.text);
        }
      }
    }
  }

  if (hasChildren && block[type]?.children) {
    for (const child of block[type]?.children as any[]) {
      textParts.push(extractTextFromBlock(child));
    }
  }

  return textParts.join('\n');
}

function extractPageTitle(page: any): string | null {
  const titleProperty = page.properties?.['Name'];
  if (!titleProperty || !titleProperty.title?.length) return null;

  const firstTitle = titleProperty.title[0];
  if (firstTitle.type === 'text') {
    return firstTitle.plain_text ?? null;
  }
  return null;
}

function checkNotionResponse(response: Response): Response {
  if (!response.ok) {
    throw new Error(`Notion API error ${response.status}: ${response.statusText}`);
  }
  return response;
}

export function createNotionConnector(): Connector {
  return {
    sourceType: 'notion',
    list: async () => {
      const headers: Record<string, string> = {
        'Authorization': 'Bearer placeholder-token',
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      };

      let cursor: string | undefined = undefined;
      let allItems: any[] = [];
      let pagesProcessed = 0;

      while (pagesProcessed < 50) {
        const query: any = {
          cursor,
          page_size: 100,
          sorts: [{ direction: 'asc', timestamp: 'last_edited_time' }],
        };

        const response = await fetch(
          `${NOTION_API_BASE}/databases/query`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(query),
          });

        if (!response.ok) throw new Error('Notion API error');

        const data: any = await response.json;
        const results = data.results || [];
        if (results.length === 0) break;

        for (const page of results) {
          const pageId = page.id;
          const title = `Notion Page ${pageId.slice(0, 8)}`;

          const hasTextChildren = page.children?.some(
            (child: any) =>
              'rich_text' in child.type ||
              (child.type === 'paragraph' ||
                child.type === 'heading_1' ||
                child.type === 'heading_2')
          );

          if (!hasTextChildren) continue;

          const uri = `notion://${pageId}`;
          const textContent = extractTextFromBlock(page).substring(0, 10000);

          allItems.push({
            externalId: pageId,
            uri,
            title: title,
            contentType: 'notion',
            body: textContent.substring(0, 10000),
            version: page.last_edited_time,
            metadata: {
              lastEdited: page.last_edited_time,
              created: page.created_time,
              hasChildren: page.has_children,
            },
          });

          pagesProcessed++;
        }

        if (pagesProcessed >= 50) break;
      }

      return { items: allItems, nextCursor: undefined };
    },

    async fetch(externalId: string): Promise<FetchedResource> {
      const pageId = externalId;
      const response = await fetch(
        `${NOTION_API_BASE}/pages/${pageId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer placeholder-token',
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
        });
        if (!response.ok) throw new Error('Notion API error');
        const data: any = await response.json;

        const titleProperty = data.properties?.['Name'];
        const title = titleProperty?.title?.[0]?.plain_text ?? `Notion Page ${pageId.slice(0, 8)}`;

        const textContent = extractTextFromBlock(data).substring(0, 10000);

        return {
          externalId: pageId,
          uri: `notion://${pageId}`,
          title,
          contentType: 'notion',
          kind: 'text' as const,
          body: textContent.substring(0, 10000),
          version: data.last_edited_time,
          metadata: {
            lastEdited: data.last_edited_time,
            created: data.created_time,
            hasChildren: data.has_children,
          },
        };
    },
  };
}