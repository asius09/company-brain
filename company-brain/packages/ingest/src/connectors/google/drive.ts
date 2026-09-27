import { createLogger, getEnv } from '@company-brain/core';
import type { FetchedResource, ResourceKind } from '../../types';
import { ConnectorError, httpFetch, Connector, ListResult } from '../base';

const log = createLogger('ingest.connector.google');

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

export interface GoogleDriveConnectorOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  rootFolderId?: string;
  maxFiles?: number;
}

export function createGoogleDriveConnector(options: GoogleDriveConnectorOptions): Connector {
  const clientId = options.clientId;
  const clientSecret = options.clientSecret;
  const refreshToken = options.refreshToken;
  const rootFolderId = options.rootFolderId ?? 'root';
  const maxFiles = options.maxFiles ?? 100;

  async function ensureAccessToken(): Promise<string> {
    const response = await httpFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!response.ok) throw new Error('Failed to get access token');
    const data = (await response.json()) as any;
    return data.access_token;
  }

  async function listDriveFiles(cursor?: string): Promise<{ files: any[]; nextPageToken: string | undefined }> {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('fields', 'id,name,mimeType,parents,createdTime,modifiedTime,size');
    if (cursor) url.searchParams.set('pageToken', cursor);
    const response = await httpFetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${await ensureAccessToken()}` },
    });
    if (!response.ok) throw new Error('Failed to list Drive files');
    const data = (await response.json()) as any;
    return { files: data.files || [], nextPageToken: data.nextPageToken };
  }

  async function getFileMetadata(fileId: string): Promise<any> {
    const response = await httpFetch(`${DRIVE_API_BASE}/files/${fileId}?fields=id,name,mimeType,parents,createdTime,modifiedTime,size`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${await ensureAccessToken()}` },
    });
    if (!response.ok) throw new Error('Failed to get file metadata');
    const data = (await response.json()) as any;
    return data;
  }

  return {
    sourceType: 'google-drive' as ResourceKind,
    list: async (): Promise<ListResult> => {
      const token = await ensureAccessToken();
      let cursor: string | undefined = undefined;
      let allItems: FetchedResource[] = [];
      let filesProcessed = 0;

      while (filesProcessed < maxFiles) {
        const { files, nextPageToken } = await listDriveFiles(cursor);
        for (const file of files) {
          const mimeType = file.mimeType ?? '';
          const isSupported = ['application/vnd.google-apps.document',
            'application/vnd.google-apps.spreadsheet',
            'application/vnd.google-apps.presentation',
            'application/vnd.google-apps.folder'].some(t => t.includes(mimeType ?? ''));

          if (!isSupported) continue;

          const title = file.name ?? `File ${file.id.slice(0, 8)}`;
          const uri = `drive://${file.id}`;
          allItems.push({
            externalId: file.id,
            uri,
            title,
            contentType: mimeType ?? 'application/octet-stream',
            kind: 'file' as ResourceKind,
            body: extractTextFromDriveFile(file),
            version: file.modifiedTime,
            metadata: {
              id: file.id,
              parents: file.parents ?? [],
              createdTime: file.createdTime,
              modifiedTime: file.modifiedTime,
              size: file.size ?? undefined,
            },
          });
          filesProcessed++;
          if (filesProcessed >= maxFiles) break;
        }
        const nextPageResp = await listDriveFiles(undefined);
        if (!nextPageResp.nextPageToken) break;
        cursor = nextPageResp.nextPageToken;
      }

      return { items: allItems, nextCursor: cursor };
    },

    async fetch(externalId: string): Promise<FetchedResource> {
      const fileId = externalId;
      const metadata = await getFileMetadata(fileId);
      const title = metadata.name ?? `File ${fileId.slice(0, 8)}`;
      const mimeType = metadata.mimeType ?? 'application/octet-stream';
      return {
        externalId: fileId,
        uri: `drive://${fileId}`,
        title,
        contentType: mimeType,
        kind: 'file' as ResourceKind,
        body: extractTextFromDriveFile(metadata),
        version: metadata.modifiedTime,
        metadata: {
          id: metadata.id,
          parents: metadata.parents ?? [],
          createdTime: metadata.createdTime,
          modifiedTime: metadata.modifiedTime,
          size: metadata.size ?? undefined,
        },
      };
    },

    close: async () => { },
  };
}

function extractTextFromDriveFile(file: any): string {
  const mimeType = file.mimeType ?? '';
  if (mimeType === 'application/vnd.google-apps.document') {
    return file.name ?? '';
  }
  return file.name ?? '';
}
