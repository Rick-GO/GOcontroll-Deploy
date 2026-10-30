// What Deploy keeps of a relation, for the CRM (entrypoint RelationUse, service binding USE_DEPLOY):
// a customer a folder is assigned to is never deleted. Only a count crosses this line.

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import { settingsIndex } from './state';

export async function relationUses(env: Env, id: number): Promise<{ what: string; count: number }[]> {
  const folders = [...(await settingsIndex(env)).values()].filter((s) => s.customer_id === id).length;
  return folders ? [{ what: 'folders', count: folders }] : [];
}

export class RelationUse extends WorkerEntrypoint<Env> {
  uses(id: number) {
    return relationUses(this.env, id);
  }
}
