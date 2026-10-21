// @ts-check
// The Package card of a Linux application (M1, L4, HMI1): what a release installs. The
// files that go into update.tar.gz under files/ with where go-deploy puts them (destination,
// mode, owner, group), and what runs after install: nothing, a restart of services (the
// skill's post-install.sh.tmpl), or a script of its own. The same as
// .github/r2-deploy.config.json in a CI pipeline, and it can be imported from one, or from
// the latest release (its version manifest, and files/post-install.sh out of its tarball).
// Edits stay on the page until Save (PUT /api/folders/:appId/package).

import { api, errorText, folderPath, getBinary } from './api.js';
import { act, esc, field, hydrateIcons, toast } from './lib.js';
import {
  POST_INSTALL_NAME, SERVICE_SUGGESTIONS, definitionFromConfig, definitionFromVersionManifest, definitionProblem, gunzip,
  packageFileProblem, readTar, renderPostInstall, servicesOf,
} from './package.js';
import { badge, formDialog, formValues } from './ui.js';

/**
 * @typedef {import('./api.js').FolderDetail} FolderDetail
 * @typedef {import('./package.js').PackageDefinition} PackageDefinition
 * @typedef {import('./package.js').PackageFile} PackageFile
 */

/** @returns {PackageDefinition} */
const emptyDefinition = () => ({ owner: 'root', group: 'root', files: [], post_install: { mode: 'none' } });

/** "nodered, go-simulink" → ["nodered", "go-simulink"]. @param {string} text */
const parseServices = (text) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

/**
 * Fill the Package card.
 * @param {HTMLElement} el  the card (a .panel)
 * @param {{ detail: FolderDetail, onSaved: (def: PackageDefinition) => unknown, onDirty?: (dirty: boolean) => void }} opts
 */
export function mountPackageCard(el, opts) {
  const d = opts.detail;
  /** @type {PackageDefinition | null} */
  let saved = d.package ?? null;
  /** @type {PackageDefinition} */
  let draft = structuredClone(saved ?? emptyDefinition());
  let dirty = false;
  /** @type {string} */
  let note = '';
  const latest = d.latestVersionManifest ?? null;

  el.innerHTML = `
    <div class="panel-head"><h2>Package</h2><span class="sub">what a release of this application installs</span><span class="spacer"></span><span data-state></span></div>
    <div data-note></div>
    <p class="text">The files go into <span class="mono">update.tar.gz</span> under <span class="mono">files/</span>; go-deploy puts each one at its
      destination with its mode, owner and group, then runs <span class="mono">files/post-install.sh</span>. The same as
      <span class="mono">.github/r2-deploy.config.json</span> in a CI pipeline.</p>
    <div class="form-grid two">
      ${field('Default owner', (id) => `<input id="${id}" data-f="owner" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off">`)}
      ${field('Default group', (id) => `<input id="${id}" data-f="group" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off">`)}
    </div>
    <div class="section-label">Files</div>
    <div data-files></div>
    <div class="btn-row"><button type="button" class="btn sm" data-add data-icon="plus">Add file…</button></div>
    <div class="section-label">After install</div>
    <div class="checks" role="radiogroup" aria-label="After install">
      <label class="check"><input type="radio" name="pi-mode" value="none"> Nothing</label>
      <label class="check"><input type="radio" name="pi-mode" value="services"> Restart services</label>
      <label class="check"><input type="radio" name="pi-mode" value="script"> A script of its own</label>
    </div>
    <div class="pi-part" data-pi="services" hidden>
      ${field('Services to restart', (id) => `<input id="${id}" data-f="services" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="nodered, go-simulink">`,
        '', 'Comma-separated systemd service names. A service the controller does not have is skipped.')}
      <div class="btn-row suggest">${SERVICE_SUGGESTIONS.map((s) => `<button type="button" class="btn sm" data-suggest="${esc(s)}" data-icon="plus">${esc(s)}</button>`).join('')}</div>
      <details class="script-preview"><summary>The script this makes (post-install.sh.tmpl)</summary><pre class="keytext" data-preview></pre></details>
    </div>
    <div class="pi-part" data-pi="script" hidden>
      ${field('files/post-install.sh', (id) => `<textarea id="${id}" data-f="script" class="mono" rows="10" spellcheck="false" placeholder="#!/bin/bash&#10;set -e&#10;…"></textarea>`,
        '', 'Run with /bin/bash as root after the files are placed, at most 300 s; an exit code other than 0 fails the update.')}
    </div>
    <div class="notice err" data-error hidden></div>
    <div class="btn-row">
      <button type="button" class="btn sm primary" data-save data-icon="check">Save package</button>
      <button type="button" class="btn sm" data-import-config data-icon="arrow-up-tray">Import r2-deploy.config.json…</button>
      <button type="button" class="btn sm" data-import-latest data-icon="arrow-path"${latest ? '' : ' disabled'}>From the latest release</button>
    </div>
    <p class="hint">${latest
      ? `"From the latest release" takes the files of v${esc(String(latest.version ?? d.latest ?? ''))} and its post-install script.`
      : esc(d.latestVersionManifestError || 'There is no release yet to take the package from.')}</p>`;
  hydrateIcons(el);

  const q = (/** @type {string} */ s) => /** @type {HTMLElement} */ (el.querySelector(s));
  const ownerIn = /** @type {HTMLInputElement} */ (q('[data-f="owner"]'));
  const groupIn = /** @type {HTMLInputElement} */ (q('[data-f="group"]'));
  const servicesIn = /** @type {HTMLInputElement} */ (q('[data-f="services"]'));
  const scriptIn = /** @type {HTMLTextAreaElement} */ (q('[data-f="script"]'));
  const errorBox = q('[data-error]');

  /** Read the fields into the draft. */
  const collect = () => {
    const mode = /** @type {HTMLInputElement | null} */ (el.querySelector('[name="pi-mode"]:checked'))?.value ?? 'none';
    draft.owner = ownerIn.value.trim();
    draft.group = groupIn.value.trim();
    draft.post_install = mode === 'services' ? { mode: 'services', services: parseServices(servicesIn.value) }
      : mode === 'script' ? { mode: 'script', script: scriptIn.value.replace(/\r\n?/g, '\n') }
        : { mode: 'none' };
  };
  /** Put the draft into the fields. */
  const fill = () => {
    ownerIn.value = draft.owner;
    groupIn.value = draft.group;
    const pi = draft.post_install;
    el.querySelectorAll('[name="pi-mode"]').forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === pi.mode; });
    servicesIn.value = pi.mode === 'services' ? pi.services.join(', ') : servicesIn.value;
    scriptIn.value = pi.mode === 'script' ? pi.script : scriptIn.value;
  };
  const markDirty = () => { dirty = true; opts.onDirty?.(true); drawState(); };

  const drawState = () => {
    q('[data-state]').innerHTML = !saved ? badge('Not defined', 'warn') : dirty ? badge('Not saved', 'warn') : badge('Saved', 'ok');
    q('[data-note]').innerHTML = note || (!saved ? '<div class="notice warn">No package yet: define what a release installs (or import it) before the first release.</div>' : '');
  };

  const drawFiles = () => {
    const box = q('[data-files]');
    if (!draft.files.length) { box.innerHTML = '<p class="muted">No files yet.</p>'; return; }
    box.innerHTML = `<div class="table-wrap"><table class="data cards pkg-files">
      <thead><tr><th>Name</th><th>Destination</th><th>Mode</th><th>Owner</th><th>Group</th><th><span class="sr-only">Change</span></th></tr></thead>
      <tbody>${draft.files.map((f, i) => {
        const problem = packageFileProblem(f, draft.files);
        return `<tr>
          <td data-label="Name"><span class="cell-main mono">files/${esc(f.name)}</span>${problem ? `<div class="cell-sub error">${esc(problem)}</div>` : ''}</td>
          <td data-label="Destination" class="mono">${esc(f.destination)}</td>
          <td data-label="Mode" class="mono">${esc(f.mode)}</td>
          <td data-label="Owner">${f.owner ? esc(f.owner) : `<span class="muted">${esc(draft.owner || 'root')}</span>`}</td>
          <td data-label="Group">${f.group ? esc(f.group) : `<span class="muted">${esc(draft.group || 'root')}</span>`}</td>
          <td data-label="Change"><span class="cell-btns">
            <button type="button" class="btn sm" data-edit="${i}" aria-label="Edit ${esc(f.name)}">Edit…</button>
            <button type="button" class="btn sm danger" data-remove="${i}" aria-label="Remove ${esc(f.name)}" data-icon="trash"></button></span></td></tr>`;
      }).join('')}</tbody></table></div>`;
    hydrateIcons(box);
  };

  const drawPostInstall = () => {
    collect();
    const mode = draft.post_install.mode;
    el.querySelectorAll('[data-pi]').forEach((p) => { /** @type {HTMLElement} */ (p).hidden = p.getAttribute('data-pi') !== mode; });
    q('[data-preview]').textContent = renderPostInstall(parseServices(servicesIn.value));
  };

  /** Draw everything from the draft. */
  const drawAll = () => { fill(); drawFiles(); drawPostInstall(); drawState(); };

  /** Add or change one file. @param {number | null} index */
  const editFile = async (index) => {
    collect();
    const current = index === null ? { name: '', destination: '', mode: '0644' } : draft.files[index];
    const others = draft.files.filter((_, i) => i !== index);
    const candidate = (/** @type {HTMLFormElement} */ form) => {
      const v = formValues(form);
      /** @type {PackageFile} */
      const f = { name: String(v.name).trim(), destination: String(v.destination).trim(), mode: String(v.mode).trim() };
      if (String(v.owner).trim()) f.owner = String(v.owner).trim();
      if (String(v.group).trim()) f.group = String(v.group).trim();
      return f;
    };
    const ok = await formDialog({
      title: index === null ? 'Add a file' : `Edit files/${current.name}`,
      submitLabel: index === null ? 'Add' : 'Save',
      narrow: true,
      body: `${field('Name in files/', (id) => `<input id="${id}" name="name" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" value="${esc(current.name)}" placeholder="flows.json">`,
          '', 'The file name in the tarball. At release time you choose the file for it; a dropped file is matched by this name.')}
        ${field('Destination on the controller', (id) => `<input id="${id}" name="destination" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" value="${esc(current.destination)}" placeholder="/usr/node-red/flows.json">`)}
        <div class="form-grid two">
          ${field('Mode', (id) => `<input id="${id}" name="mode" class="mono" inputmode="numeric" autocomplete="off" value="${esc(current.mode)}" placeholder="0644">`, '', 'Octal, e.g. 0644 or 0755.')}
          <span></span>
          ${field('Owner', (id) => `<input id="${id}" name="owner" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" value="${esc(current.owner ?? '')}" placeholder="${esc(draft.owner || 'root')}">`, '', 'Empty: the default.')}
          ${field('Group', (id) => `<input id="${id}" name="group" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" value="${esc(current.group ?? '')}" placeholder="${esc(draft.group || 'root')}">`, '', 'Empty: the default.')}
        </div>
        <p class="hint" data-file-problem></p>`,
      onOpen: (form) => {
        const hint = /** @type {HTMLElement} */ (form.querySelector('[data-file-problem]'));
        const show = () => {
          const f = candidate(form);
          const p = f.name || f.destination ? packageFileProblem(f, [...others, f]) : null;
          hint.innerHTML = p ? `<span class="error">${esc(p)}</span>` : '';
        };
        form.addEventListener('input', show);
        show();
      },
      valid: (form) => { const f = candidate(form); return !packageFileProblem(f, [...others, f]); },
      submit: async (form) => {
        const f = candidate(form);
        if (index === null) draft.files.push(f);
        else draft.files[index] = f;
      },
    });
    if (ok) { markDirty(); drawFiles(); }
  };

  el.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!t) return;
    if (t.hasAttribute('data-add')) editFile(null);
    else if (t.hasAttribute('data-edit')) editFile(Number(t.getAttribute('data-edit')));
    else if (t.hasAttribute('data-remove')) {
      collect();
      draft.files.splice(Number(t.getAttribute('data-remove')), 1);
      markDirty();
      drawFiles();
    } else if (t.hasAttribute('data-suggest')) {
      const s = /** @type {string} */ (t.getAttribute('data-suggest'));
      const list = parseServices(servicesIn.value);
      if (!list.includes(s)) list.push(s);
      servicesIn.value = list.join(', ');
      markDirty();
      drawPostInstall();
    }
  });
  el.addEventListener('input', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('[data-f], [name="pi-mode"]')) { markDirty(); drawPostInstall(); if (e.target === ownerIn || e.target === groupIn) drawFiles(); }
  });
  el.addEventListener('change', (e) => {
    if (/** @type {HTMLElement} */ (e.target).matches('[name="pi-mode"]')) { markDirty(); drawPostInstall(); }
  });

  // ── Save ──
  const saveBtn = q('[data-save]');
  saveBtn.addEventListener('click', () => act(saveBtn, async () => {
    errorBox.hidden = true;
    collect();
    const problem = definitionProblem(draft);
    if (problem) throw new Error(problem);
    const res = await api('PUT', `${folderPath(d.appId)}/package`, draft);
    /** @type {PackageDefinition} */
    const stored = structuredClone(res?.package ?? draft);
    saved = stored;
    draft = structuredClone(stored);
    dirty = false;
    note = '';
    opts.onDirty?.(false);
    drawAll();
    toast('Package saved.');
    await opts.onSaved(stored);
  }, (err) => { errorBox.textContent = errorText(err); errorBox.hidden = false; }));

  // ── Import from r2-deploy.config.json ──
  q('[data-import-config]').addEventListener('click', async () => {
    /** @type {{ def: PackageDefinition | null, appId: string | null }} */
    const out = { def: null, appId: null };
    const ok = await formDialog({
      title: 'Import r2-deploy.config.json',
      submitLabel: 'Import',
      body: `<p>The package of a CI pipeline (<span class="mono">.github/r2-deploy.config.json</span>): each file goes in under the name of its
          source, with its destination, mode, owner and group, and its post-install services. Check the result, then Save.</p>
        ${field('The config', (id) => `<textarea id="${id}" name="config" class="mono" rows="8" spellcheck="false" placeholder="{ &quot;app_id&quot;: …, &quot;files&quot;: [ … ] }"></textarea>`)}
        ${field('Or take it from a file', (id) => `<input id="${id}" type="file" data-config-file accept=".json,application/json">`)}`,
      onOpen: (form) => {
        const file = /** @type {HTMLInputElement} */ (form.querySelector('[data-config-file]'));
        const text = /** @type {HTMLTextAreaElement} */ (form.querySelector('[name=config]'));
        file.addEventListener('change', async () => { const f = file.files?.[0]; if (f) { text.value = await f.text(); text.dispatchEvent(new Event('input', { bubbles: true })); } });
      },
      valid: (form) => Boolean(String(formValues(form).config ?? '').trim()),
      submit: async (form) => {
        let json;
        try { json = JSON.parse(String(formValues(form).config)); } catch { throw new Error('This is not valid JSON.'); }
        const r = definitionFromConfig(json);
        out.def = r.definition;
        out.appId = r.appId;
      },
    });
    if (!ok || !out.def) return;
    draft = out.def;
    note = `<div class="notice">Imported from r2-deploy.config.json${out.appId && out.appId !== d.appId
      ? ` (its app_id is <span class="mono">${esc(out.appId)}</span>, this application is <span class="mono">${esc(d.appId)}</span>)` : ''}: check it, then Save.</div>`;
    markDirty();
    drawAll();
  });

  // ── Import from the latest release ──
  const latestBtn = q('[data-import-latest]');
  latestBtn.addEventListener('click', () => act(latestBtn, async () => {
    if (!latest) return;
    const def = definitionFromVersionManifest(latest);
    let pi = '';
    if (latest.post_install) {
      const version = String(latest.version ?? d.latest ?? '');
      try {
        const tar = readTar(await gunzip(await getBinary(`${folderPath(d.appId)}/versions/${encodeURIComponent(version)}/tarball`)));
        const entry = tar.find((t) => t.name === `files/${POST_INSTALL_NAME}` || t.name === `./files/${POST_INSTALL_NAME}`);
        if (!entry) throw new Error(`The tarball of v${version} has no files/${POST_INSTALL_NAME}.`);
        const script = new TextDecoder().decode(entry.data);
        const services = servicesOf(script);
        def.post_install = services ? { mode: 'services', services } : { mode: 'script', script };
        pi = services ? ` Its post-install restarts ${services.join(', ')}.` : ' Its post-install script is taken over as it is.';
      } catch (err) {
        pi = ` Its post-install script could not be read (${errorText(err)}); set it under "After install".`;
      }
    }
    draft = def;
    note = `<div class="notice">Taken from v${esc(String(latest.version ?? d.latest ?? ''))}.${esc(pi)} Check it, then Save.</div>`;
    markDirty();
    drawAll();
  }));

  drawAll();
}
