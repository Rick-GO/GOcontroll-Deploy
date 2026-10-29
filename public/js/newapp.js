// @ts-check
// New application: the card at the bottom of Applications (and an App ID that does not exist yet).
// App ID, customer and controller → POST /api/folders → its page, where the rest follows: for
// S1 its public key and the first release (and here the distribution host);
// for M1, L4 and HMI1 the package definition and the first release (no host: Linux packages
// are downloaded through the Moduline dashboard, the root manifest holds relative paths).
// Nothing is written to the bucket until that first release.

import { ApiError, api } from './api.js';
import { esc, field, toast } from './lib.js';
import { linuxAppIdProblem } from './package.js';
import { applicationHref } from './routes.js';
import { appIdProblem } from './source.js';
import { CONTROLLERS, formDialog, formValues } from './ui.js';

/**
 * The bucket's two hosts (cloud-r2-distribution.md §2.1), for when the Worker does not send
 * its DISTRIBUTION_URLS; the first is the default. The Worker refuses any other.
 */
export const DEFAULT_DISTRIBUTION_URLS = ['https://deploy.gocontroll.tech', 'https://deploy.gocontroll.com'];

const HINTS = {
  S1: 'The App ID the controllers carry: 1–32 characters, no spaces and no "/". It names the folder and goes into every container header.',
  linux: 'Lower case: letters, digits, ".", "_" and "-", starting with a letter or digit (as app_id in r2-deploy.config.json). It names the folder.',
};

/** @param {string} controller @param {string} appId */
const problemFor = (controller, appId) => (controller === 'S1' ? appIdProblem(appId) : linuxAppIdProblem(appId));

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
  const controllerOf = (/** @type {HTMLFormElement} */ form) => String(formValues(form).controller ?? 'S1');

  const ok = await formDialog({
    title: 'New application',
    submitLabel: 'Create application',
    body: `<p>A folder in the distribution bucket for one application, named after its App ID. What goes into it follows on its page.</p>
      ${field('Controller', (id) => `<select id="${id}" name="controller">${CONTROLLERS.map((c) => `<option value="${c}"${c === 'S1' ? ' selected' : ''}>${c}</option>`).join('')}</select>`,
        '', '<span data-controller-hint></span>')}
      ${field('App ID', (id) => `<input id="${id}" name="appId" class="mono" maxlength="64" autocomplete="off" spellcheck="false" autocapitalize="off"
        placeholder="GOCOXYZ" value="${esc(opts.appId ?? '')}">`, '', '<span data-appid-hint></span>')}
      ${field('Customer', (id) => `<select id="${id}" name="customerId"><option value="">No customer yet</option>
        ${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`, '', 'Customers are managed in the CRM.')}
      <div data-host>
      ${field('Distribution host', (id) => `<select id="${id}" name="distributionUrl">${dists.map((u, i) => `<option value="${esc(u)}"${i === 0 ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select>`,
        '', 'The binary URLs in its manifest start with it, and its controllers carry the same one. Both hosts serve the same bucket.')}
      </div>`,
    onOpen: (form) => {
      const appHint = /** @type {HTMLElement} */ (form.querySelector('[data-appid-hint]'));
      const ctlHint = /** @type {HTMLElement} */ (form.querySelector('[data-controller-hint]'));
      const host = /** @type {HTMLElement} */ (form.querySelector('[data-host]'));
      const input = /** @type {HTMLInputElement} */ (form.querySelector('[name=appId]'));
      const show = () => {
        const controller = controllerOf(form);
        const s1 = controller === 'S1';
        host.hidden = !s1;
        input.placeholder = s1 ? 'GOCOXYZ' : 'customer-application';
        input.maxLength = s1 ? 32 : 64;
        ctlHint.textContent = s1
          ? 'S1: signed GOCO binaries, which controllers download from the distribution host.'
          : `${controller}: a Linux application. Its releases are go-deploy packages (files plus a post-install), installed through the Moduline dashboard; they are not signed.`;
        const id = idOf(form);
        const problem = id ? problemFor(controller, id) : null;
        const other = byLower.get(id.toLowerCase());
        if (problem) appHint.innerHTML = `<span class="error">${esc(problem)}</span>`;
        else if (existing.has(id)) appHint.innerHTML = `<span class="error"><span class="mono">${esc(id)}</span> exists already.</span> <a href="${applicationHref(id)}">Open it</a>`;
        else if (other) appHint.innerHTML = `<span class="error">There is a folder <span class="mono">${esc(other)}</span>: App IDs are case-sensitive, so this would be another one.</span>`;
        else appHint.textContent = s1 ? HINTS.S1 : HINTS.linux;
        if (problem || existing.has(id)) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      };
      input.addEventListener('input', show);
      form.querySelector('[name=controller]')?.addEventListener('change', show);
      show();
    },
    valid: (form) => { const id = idOf(form); return Boolean(id) && !problemFor(controllerOf(form), id) && !existing.has(id); },
    submit: async (form) => {
      const v = formValues(form);
      const appId = idOf(form);
      const controller = controllerOf(form);
      try {
        const res = await api('POST', '/folders', {
          appId, customerId: v.customerId ? Number(v.customerId) : null, controller,
          ...(controller === 'S1' ? { distributionUrl: v.distributionUrl } : {}),
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
  location.hash = applicationHref(out.appId);
}
