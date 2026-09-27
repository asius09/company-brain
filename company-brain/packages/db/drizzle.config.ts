import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: ['../../.env', '../../.env.local', '.env', '.env.local'] });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit commands');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
