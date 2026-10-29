// Who is making this request, and may they use Deploy?
//
// Adapted from GOcontroll-Logistic (src/auth.ts). Access decides who may open the app (policy
// on an Entra group). The Worker checks the group as well: a valid token without one of
// DEPLOY_GROUPS is refused, so an Access policy that is too wide never lets anyone publish
// firmware to the controllers in the field or change an application's public key. Only the group's object ID
// counts, never its display name: any employee can create a Microsoft 365 group with any name
// (as on Team since its commit 8ba6f0a). An empty DEPLOY_GROUPS lets nobody in, and so does a
// failed group lookup (fail closed). There is no in-app admin role.

import { AccessError, verifyAccessJwt, getIdentity, extractGroupIds, extractGroups, extractName } from './access';
import type { Env, User } from './env';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Entra names here look like "Rick Gijsberts | GOcontroll"; the app already says
 * GOcontroll, so drop the suffix (same as the hub, gocontroll.tools).
 */
export function cleanDisplayName(name: string, email: string): string {
  return (name || '').split('|')[0].trim() || email;
}

export function configList(value: string | undefined): string[] {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** True when one of the user's group object IDs is in DEPLOY_GROUPS; case-insensitive. */
export function isDeployMember(groupIds: string[], allowed: string | undefined): boolean {
  const mine = new Set(groupIds.map((g) => g.toLowerCase()));
  return configList(allowed).some((g) => mine.has(g.toLowerCase()));
}

/**
 * Resolve the signed-in user for this request, or throw AccessError.
 * Production: verified Cf-Access-Jwt-Assertion + get-identity for name/groups.
 * The email comes only from the verified payload, never from a plain header.
 * Local dev: DEV_USER_EMAIL from .dev.vars, honoured only on a localhost URL; its
 * DEV_USER_GROUPS stand in for object IDs.
 * Either way one of the user's group object IDs must be in DEPLOY_GROUPS.
 */
export async function authenticate(request: Request, env: Env): Promise<User> {
  const user = await identify(request, env);
  if (!isDeployMember(user.groupIds, env.DEPLOY_GROUPS)) throw new AccessError(`${user.email} is not in DEPLOY_GROUPS`);
  return user;
}

async function identify(request: Request, env: Env): Promise<User> {
  const url = new URL(request.url);
  if (env.DEV_USER_EMAIL && LOCAL_HOSTS.has(url.hostname)) {
    const email = env.DEV_USER_EMAIL.toLowerCase();
    const groups = configList(env.DEV_USER_GROUPS);
    return { email, name: cleanDisplayName(env.DEV_USER_NAME || '', email), groups, groupIds: groups };
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const config = { teamDomain: env.TEAM_DOMAIN, aud: env.POLICY_AUD };
  const payload = await verifyAccessJwt(token, config);
  const identity = await getIdentity(token!, payload, config);
  const email = payload.email.toLowerCase();
  return {
    email,
    name: cleanDisplayName(extractName(payload, identity), email),
    groups: extractGroups(payload, identity),
    groupIds: extractGroupIds(payload, identity),
  };
}
