/* eslint-disable */
/**
 * Dumps Better Auth's required schema (tables, fields, indexes) as JSON so the
 * hand-written Drizzle definitions in `packages/db/src/schema/auth.ts` can be
 * kept in sync.
 *
 *   pnpm exec tsx scripts/dump-auth-schema.ts > /tmp/auth-schema.json
 *
 * NOTE: pass `auth.options`, not `auth` — the instance has already been
 * reduced by the drizzle adapter's schema check and only reports core tables.
 */
import { getAuthTables } from 'better-auth/db';
import { auth } from '../auth.generate';

const tables = getAuthTables(auth.options as never);

function normaliseType(type: unknown): string {
  if (typeof type === 'string') return type;
  const t = type as { name?: string; namespace?: string };
  if (t?.name) return t.namespace ? `${t.namespace}.${t.name}` : t.name;
  return JSON.stringify(type);
}

const summary = Object.entries(tables).map(([model, def]) => ({
  model,
  fields: Object.fromEntries(
    Object.entries(def.fields).map(([name, f]) => {
      const field = f as unknown as Record<string, unknown>;
      return [
        name,
        {
          type: normaliseType(field.type),
          required: Boolean(field.required),
          unique: Boolean(field.unique),
          defaultValue: field.defaultValue,
          input: field.input !== false,
          reference: field.references,
        },
      ];
    }),
  ),
  indexes: def.tableIndexes ?? [],
}));

console.log(JSON.stringify(summary, null, 2));
