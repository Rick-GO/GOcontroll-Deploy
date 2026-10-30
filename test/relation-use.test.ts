// What the CRM may know before it deletes a relation: a count of folders, nothing else.

import { expect, test } from 'vitest';
import { env } from 'cloudflare:test';
import { relationUses } from '../src/relation-use';

test('folders assigned to the customer are counted; none means no use', async () => {
  expect(await relationUses(env, 7)).toEqual([]);
  await env.STATE.put('folders/app-one.json', JSON.stringify({ customer_id: 7 }));
  await env.STATE.put('folders/app-two.json', JSON.stringify({ customer_id: 8 }));
  expect(await relationUses(env, 7)).toEqual([{ what: 'folders', count: 1 }]);
  await env.STATE.delete(['folders/app-one.json', 'folders/app-two.json']);
});
