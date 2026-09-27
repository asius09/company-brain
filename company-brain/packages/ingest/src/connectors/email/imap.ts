import { createLogger, getEnv } from '@company-brain/core';
import type { FetchedResource, ResourceKind } from '../../types';
import { Connector, ListResult, ConnectorError } from '../base';

const log = createLogger('ingest.connector.email.imap');

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_IDLE_TIMEOUT = 60000;

export interface ImapOptions {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  password: string;
}

export interface EmailConnectorOptions {
  imap: ImapOptions;
  deleteAfterProcess?: boolean;
  since?: Date;
  maxEmails?: number;
  idleTimeout?: number;
}

export function createEmailConnector(options: EmailConnectorOptions): Connector {
  const { host, port = DEFAULT_IMAP_PORT, secure = true, user, password } = options.imap;
  const { maxEmails = 50, idleTimeout = DEFAULT_IDLE_TIMEOUT } = options;

  if (!host) {
    throw new ConnectorError('IMAP host is required', 'email');
  }
  if (!user) {
    throw new ConnectorError('Email user is required', 'email');
  }
  if (!password) {
    throw new ConnectorError('Email password is required', 'email');
  }

  return {
    sourceType: 'email' as ResourceKind,
    list: async (): Promise<ListResult> => {
      // Placeholder - real implementation would connect to IMAP server
      return { items: [], nextCursor: undefined };
    },

    async fetch(externalId: string): Promise<FetchedResource> {
      throw new ConnectorError(
        'Email fetch not yet implemented - requires IMAP client library',
        'email',
      );
    },

    close: async () => {
      // Clean up connection
    },
  };
}
