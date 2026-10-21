// Cloudflare Access: application-token (JWT) verification and identity lookup.
//
// Copied from GOcontroll-Finance (src/access.ts), which copies GOcontroll-CRM, itself from
// GOcontroll-Hours (src/access.ts), a TypeScript port of GOcontroll-Team/src/access.js; plus
// extractGroupIds, ported from Team (commit 8ba6f0a: access on Entra object IDs only, never on
// group names). Fix bugs in all five repos. The token in the
// Cf-Access-Jwt-Assertion header is the only source of truth for *who* the user is. It is
// verified here against the team's public keys before any claim is read. Groups and display
// name are not in the token by default, so they come from the team's get-identity endpoint,
// fetched with that same verified token.

const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_FORCED_REFRESH_MIN_MS = 30 * 1000;
const IDENTITY_TTL_MS = 5 * 60 * 1000;
const IDENTITY_CACHE_MAX = 500;

export class AccessError extends Error {}

export interface AccessConfig { teamDomain: string; aud: string }

export interface AccessPayload {
  iss: string;
  aud: string | string[];
  email: string;
  sub?: string;
  exp: number;
  nbf?: number;
  identity_nonce?: string;
  custom?: Record<string, unknown>;
  [claim: string]: unknown;
}

export type Identity = Record<string, any>;

// ── Public keys ──────────────────────────────────────────────────────────────
// Per-isolate cache. An unknown `kid` (key rotation) forces one refetch, at most
// once per JWKS_FORCED_REFRESH_MIN_MS so a stream of forged tokens cannot turn
// into a stream of certs requests.
let jwksCache: { teamDomain: string | null; keys: Map<string, CryptoKey>; fetchedAt: number } = {
  teamDomain: null, keys: new Map(), fetchedAt: 0,
};

/** For tests: forget cached keys. */
export function resetAccessCaches(): void {
  jwksCache = { teamDomain: null, keys: new Map(), fetchedAt: 0 };
  identityCache.clear();
}

async function fetchJwks(teamDomain: string): Promise<void> {
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`, { cache: 'no-store' });
  if (!res.ok) throw new AccessError(`certs fetch failed: HTTP ${res.status}`);
  const { keys = [] } = await res.json<{ keys?: (JsonWebKey & { kid?: string })[] }>();
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    imported.set(jwk.kid, key);
  }
  jwksCache = { teamDomain, keys: imported, fetchedAt: Date.now() };
}

async function getKey(teamDomain: string, kid: string): Promise<CryptoKey | undefined> {
  const age = Date.now() - jwksCache.fetchedAt;
  if (jwksCache.teamDomain !== teamDomain || age > JWKS_TTL_MS) {
    await fetchJwks(teamDomain);
  } else if (!jwksCache.keys.has(kid) && age > JWKS_FORCED_REFRESH_MIN_MS) {
    await fetchJwks(teamDomain);
  }
  return jwksCache.keys.get(kid);
}

// ── JWT ──────────────────────────────────────────────────────────────────────
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodeSegment(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/**
 * Verify a Cloudflare Access application token.
 * Checks: RS256 signature against the team's current keys, `iss` equals the team
 * domain, `aud` contains the application's AUD tag, and `exp`/`nbf` (±60 s).
 * @throws {AccessError} on any failure
 */
export async function verifyAccessJwt(token: string | null | undefined, { teamDomain, aud }: AccessConfig): Promise<AccessPayload> {
  if (!token) throw new AccessError('missing token');
  if (!teamDomain || !aud) throw new AccessError('TEAM_DOMAIN or POLICY_AUD not configured');

  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessError('malformed token');

  let header: { alg?: string; kid?: string };
  let payload: AccessPayload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    throw new AccessError('malformed token');
  }
  if (header.alg !== 'RS256') throw new AccessError(`unexpected alg ${header.alg}`);

  const key = await getKey(teamDomain, String(header.kid ?? ''));
  if (!key) throw new AccessError('unknown signing key');

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AccessError('bad signature');

  const now = Date.now() / 1000;
  if (payload.iss !== teamDomain) throw new AccessError('wrong issuer');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new AccessError('wrong audience');
  if (typeof payload.exp !== 'number' || now > payload.exp + CLOCK_SKEW_S) throw new AccessError('expired');
  if (typeof payload.nbf === 'number' && now < payload.nbf - CLOCK_SKEW_S) throw new AccessError('not yet valid');
  if (!payload.email) throw new AccessError('token has no email');

  return payload;
}

// ── Identity (groups, name) ──────────────────────────────────────────────────
const identityCache = new Map<string, { identity: Identity; expires: number }>();

/**
 * Fetch the user's full identity from the team's get-identity endpoint, cached per
 * `identity_nonce` (Access's own cache key for this). Only call with a token that
 * verifyAccessJwt accepted. Returns null when the lookup fails; callers then treat
 * the user as having no groups, so admin rights are withheld (fail closed).
 */
export async function getIdentity(token: string, payload: AccessPayload, { teamDomain }: Pick<AccessConfig, 'teamDomain'>): Promise<Identity | null> {
  const cacheKey = payload.identity_nonce || payload.sub;
  const hit = cacheKey ? identityCache.get(cacheKey) : undefined;
  if (hit && hit.expires > Date.now()) return hit.identity;

  let identity: Identity | null = null;
  try {
    const res = await fetch(`${teamDomain}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${token}` },
      cache: 'no-store',
    });
    if (res.ok) identity = await res.json();
    else console.warn(`get-identity: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`get-identity: ${(err as Error).message}`);
  }

  if (identity && cacheKey) {
    if (identityCache.size >= IDENTITY_CACHE_MAX) identityCache.delete(identityCache.keys().next().value!);
    identityCache.set(cacheKey, { identity, expires: Date.now() + IDENTITY_TTL_MS });
  }
  return identity;
}

/**
 * Normalise groups from wherever the IdP put them into a flat list of strings.
 * Entra ID groups arrive as objects ({ id, name, … }); both the object ID and the
 * display name are kept, so config may list either. Object IDs are preferred in
 * config because display names can be renamed.
 */
export function extractGroups(...sources: (Identity | AccessPayload | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const src of sources) {
    const lists = [src?.groups, src?.custom?.groups, src?.idp?.groups];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const g of list) {
        if (typeof g === 'string') out.add(g);
        else if (g && typeof g === 'object') {
          if (g.id) out.add(String(g.id));
          if (g.name) out.add(String(g.name));
        }
      }
    }
  }
  return [...out];
}

/**
 * Only the object IDs of the user's Entra groups: what access may be decided on. Display
 * names and bare strings (which may be names) never count: any employee can create a
 * Microsoft 365 group with any name, including another group's object ID.
 */
export function extractGroupIds(...sources: (Identity | AccessPayload | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const src of sources) {
    const lists = [src?.groups, src?.custom?.groups, src?.idp?.groups];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const g of list) if (g && typeof g === 'object' && g.id) out.add(String(g.id));
    }
  }
  return [...out];
}

/** Display name from identity or token; falls back to the email address. */
export function extractName(payload: AccessPayload, identity: Identity | null): string {
  return identity?.name || identity?.custom?.name || (payload.custom?.name as string | undefined) || payload.email;
}

/** Entra object ID, when the IdP passes it on (claim `oid`); otherwise null. */
export function extractOid(payload: AccessPayload, identity: Identity | null): string | null {
  const oid = identity?.oid ?? identity?.custom?.oid ?? identity?.idp_claims?.oid ?? payload.custom?.oid;
  return typeof oid === 'string' && oid ? oid : null;
}
