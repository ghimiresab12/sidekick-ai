/**
 * Browser stand-in for `node:crypto`, used only because the in-process backend
 * bundles `src/engine.ts`, whose sole Node import is `randomUUID`. The Web Crypto API
 * provides the same function. Wired by the alias in vite.config.ts and the matching
 * `paths` entry in tsconfig.json. Engine code is not modified.
 */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
