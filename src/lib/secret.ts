// Secrets from the account's Secrets Store (default_secrets_store), the one place the keys of
// the intranet Workers live (GOcontroll-Team/CLAUDE.md, "Geheimen: alleen in de Secrets Store").
// A binding ([[secrets_store_secrets]] in wrangler.toml) is read with get(); locally and in
// tests the same name can hold a plain string (.dev.vars, vitest bindings).
//
// readSecret() throws when the store cannot be read. Callers turn that into a 503 or a retry,
// never into "wrong key": treating an unreadable store as a wrong key would wipe the sealed
// Exact tokens. secretConfigured() swallows the error and is only for "is this on?".
// Read a secret once per request or job, not per use.

/** A Secrets Store binding, or a plain string (.dev.vars, tests). */
export type SecretSource = SecretsStoreSecret | string | undefined | null;

/** The value, or undefined when it is not set. Throws when the store cannot be read. */
export async function readSecret(source: SecretSource): Promise<string | undefined> {
  if (source == null) return undefined;
  if (typeof source === 'string') return source || undefined;
  return (await source.get()) || undefined;
}

/** Whether a value is set; a store that cannot be read counts as not set. Only for "is this on?". */
export async function secretConfigured(source: SecretSource): Promise<boolean> {
  try {
    return Boolean(await readSecret(source));
  } catch {
    return false;
  }
}
