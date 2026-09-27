import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Importing this guarantees the repository .env has been loaded and validated
// before any connection is opened.
import { getEnv } from '@company-brain/core/config/env';

// Resolved from this file's location so the script behaves the same whether it
// is run from the repo root, the package, or via `pnpm --filter`.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');

const migrationsFolder = join(repoRoot, 'packages/db/drizzle');

async function main() {
  const { DIRECT_URL, DATABASE_URL } = getEnv();
  const url = DIRECT_URL ?? DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL or DIRECT_URL is required (see .env.example)');
  }

  // `max: 1` — migrations must run serially on a single connection.
  const client = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await migrate(drizzle(client), { migrationsFolder });

    const applied = await client<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `;
    const count = applied[0]?.count ?? 0;

    const files = (await readdir(migrationsFolder)).filter((f) => f.endsWith('.sql')).sort();

    // Drizzle's migrator applies migrations listed in `meta/_journal.json` and
    // ignores every other `.sql` file in the folder — silently, and still
    // printing a success line. A hand-written migration that never made it into
    // the journal would look applied while changing nothing, so make it a hard
    // failure instead of a warning somebody scrolls past.
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const journalTags = new Set(journal.entries.map((entry) => entry.tag));
    const orphaned = files.filter((file) => !journalTags.has(file.replace(/\.sql$/, '')));

    console.log(`✓ Migrations applied — ${count} recorded, latest: ${files.at(-1) ?? 'none'}`);

    if (orphaned.length > 0) {
      console.error(
        `\n✗ ${orphaned.length} migration file(s) are missing from meta/_journal.json and were NOT applied:\n${orphaned
          .map((f) => `    ${f}`)
          .join('\n')}\n\nDrizzle only runs journalled migrations. Regenerate it with:\n    pnpm --filter @company-brain/db exec drizzle-kit generate\nor delete the orphaned file(s).\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (count < files.length) {
      console.warn(`  ⚠ ${files.length - count} migration file(s) are journalled but not recorded`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('\n✗ Migration failed\n');

  // Drizzle wraps driver errors in a `Failed query: <sql>` message. Postgres
  // states the actually-useful part (message, detail, hint, position) on the
  // cause, so surface that instead of a wall of SQL.
  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    const c = cause as { message?: string; detail?: string; hint?: string; position?: string };
    console.error('Postgres:', c.message ?? String(cause));
    if (c.detail) console.error('Detail: ', c.detail);
    if (c.hint) console.error('Hint:   ', c.hint);
    if (c.position) console.error('At:     ', c.position);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }

  console.error(
    '\nIf this is a fresh database, run `pnpm db:reset` to drop and rebuild it.',
  );
  process.exit(1);
});
