// Module firmware: POST /api/firmware against the CI producer, the module repos'
// publish_firmware.py. test/fixtures/firmware/ci-manifests.json holds what that script wrote for
// each case (scripts/firmware-fixtures.py); the Worker must write the same objects in the same
// order, byte for byte, apart from the "updated" date of modules/manifest.json (the script's clock).

import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { compareFirmwareVersions, manifestDate, parseSrecName } from '../src/firmware';
import fixtures from './fixtures/firmware/ci-manifests.json';
import { ok, spyBucket } from './helpers';
import worker from '../src/index';

const ORIGIN = 'http://localhost';
const ME = 'jane.doe@gocontroll.com';
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const text = async (key: string) => (await env.FIRMWARE_BUCKET.get(key))?.text() ?? null;
const json = async (key: string) => JSON.parse((await text(key))!);

/** A valid S-record with LF line ends, unique per seed. */
function srec(seed: string, crlf = false): Uint8Array<ArrayBuffer> {
  const rec = (kind: string, addr: number[], data: number[]) => {
    const body = [addr.length + data.length + 1, ...addr, ...data];
    const sum = (~body.reduce((a, b) => a + b, 0)) & 0xff;
    return `S${kind}${body.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}${sum.toString(16).padStart(2, '0').toUpperCase()}`;
  };
  const data = [...new TextEncoder().encode(seed.padEnd(16, '.'))].slice(0, 16);
  const lines = [rec('0', [0, 0], [...new TextEncoder().encode('test')]), rec('3', [8, 0, 0x40, 0], data), rec('7', [8, 0, 0x40, 0], [])];
  return new TextEncoder().encode(lines.join(crlf ? '\r\n' : '\n') + (crlf ? '\r\n' : '\n')) as Uint8Array<ArrayBuffer>;
}

async function publish(name: string, bytes: Uint8Array<ArrayBuffer>, fields: Record<string, string> = {}, bucket?: R2Bucket) {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: 'application/octet-stream' }));
  for (const [k, v] of Object.entries({ released: '2026-10-28', changelog: 'Test release', ...fields })) form.append(k, v);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/firmware`, { method: 'POST', body: form, headers: { origin: ORIGIN } }), {
    ...env, DEV_USER_EMAIL: ME, DEV_USER_NAME: 'Jane Doe', DEV_USER_GROUPS: 'CF_Deploy', ...(bucket ? { FIRMWARE_BUCKET: bucket } : {}),
  } as typeof env);
  return { status: res.status, body: await res.json<any>() };
}

/** A module type and hardware ID of its own per test (storage is shared within this file). */
let hw = 0;
const freshHw = () => {
  hw++;
  return { file: (v: string) => `20-60-${hw}-1-${v.replace(/\./g, '-')}.srec`, id: `2060${String(hw).padStart(2, '0')}01` };
};

describe('the file name', () => {
  test('is read the way publish_firmware.py reads it', () => {
    expect(parseSrecName('20-10-1-6-2-0-3.srec')).toEqual({ file: '20-10-1-6-2-0-3.srec', hwId: '20100106', typeId: '201001', version: '2.0.3', hardwareVersion: '1.06' });
    expect(parseSrecName('20-10-3-3-1-1-0.srec')?.hwId).toBe('20100303');
    expect(parseSrecName('20-30-4-2-0-2-0.srec')?.version).toBe('0.2.0');
    for (const bad of ['Module-Multibus.srec', '20-10-1-6-2-0.srec', '20-10-1-6-2-0-3.elf', '200-10-1-6-2-0-3.srec', '20-10-1-6-2-0-3.srec.bak']) {
      expect(parseSrecName(bad)).toBeNull();
    }
  });

  test('versions sort as numbers and dates become DD/MM/YY', () => {
    expect(compareFirmwareVersions('2.0.10', '2.0.9')).toBe(1);
    expect(compareFirmwareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(manifestDate('2026-04-27')).toBe('27/04/26');
    expect(() => manifestDate('2026-02-30')).toThrow();
  });
});

describe('the objects as publish_firmware.py writes them', () => {
  test.each(fixtures.cases)('$name', async (c) => {
    // Every case starts from its own bucket state: clear the keys this suite touches.
    const all = await env.FIRMWARE_BUCKET.list();
    if (all.objects.length) await env.FIRMWARE_BUCKET.delete(all.objects.map((o) => o.key));
    for (const [key, value] of Object.entries(c.before as unknown as Record<string, string>)) {
      await env.FIRMWARE_BUCKET.put(key, value, { httpMetadata: { contentType: 'application/json' } });
    }
    const order: string[] = [];
    const bucket = spyBucket(env.FIRMWARE_BUCKET, async (method, args) => { if (method === 'put') order.push(String(args[0])); });
    const [dd, mm, yy] = c.release_date.split('/');
    const res = await publish(c.srec_name, unb64(c.srec_b64), { released: `20${yy}-${mm}-${dd}`, changelog: c.changelog }, bucket);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(order).toEqual(c.writes.map((w) => w.key));
    for (const w of c.writes) {
      const obj = await env.FIRMWARE_BUCKET.get(w.key);
      expect(obj?.httpMetadata?.contentType).toBe(w.content_type);
      const expected = (c.after as unknown as Record<string, string>)[w.key];
      if (w.key.endsWith('.srec')) {
        expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(unb64(expected));
      } else if (w.key === 'modules/manifest.json') {
        const updated = JSON.parse(expected).updated as string;
        expect((await obj!.text()).replace(/"updated": "[^"]*"/, `"updated": "${updated}"`)).toBe(expected);
      } else {
        expect(await obj!.text()).toBe(expected);
      }
    }
  });
});

describe('publishing', () => {
  test('a version that is published already needs Replace; the same file is not written again', async () => {
    const m = freshHw();
    expect((await publish(m.file('1.0.0'), srec('a'), { module_name: 'Test module' })).status).toBe(200);
    const again = await publish(m.file('1.0.0'), srec('a'), { changelog: 'New text' });
    expect(again.status).toBe(409);
    expect(again.body.field).toBe('replace');
    const replaced = await publish(m.file('1.0.0'), srec('a'), { changelog: 'New text', replace: 'true' });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ objectWritten: false, replacedRelease: true, replacedFile: false });
    const mod = await json(`modules/${m.id}/manifest.json`);
    expect(mod.releases).toHaveLength(1);
    expect(mod.releases[0].changelog).toBe('New text');
  });

  test('other bytes under an existing name are archived before they are replaced', async () => {
    const m = freshHw();
    const key = `modules/${m.id}/${m.file('1.0.0')}`;
    await env.FIRMWARE_BUCKET.put(key, srec('old'));
    const refused = await publish(m.file('1.0.0'), srec('new'), { module_name: 'Test module' });
    expect(refused.status).toBe(409);
    expect(refused.body.conflict).toBe('file');
    const res = await publish(m.file('1.0.0'), srec('new'), { module_name: 'Test module', replace: 'true' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ objectWritten: true, replacedFile: true });
    const archived = await env.STATE.list({ prefix: `firmware-replaced/${m.id}/` });
    expect(archived.objects).toHaveLength(1);
    expect(await (await env.STATE.get(archived.objects[0].key))!.text()).toBe(new TextDecoder().decode(srec('old')));
  });

  test('releases stay highest first and latest_firmware is the highest, also when an older version comes later', async () => {
    const m = freshHw();
    await publish(m.file('2.0.3'), srec('b'), { module_name: 'Test module' });
    await publish(m.file('2.0.10'), srec('c'));
    const res = await publish(m.file('2.0.2'), srec('d'));
    expect(res.body.latest).toBe('2.0.10');
    const mod = await json(`modules/${m.id}/manifest.json`);
    expect(mod.releases.map((r: { sw_version: string }) => r.sw_version)).toEqual(['2.0.10', '2.0.3', '2.0.2']);
    const master = await json('modules/manifest.json');
    expect(master.modules.find((x: { id: string }) => x.id === m.id).latest_firmware).toBe('2.0.10');
  });

  test('a new hardware ID takes the name of its module type, or asks for one', async () => {
    const m = freshHw();
    const refused = await publish(m.file('1.0.0'), srec('e'));
    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('module_name');
    expect(await text(`modules/${m.id}/manifest.json`)).toBeNull();
    await env.FIRMWARE_BUCKET.put('modules/manifest.json', JSON.stringify({ updated: '2026-01-01', modules: [
      { id: '20100104', name: '6 Channel Input module', hardware_version: '1.04', latest_firmware: '2.0.3', manifest: 'modules/20100104/manifest.json' },
    ] }, null, 2));
    const res = await publish('20-10-1-9-1-0-0.srec', srec('f'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await json('modules/20100109/manifest.json')).name).toBe('6 Channel Input module');
  });

  test('refuses CR line ends, a file that is not an S-record and a name off the convention', async () => {
    const m = freshHw();
    expect((await publish(m.file('1.0.0'), srec('g', true), { module_name: 'X' })).status).toBe(400);
    expect((await publish(m.file('1.0.0'), new TextEncoder().encode('hello\n') as Uint8Array<ArrayBuffer>, { module_name: 'X' })).status).toBe(400);
    expect((await publish('Module-Multibus.srec', srec('h'), { module_name: 'X' })).status).toBe(422);
    expect((await publish(m.file('1.0.0'), srec('i'), { module_name: 'X', changelog: '' })).status).toBe(400);
    expect((await publish(m.file('1.0.0'), srec('j'), { module_name: 'X', released: '28/10/26' })).status).toBe(400);
    expect(await text(`modules/${m.id}/manifest.json`)).toBeNull();
  });

  test('a manifest that is not JSON is never overwritten', async () => {
    const m = freshHw();
    await env.FIRMWARE_BUCKET.put(`modules/${m.id}/manifest.json`, '{ broken');
    expect((await publish(m.file('1.0.0'), srec('k'), { module_name: 'X' })).status).toBe(409);
    expect(await text(`modules/${m.id}/manifest.json`)).toBe('{ broken');
  });

  test('the log holds the manifests from before, and the overview names who published from where', async () => {
    const m = freshHw();
    await publish(m.file('1.0.0'), srec('l'), { module_name: 'Test module' });
    const before = await text(`modules/${m.id}/manifest.json`);
    const source = { repo: 'Module-Test', branch: 'master', commit: 'a'.repeat(40), tag: null };
    const res = await publish(m.file('1.1.0'), srec('m'), { source: JSON.stringify(source) });
    expect(res.status).toBe(200);
    const logs = await env.STATE.list({ prefix: 'log/' });
    const mine = logs.objects.filter((o) => o.key.endsWith(`-module-${m.id}-1.1.0.json`));
    expect(mine).toHaveLength(1);
    const entry = JSON.parse(await (await env.STATE.get(mine[0].key))!.text());
    expect(entry).toMatchObject({ action: 'publish-firmware', actor: ME, previous_module_manifest: before, source });

    const overview = await ok('GET', '/api/firmware');
    const mod = overview.modules.find((x: { id: string }) => x.id === m.id);
    expect(mod.latest).toBe('1.1.0');
    expect(mod.releases[0]).toMatchObject({ version: '1.1.0', publishedBy: { email: ME, source } });
    expect(overview.firmwareUrl).toBe('https://firmware.gocontroll.tech');
  });

  test('the upload must come from this origin', async () => {
    const form = new FormData();
    form.append('file', new File([srec('n')], '20-40-9-9-1-0-0.srec'));
    const res = await worker.fetch(new Request(`${ORIGIN}/api/firmware`, { method: 'POST', body: form }), {
      ...env, DEV_USER_EMAIL: ME, DEV_USER_GROUPS: 'CF_Deploy',
    } as typeof env);
    expect(res.status).toBe(403);
  });
});
