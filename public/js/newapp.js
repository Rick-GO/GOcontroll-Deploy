// @ts-check
// New application: the card at the bottom of Status (and an App ID that does not exist yet).
// App ID, customer, controller (S1 only: upload and signing here are S1 only) and the
// distribution host → POST /api/folders → its folder page, where the key and the first
// release follow. Nothing is written to the bucket until that first release.

import { ApiError, api } from './api.js';
import { esc, field, toast } from './lib.js';
import { appIdProblem } from './source.js';
import { formDialog, formValues } from './ui.js';

/**
 * The bucket's two hosts (cloud-r2-distribution.md §2.1), for when the Worker does not send
 * its DISTRIBUTION_URLS; the first is the default. The Worker refuses any other.
 */
export const DEFAULT_DISTRIBUTION_URLS = ['https://deploy.gocontroll.tech', 'https://deploy.gocontroll.com'];

const APP_ID_HINT = 'The App ID the controllers carry: 1–32 characters, no spaces and no "/". It names the folder and goes into every container header.';

/**
 * Ask for a new application and create it; afterwards its folder page opens.
 * @param {{ existing: string[], distributionUrls?: string[], appId?: string }} opts
 *   existing: the App IDs there are already (the overview), for the "already exists" check
 */
export async function newApplication(opts) {
  /** @type {{ id: number, name: string }[]} */
  const customers = await api('GET', '/customers');
  const dists = opts.distributionUrls?.length ? opts.distributionUrls : DEFAULT_DISTRIBUTION_URLS;
  const existing = new Set(opts.existing);
  const byLower = new Map(opts.existing.map((id) => [id.toLowerCase(), id]));
  /** @type {{ appId: string | null, existed: boolean }} */
  const out = { appId: null, existed: false };
  const idOf = (/** @type {HTMLFormElement} */ form) => String(formValues(form).appId ?? '').trim();

  const ok = await formDialog({
    title: 'New application',
    submitLabel: 'Create application',
    body: `<p>A folder in the distribution bucket for one S1 application, named after its App ID. Its signing key and first release follow on its page.</p>
      ${field('App ID', (id) => `<input id="${id}" name="appId" class="mono" maxlength="32" autocomplete="off" spellcheck="false" autocapitalize="off"
        placeholder="GOCOXYZ" value="${esc(opts.appId ?? '')}">`, '', `<span data-appid-hint>${esc(APP_ID_HINT)}</span>`)}
      ${field('Customer', (id) => `<select id="${id}" name="customerId"><option value="">No customer yet</option>
        ${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`, '', 'Customers are managed in the CRM.')}
      ${field('Controller', (id) => `<select id="${id}" name="controller" disabled><option value="S1" selected>S1</option></select>`, '',
        'Only S1 applications are published here. Releases for Linux controllers (M1, L4, HMI1) are published by go-deploy, not in Deploy.')}
      ${field('Distribution host', (id) => `<select id="${id}" name="distributionUrl">${dists.map((u, i) => `<option value="${esc(u)}"${i === 0 ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select>`,
        '', 'The binary URLs in its manifest start with it, and its controllers carry the same one. Both hosts serve the same bucket.')}`,
    onOpen: (form) => {
      const hint = /** @type {HTMLElement} */ (form.querySelector('[data-appid-hint]'));
      const input = /** @type {HTMLInputElement} */ (form.querySelector('[name=appId]'));
      const show = () => {
        const id = idOf(form);
        const problem = id ? appIdProblem(id) : null;
        const other = byLower.get(id.toLowerCase());
        if (problem) hint.innerHTML = `<span class="error">${esc(problem)}</span>`;
        else if (existing.has(id)) hint.innerHTML = `<span class="error"><span class="mono">${esc(id)}</span> exists already.</span> <a href="#/folders/${encodeURIComponent(id)}">Open it</a>`;
        else if (other) hint.innerHTML = `<span class="error">There is a folder <span class="mono">${esc(other)}</span>: App IDs are case-sensitive, so this would be another one.</span>`;
        else hint.textContent = APP_ID_HINT;
        if (problem || existing.has(id)) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      };
      input.addEventListener('input', show);
      if (input.value) show();
    },
    valid: (form) => { const id = idOf(form); return Boolean(id) && !appIdProblem(id) && !existing.has(id); },
    submit: async (form) => {
      const v = formValues(form);
      const appId = idOf(form);
      try {
        const res = await api('POST', '/folders', {
          appId, customerId: v.customerId ? Number(v.customerId) : null, controller: 'S1', distributionUrl: v.distributionUrl,
        });
        out.appId = typeof res?.appId === 'string' ? res.appId : appId;
      } catch (err) {
        // It exists already (perhaps only as a key): open it rather than fail.
        if (err instanceof ApiError && err.status === 409) { out.appId = appId; out.existed = true; return; }
        throw err;
      }
    },
  });
  if (!ok || !out.appId) return;
  toast(out.existed ? `${out.appId} exists already: here it is.` : `Application ${out.appId} created.`);
  location.hash = `#/folders/${encodeURIComponent(out.appId)}`;
}
