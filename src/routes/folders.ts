// The status of the bucket (overview, one folder, downloads) and what is set per folder:
// its customer and its signing key.

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import { manifestKind, readManifest } from '../bucket';
import { loadCustomer } from '../business';
import { loadWindow } from '../downloads';
import { KeyFormatError, generateKey, parsePrivateKey, privateKeyPem, publicKeyHex, scalarB64, type KeyMaterial } from '../keys';
import { HttpError, parse } from '../lib/http';
import { folderParam, s1AppId } from '../lib/validate';
import { downloadDays, folderCustomer, folderDetail, overview } from '../status';
import { audit, loadKey, saveFolderSettings, saveKey, type StoredKey } from '../state';
import { keyFailure, keyVault } from '../vault';

export const folders = new Hono<AppEnv>();

folders.get('/overview', async (c) => c.json(await overview(c.env)));

folders.get('/folders/:appId', async (c) => c.json(await folderDetail(c.env, folderParam(c.req.param('appId')))));

folders.get('/downloads', async (c) => {
  const appId = c.req.query('appId') || undefined;
  if (appId !== undefined) folderParam(appId);
  const days = Number(c.req.query('days') || 30);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'days is a whole number from 1 to 90.', 'days');
  return c.json(downloadDays(await loadWindow(c.env, days), appId));
});

// ── Customer of a folder ─────────────────────────────────────────────────────

const CustomerBody = z.object({
  customerId: z.union([z.number().int().positive(), z.null()], { message: 'Choose a customer, or none.' }),
});

/** A folder exists when the bucket holds something under it, or a key was made for it. */
async function folderExists(env: Env, appId: string): Promise<boolean> {
  if ((await env.DEPLOY_BUCKET.list({ prefix: `${appId}/`, limit: 1 })).objects.length) return true;
  return Boolean(await loadKey(env, appId));
}

folders.put('/folders/:appId/customer', async (c) => {
  const appId = folderParam(c.req.param('appId'));
  const { customerId } = parse(CustomerBody, await c.req.json().catch(() => null));
  if (!(await folderExists(c.env, appId))) throw new HttpError(404, `There is no folder ${appId} in the bucket.`);
  if (customerId !== null && !(await loadCustomer(c.env, customerId))) throw new HttpError(422, 'That customer does not exist.', 'customerId');
  const user = c.get('user');
  await saveFolderSettings(c.env, appId, { customer_id: customerId, updated_at: new Date().toISOString(), updated_by: user.email });
  await audit(c.env, { action: 'assign-customer', app_id: appId, actor: user.email, customer_id: customerId }).catch((err) => console.error('audit', err));
  return c.json({ customer: await folderCustomer(c.env, appId) });
});

// ── Signing key of a folder ──────────────────────────────────────────────────

const keyInfo = (k: StoredKey) => ({ publicKey: k.public_key, source: k.source, createdAt: k.created_at, createdBy: k.created_by });

folders.get('/folders/:appId/key', async (c) => {
  const appId = folderParam(c.req.param('appId'));
  const key = await loadKey(c.env, appId);
  if (!key) throw new HttpError(404, `The folder ${appId} has no signing key.`);
  return c.json(keyInfo(key.value));
});

const KeyBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate'), replace: z.boolean().optional(), confirm: z.string().optional() }),
  z.object({
    action: z.literal('import'),
    privateKey: z.string({ message: 'Paste the private key.' }).trim().min(1, 'Paste the private key.').max(20_000, 'That is too long for a key.'),
    replace: z.boolean().optional(),
    confirm: z.string().optional(),
  }),
], { message: 'Choose generate or import.' });

folders.post('/folders/:appId/key', async (c) => {
  const appId = s1AppId(c.req.param('appId'));
  const body = parse(KeyBody, await c.req.json().catch(() => null));
  const user = c.get('user');

  const manifest = await readManifest(c.env.DEPLOY_BUCKET, appId);
  if (manifestKind(manifest?.doc) === 'linux') {
    throw new HttpError(422, `The folder ${appId} holds Linux releases (go-deploy tarballs); signing keys are for S1 firmware.`);
  }
  const existing = await loadKey(c.env, appId);
  if (existing && !(body.replace === true && body.confirm === appId)) {
    throw new HttpError(409, `The folder ${appId} already has a signing key. Controllers that carry its public key refuse firmware signed with another one; to replace it anyway, confirm with the App ID.`, 'confirm', { publicKey: existing.value.public_key });
  }

  let material: KeyMaterial;
  try {
    material = body.action === 'generate' ? await generateKey() : await parsePrivateKey(body.privateKey);
  } catch (err) {
    if (err instanceof KeyFormatError) throw new HttpError(422, err.message, 'privateKey');
    throw err;
  }
  const publicKey = publicKeyHex(material.publicKey);
  if (existing && existing.value.public_key === publicKey) throw new HttpError(422, 'That is the key this folder already has.', 'privateKey');

  // Seal, and open it again before storing: a key that would not open is never kept.
  const vault = keyVault(c.env.SIGNING_KEYS_KEY);
  let sealed: string;
  try {
    sealed = await vault.seal(material.scalar, appId);
    const back = await vault.unseal(sealed, appId);
    if (back.length !== material.scalar.length || back.some((b, i) => b !== material.scalar[i])) throw new Error('sealed key does not round-trip');
  } catch (err) {
    throw keyFailure(err);
  }

  const source = body.action === 'generate' ? 'generated' : 'imported';
  const stored: StoredKey = {
    app_id: appId, public_key: publicKey, sealed_private_key: sealed, source,
    created_at: new Date().toISOString(), created_by: user.email,
  };
  await saveKey(c.env, appId, stored, existing);
  await audit(c.env, {
    action: existing ? 'key-replace' : body.action === 'generate' ? 'key-generate' : 'key-import',
    app_id: appId, actor: user.email, source, public_key: publicKey,
    ...(existing ? { previous_public_key: existing.value.public_key } : {}),
  }).catch((err) => console.error('audit', err));

  // The only time a private key leaves the Worker: the backup of a key generated here.
  const backup = body.action === 'generate'
    ? { privateKeyB64: scalarB64(material.scalar), privateKeyPem: await privateKeyPem(material) }
    : undefined;
  return c.json({ ...keyInfo(stored), ...(backup ? { backup } : {}) });
});
