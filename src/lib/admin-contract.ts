// Admin contract 1: what an app gives the hub's admin Worker (gocontroll-admin) through its RPC
// entrypoint AdminApi. Spec: GOcontroll-Architecture/cloudflare/admin-api/spec.md.
//
// CANONICAL COPY: GOcontroll-Team/admin/contract/admin-contract.ts. Every app has a copy at
// src/lib/admin-contract.ts (.js with the types stripped in the plain-JS apps), like access.js.
// A fix here belongs in all copies. Do not add app-specific code to this file.
//
// The admin Worker binds no database or bucket of an app. Each app decides here what leaves it:
// the tools it offers to the MCP connector and the data it hands to the backup.

export const ADMIN_CONTRACT = 1;

/** Who is asking: the CF_Admin behind the connector or the export, as the admin Worker verified them. */
export interface AdminActor {
  email: string;
  name: string;
  /** The connected client, e.g. "Claude", or "hub" for an export. */
  client: string;
}

export type JsonSchema = Record<string, unknown>;

export interface AdminTool<E> {
  /** snake_case, unique in the app, without the domain prefix: the connector adds `<domain>_`. */
  name: string;
  title: string;
  /** For the model: what it returns and when to use it, in English. */
  description: string;
  /** JSON Schema of type object. Absent: the tool takes no arguments. */
  input?: JsonSchema;
  /** `action` changes something or costs money; everything else is `read`. */
  kind: 'read' | 'action';
  run(env: E, args: Record<string, any>, actor: AdminActor): Promise<unknown>;
}

/** What an expected failure throws: the message reaches the model. Anything else becomes "The request failed." */
export class AdminError extends Error {}

export function describeTools<E>(tools: AdminTool<E>[]) {
  return tools.map(({ name, title, description, input, kind }) => ({
    name, title, description, kind, input: input ?? { type: 'object', properties: {}, additionalProperties: false },
  }));
}

/** Check `args` against a tool's schema: types, required, enum, bounds, no unknown properties. */
export function validateArgs(schema: JsonSchema | undefined, args: unknown): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be an object.';
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  for (const key of (schema?.required ?? []) as string[]) {
    if ((args as Record<string, unknown>)[key] === undefined) return `${key} is required.`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!prop) return `Unknown argument: ${key}.`;
    if (value === null) return `${key} may not be null.`;
    const type = prop.type;
    if (type === 'integer' && !Number.isInteger(value)) return `${key} must be a whole number.`;
    if (type === 'number' && typeof value !== 'number') return `${key} must be a number.`;
    if (type === 'string' && typeof value !== 'string') return `${key} must be text.`;
    if (type === 'boolean' && typeof value !== 'boolean') return `${key} must be true or false.`;
    if (type === 'array' && !Array.isArray(value)) return `${key} must be a list.`;
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return `${key} must be one of: ${prop.enum.join(', ')}.`;
    if (typeof prop.minimum === 'number' && (value as number) < prop.minimum) return `${key} must be at least ${prop.minimum}.`;
    if (typeof prop.maximum === 'number' && (value as number) > prop.maximum) return `${key} must be at most ${prop.maximum}.`;
    if (typeof prop.maxLength === 'number' && String(value).length > prop.maxLength) return `${key} is too long.`;
    if (typeof prop.pattern === 'string' && !new RegExp(prop.pattern).test(String(value))) return `${key} has the wrong format.`;
  }
  return null;
}

/** Run one tool. Returns the tool's value, or `{ error }`: never a stack trace or an SQL message. */
export async function runTool<E>(
  tools: AdminTool<E>[], env: E, name: string, args: unknown, actor: AdminActor,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: `Unknown tool: ${name}.` };
  const invalid = validateArgs(tool.input, args ?? {});
  if (invalid) return { error: invalid };
  try {
    return await tool.run(env, (args ?? {}) as Record<string, any>, actor);
  } catch (err) {
    if (err instanceof AdminError) return { error: err.message };
    console.error(`admin tool ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return { error: 'The request failed.' };
  }
}

// ── Argument helpers ────────────────────────────────────────────────────────────────────────
export const LIMIT_ARG = {
  type: 'integer', minimum: 1, maximum: 200, description: 'Most rows to return. Default 50.',
};
export const FROM_ARG = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day, YYYY-MM-DD.' };
export const TO_ARG = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day, YYYY-MM-DD.' };

export const limitOf = (args: Record<string, any>, dflt = 50): number => Math.min(args.limit ?? dflt, 200);

/** The day range of a tool, defaulting to the last `days` days up to today (UTC). */
export function rangeOf(args: Record<string, any>, days = 7, today = new Date()): { from: string; to: string } {
  const to = args.to ?? today.toISOString().slice(0, 10);
  const from = args.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  if (from > to) throw new AdminError('from must not be after to.');
  return { from, to };
}

// ── Backup ──────────────────────────────────────────────────────────────────────────────────
/** A database's part of a scope. */
export interface ExportDatabase {
  /** D1 database name, the folder in the zip. */
  name: string;
  db: D1Database;
  /**
   * Which tables and views belong to this scope. A table in no scope of any app is lost from the
   * backup. In a database shared by scopes, a view must be in exactly one of them.
   */
  include(table: string): boolean;
  /**
   * Columns that do not leave the app: table → column → what the backup writes instead (null for
   * NULL, '' for a NOT NULL text column). Named in the manifest. For live tokens and plaintext
   * credentials; a value encrypted with a key outside the backup stays in, or it could not be restored.
   */
  redact?: Record<string, Record<string, string | number | null>>;
  /** Tables left out on purpose, with the reason for the manifest: tokens, caches. */
  skip?: Record<string, string>;
}

/** A place with files. An R2 bucket fits as it is; KV goes through an adapter. */
export interface FileStore {
  list(options: { cursor?: string; limit?: number; prefix?: string }): Promise<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
}

export interface ExportStore {
  /** Bucket name, the folder in the zip. */
  name: string;
  store: FileStore;
  /** Prefixes left out on purpose, with the reason for the manifest. */
  skip?: Record<string, string>;
}

export interface ExportScope {
  databases: ExportDatabase[];
  stores?: ExportStore[];
  /** Data of this scope that stays out as a whole (a bucket, a store), with the reason. */
  skipped?: { what: string; reason: string }[];
}

interface TableInfo { name: string; columns: string[]; redacted: string[]; rowid: boolean; rows: number }

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Tables that are D1's or SQLite's own; a dump of them cannot be restored. */
const systemTable = (name: string) => name.startsWith('sqlite_') || name.startsWith('_cf_');

async function tablesOf(part: ExportDatabase): Promise<{ table: string; sql: string; virtual: boolean }[]> {
  const { results } = await part.db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY rowid`,
  ).all<{ name: string; sql: string }>();
  const shadow = await part.db.prepare(`SELECT name, type FROM pragma_table_list WHERE schema = 'main'`)
    .all<{ name: string; type: string }>();
  const shadows = new Set(shadow.results.filter((r) => r.type === 'shadow').map((r) => r.name));
  return results
    .filter((r) => !systemTable(r.name) && !shadows.has(r.name) && part.include(r.name) && !part.skip?.[r.name])
    .map((r) => ({ table: r.name, sql: r.sql, virtual: /^\s*CREATE\s+VIRTUAL\s/i.test(r.sql) }));
}

async function columnsOf(part: ExportDatabase, name: string): Promise<string[]> {
  const { results } = await part.db.prepare(`SELECT name FROM pragma_table_info(?1)`).bind(name).all<{ name: string }>();
  return results.map((r) => r.name);
}

const hasRowid = (sql: string) => !/\)\s*(STRICT\s*,\s*)?WITHOUT\s+ROWID/i.test(sql);

async function tableInfo(part: ExportDatabase, name: string, sql: string): Promise<TableInfo> {
  const count = await part.db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).first<{ n: number }>();
  return {
    name, columns: await columnsOf(part, name), redacted: Object.keys(part.redact?.[name] ?? {}),
    rowid: hasRowid(sql), rows: count?.n ?? 0,
  };
}

/** Plan of a scope: the schema, the tables and the files, without a single row of data. */
export async function exportPlan(scope: ExportScope, includeFiles: boolean) {
  const databases = [];
  const skipped = [...(scope.skipped ?? [])];
  for (const part of scope.databases) {
    const listed = await tablesOf(part);
    const tables: TableInfo[] = [];
    for (const t of listed.filter((l) => !l.virtual)) tables.push(await tableInfo(part, t.table, t.sql));
    const names = new Set(tables.map((t) => t.name));
    const { results } = await part.db.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'view', 'trigger') AND sql IS NOT NULL ORDER BY rowid`,
    ).all<{ type: string; name: string; tbl_name: string; sql: string }>();
    for (const [what, reason] of Object.entries(part.skip ?? {})) skipped.push({ what: `${part.name}.${what}`, reason });
    for (const t of listed.filter((l) => l.virtual)) {
      skipped.push({ what: `${part.name}.${t.table}`, reason: 'Search index: schema only, rebuild it after a restore.' });
    }
    for (const t of tables) {
      if (t.redacted.length) skipped.push({ what: `${part.name}.${t.name}: ${t.redacted.join(', ')}`, reason: 'Credentials: blanked in the backup.' });
    }
    databases.push({
      name: part.name,
      schema: listed.map((t) => t.sql),
      // A view belongs to the scope that includes its name, and so do the triggers on it.
      after: results.filter((r) => names.has(r.tbl_name) || (r.type !== 'index' && part.include(r.tbl_name))).map((r) => r.sql),
      tables,
    });
  }
  const stores = [];
  for (const entry of (includeFiles ? scope.stores ?? [] : [])) {
    let cursor: string | undefined;
    let files = 0;
    let bytes = 0;
    do {
      const page = await entry.store.list({ cursor, limit: 1000 });
      for (const o of page.objects) {
        if (skippedKey(entry, o.key)) continue;
        files += 1;
        bytes += o.size;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (const [prefix, reason] of Object.entries(entry.skip ?? {})) skipped.push({ what: `${entry.name}/${prefix}`, reason });
    stores.push({ name: entry.name, files, bytes });
  }
  if (!includeFiles) for (const entry of scope.stores ?? []) skipped.push({ what: entry.name, reason: 'Stored files were not selected for this export.' });
  return { databases, stores, skipped };
}

function partOf(scope: ExportScope, database: string): ExportDatabase {
  const part = scope.databases.find((d) => d.name === database);
  if (!part) throw new AdminError(`Unknown database: ${database}.`);
  return part;
}

/**
 * One page of a table, as arrays in the order of `columns`, with redacted columns already replaced.
 * `after` is the cursor of the previous page (null for the first). The table and its columns come
 * from the database itself, never from the caller.
 */
export async function exportRows(scope: ExportScope, database: string, table: string, after: number | null, limit: number) {
  const part = partOf(scope, database);
  const listed = (await tablesOf(part)).find((t) => t.table === table && !t.virtual);
  if (!listed) throw new AdminError(`Unknown table: ${table}.`);
  const columns = await columnsOf(part, table);
  const rowid = hasRowid(listed.sql);
  const replace = part.redact?.[table] ?? {};
  const select = columns.map((c) => (c in replace ? 'NULL' : quote(c))).join(', ');
  const size = Math.min(Math.max(limit, 1), 1000);
  const start = after ?? 0;
  // Without a rowid the page is an offset, so the order must be complete: every column.
  const order = columns.map(quote).join(', ');
  const rows = rowid
    ? await part.db.prepare(`SELECT rowid, ${select} FROM ${quote(table)} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`).bind(after ?? Number.MIN_SAFE_INTEGER, size).raw()
    : await part.db.prepare(`SELECT 0, ${select} FROM ${quote(table)} ORDER BY ${order} LIMIT ?1 OFFSET ?2`).bind(size, start).raw();
  const cells = rows.map((row) => columns.map((c, i) => (c in replace ? replace[c] : row[i + 1])));
  const last = rows.length === size ? (rowid ? (rows[rows.length - 1][0] as number) : start + size) : null;
  return { rows: cells, rowids: rowid ? rows.map((r) => r[0] as number) : null, after: last };
}

function skippedKey(entry: ExportStore, key: string): boolean {
  return Object.keys(entry.skip ?? {}).some((prefix) => key.startsWith(prefix));
}

function storeOf(scope: ExportScope, name: string): ExportStore {
  const entry = (scope.stores ?? []).find((s) => s.name === name);
  if (!entry) throw new AdminError(`Unknown store: ${name}.`);
  return entry;
}

/** One page of a store's files, without the prefixes it leaves out. */
export async function exportFiles(scope: ExportScope, name: string, cursor: string | null) {
  const entry = storeOf(scope, name);
  const page = await entry.store.list({ cursor: cursor ?? undefined, limit: 1000 });
  return {
    files: page.objects.filter((o) => !skippedKey(entry, o.key)).map((o) => ({ key: o.key, size: o.size })),
    cursor: page.truncated ? page.cursor ?? null : null,
  };
}

/** One file as a byte stream. */
export async function exportFile(scope: ExportScope, name: string, key: string): Promise<ReadableStream> {
  const entry = storeOf(scope, name);
  if (skippedKey(entry, key)) throw new AdminError(`Not part of the backup: ${key}.`);
  const object = await entry.store.get(key);
  if (!object) throw new AdminError(`File is gone: ${key}.`);
  return object.body;
}
