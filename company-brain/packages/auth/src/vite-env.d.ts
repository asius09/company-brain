/**
 * The browser client is only ever bundled by Vite, but this package is type
 * checked with the Node config (so `server.ts` and `client.ts` share one
 * tsconfig). Declaring the two shapes we use keeps `import.meta.env` typed here
 * without pulling Vite's ambient types into the service build.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
