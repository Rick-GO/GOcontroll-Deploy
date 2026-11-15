// vitest.config.ts runs under Node and reads wrangler.toml with node:fs (test/admin-api.test.ts holds
// its bindings against the backup). The Worker's tsconfig has no Node types, and adding @types/node
// would put Node's globals next to the Workers runtime's; this declares the one function it uses.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
