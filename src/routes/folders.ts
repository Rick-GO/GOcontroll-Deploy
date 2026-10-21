// The status of the bucket (overview, one folder, downloads, keys) and what is set per
// folder: a new folder, its settings (customer, controller), its signing key, and the
// protected delete.

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import { distributionUrls, manifestKind, readManifest } from '../bucket';
import { loadCustomer } from '../business';
import { deleteFolder, deleteUnderWay } from '../delete';
import { loadWindow } from '../downloads';
import { KeyFormatError, generateKey, parsePrivateKey, privateKeyPem, publicKeyHex, scalarB64, type KeyMaterial } from '../keys';
import { HttpError, parse } from '../lib/http';
import { folderParam, s1AppId } from '../lib/validate';
import { downloadDays, folderDetail, folderIdentity, keysList, overview } from '../status';
import {
  CONTROLLER_TYPES, audit, loadFolderSettingsVersioned, loadKey, saveFolderSettings, saveKey,
  type FolderSettings, type StoredKey,
} from '../state';
import { keyFailure, keyVault } from '../vault';

export const folders = new Hono<AppEnv>();

folders.get('/overview', async (c) => c.json(await overview(c.env)));

folders.get('/keys', async (c) => c.json(await keysList(c.env)));

folders.get('/folders/:appId', async (c) => c.json(await folderDetail(c.env, folderParam(c.req.param('appId')))));

folders.get('/downloads', async (c) => {
  const appId = c.req.query('appId') || undefined;
  if (appId !== undefined) folderParam(appId);
  const days = Number(c.req.query('days') || 30);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'days is a whole number from 1 to 90.', 'days');
  return c.json(downloadDays(await loadWindow(c.env, days), appId));
});

/** A folder exists when the bucket holds something under it, a key was made for it, or it has settings. */
async function folderExists(env: Env, appId: string): Promise<boolean> {
  const [objects, key, settings] = await Promise.all([
    env.DEPLOY_BUCKET.list({ prefix: `${appId}/`, limit: 1 }),
    env.STATE.head(`keys/${appId}.json`),
    env.STATE.head(`folders/${appId}.json`),
  ]);
  return objects.objects.length > 0 || Boolean(key) || Boolean(settings);
}

async function checkCustomer(env: Env, customerId: number | null): Promise<void> {
  if (customerId !== null && !(await loadCustomer(env, customerId))) throw new HttpError(422, 'That customer does not exist.', 'customerId');
}

const customerId = z.union([z.number().int().positive(), z.null()], { message: 'Choose a customer, or none.' });
const controller = z.union([z.enum(CONTROLLER_TYPES), z.null()], { message: `Choose one of ${CONTROLLER_TYPES.join(', ')}, or none.` });

// ── New folder ───────────────────────────────────────────────────────────────

const CreateBody = z.object({
  appId: z.string({ message: 'Fill in the App ID.' }),
  customerId: customerId.optional(),
  controller: z.string({ message: 'Choose the controller.' }),
  distributionUrl: z.string().optional(),
});

// An application made here before its first release: only settings in STATE, nothing in the
// bucket yet. Only S1: upload and signing are S1-only.
folders.post('/folders', async (c) => {
  const body = parse(CreateBody, await c.req.json().catch(() => null));
  const appId = s1AppId(body.appId);
  if (!(CONTROLLER_TYPES as readonly string[]).includes(body.controller)) throw new HttpError(400, `Choose one of ${CONTROLLER_TYPES.join(', ')}.`, 'controller');
  if (body.controller !== 'S1') throw new HttpError(422, 'Releases for Linux controllers are not published here.', 'controller');
  const bases = distributionUrls(c.env.DISTRIBUTION_URLS);
  const dist = (body.distributionUrl ?? '').trim().replace(/\/+$/, '') || bases[0];
  if (!dist || !bases.includes(dist)) throw new HttpError(422, `The distribution URL must be one of ${bases.join(', ')}.`, 'distributionUrl');
  if ((await folderExists(c.env, appId)) || (await deleteUnderWay(c.env, appId))) {
    throw new HttpError(409, `${appId} already exists. Open it instead.`, 'appId', { appId });
  }
  await checkCustomer(c.env, body.customerId ?? null);
  const user = c.get('user');
  const now = new Date().toISOString();
  const settings: FolderSettings = {
    customer_id: body.customerId ?? null, controller: 'S1', distribution_url: dist,
    created_at: now, created_by: user.email, updated_at: now, updated_by: user.email,
  };
  if (!(await saveFolderSettings(c.env, appId, settings, 'absent'))) throw new HttpError(409, `${appId} already exists. Open it instead.`, 'appId', { appId });
  await audit(c.env, { action: 'create-folder', app_id: appId, actor: user.email, customer_id: settings.customer_id, controller: 'S1', distribution_url: dist })
    .catch((err) => console.error('audit', err));
  return c.json({ appId }, 201);
});

// ── Settings of a folder ─────────────────────────────────────────────────────

const SettingsBody = z.object({ customerId: customerId.optional(), controller: controller.optional() });

/** Merge into the folder's settings (absent: unchanged, null: back to derived) and answer customer + controller. */
async function updateSettings(env: Env, appId: string, email: string, change: { customerId?: number | null; controller?: FolderSettings['controller'] }) {
  if (!(await folderExists(env, appId))) throw new HttpError(404, `There is no folder ${appId} in the bucket.`);
  if (change.customerId !== undefined) await checkCustomer(env, change.customerId);
  const current = await loadFolderSettingsVersioned(env, appId);
  const next: FolderSettings = {
    ...(current?.value ?? { customer_id: null }),
    ...(change.customerId !== undefined ? { customer_id: change.customerId } : {}),
    ...(change.controller !== undefined ? { controller: change.controller } : {}),
    updated_at: new Date().toISOString(),
    updated_by: email,
  };
  if (!(await saveFolderSettings(env, appId, next, current ? { etag: current.etag } : 'absent'))) {
    throw new HttpError(409, 'The settings of this folder were changed a moment ago. Reload the page.');
  }
  await audit(env, {
    action: 'settings', app_id: appId, actor: email,
    ...(change.customerId !== undefined ? { customer_id: change.customerId } : {}),
    ...(change.controller !== undefined ? { controller: change.controller } : {}),
  }).catch((err) => console.error('audit', err));
  return folderIdentity(env, appId);
}

folders.put('/folders/:appId/settings', async (c) => {
  const appId = folderParam(c.req.param('appId'));
  const change = parse(SettingsBody, await c.req.json().catch(() => null));
  return c.json(await updateSettings(c.env, appId, c.get('user').email, change));
});

// The customer alone (the API of milestone 1): same as settings with customerId only.
folders.put('/folders/:appId/customer', async (c) => {
  const appId = folderParam(c.req.param('appId'));
  const { customerId: id } = parse(z.object({ customerId }), await c.req.json().catch(() => null));
  const { customer } = await updateSettings(c.env, appId, c.get('user').email, { customerId: id });
  return c.json({ customer });
});

// ── Deleting a folder ────────────────────────────────────────────────────────

const DeleteBody = z.object({
  confirm: z.string({ message: 'Type the App ID to confirm.' }),
  reason: z.string({ message: 'Say why the folder goes.' }),
  acknowledgeControllers: z.boolean().optional(),
});

folders.delete('/folders/:appId', async (c) => {
  const appId = folderParam(c.req.param('appId'));
  const body = parse(DeleteBody, await c.req.json().catch(() => null));
  return c.json(await deleteFolder(c.env, c.get('user'), appId, body));
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
