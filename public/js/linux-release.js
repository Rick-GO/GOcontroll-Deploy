// @ts-check
// New release of a Linux application (M1, L4, HMI1), on its folder page, in three steps:
//   1 Files    one file per package file (picked per row, or several dropped at once and
//              matched by name), or "Upload a built package": update.tar.gz + manifest.json
//              from a CI dist/, sent as they are. The version (prefilled with the next patch
//              of latest) and what changed.
//   2 Review   no signing for Linux (go-deploy has none: it checks SHA-256 values). The version
//              manifest that will be written, the post-install script, the tarball's size and
//              SHA-256, and what happens to latest_version (the highest version, as
//              upload-r2.py decides it).
//   3 Publish  progress, then the keys written, the SHA-256 and latest_version.
// The package is built in the browser (package.js, as build-package.py builds it); the
// Worker checks the version manifest, hashes the tarball and writes tarball, version
// manifest and root manifest in that order.

import { ApiError, errorText, postForm } from './api.js';
import { fmtBytes, fmtDay, shortHash } from './format.js';
import { act, copyButton, esc, field, hydrateIcons } from './lib.js';
import {
  MAX_TARBALL, PackageError, buildTarball, checkBuiltPackage, compareLinuxVersions, linuxVersionProblem, nextPatch,
  pythonJson, sha256Hex, todayUtc, versionManifest,
} from './package.js';
import { confirmDialog, flagField, runSteps } from './ui.js';

/**
 * @typedef {import('./api.js').FolderDetail} FolderDetail
 * @typedef {import('./api.js').LinuxPublishResult} LinuxPublishResult
 * @typedef {import('./package.js').PackageDefinition} PackageDefinition
 * @typedef {import('./package.js').BuiltTarball} BuiltTarball
 */

/** @param {number} n @param {string} title */
const stepHead = (n, title) => `<div class="flow-head"><span class="flow-num" aria-hidden="true">${n}</span>
  <h3>${esc(title)}</h3><span class="flow-state" data-state></span></div>`;

/** A stable key for a picked file. @param {File | null | undefined} f */
const fileKey = (f) => (f ? `${f.name}|${f.size}|${f.lastModified}` : '');

/** @param {File} f */
const readBytes = async (f) => new Uint8Array(await f.arrayBuffer());

/**
 * Fill the New release card of a Linux application.
 * @param {HTMLElement} el  the card (a .panel)
 * @param {{ detail: FolderDetail, published?: LinuxPublishResult | null, onPublished: (res: LinuxPublishResult) => unknown }} opts
 * @returns {{ setPackageDirty: (dirty: boolean) => void }}
 */
export function mountLinuxRelease(el, opts) {
  const d = opts.detail;
  const appId = d.appId;
  /** @type {PackageDefinition | null} */
  const def = d.package ?? null;
  const versions = d.linuxVersions ?? [];
  const latest = d.latest ?? null;

  el.innerHTML = `
    <div class="panel-head"><h2>New release</h2><span class="sub">a go-deploy package into <span class="mono">${esc(appId)}/v&lt;version&gt;/</span></span></div>
    ${opts.published ? publishedCard(opts.published) : ''}
    <div class="notice warn" data-dirty hidden>The Package card has changes that are not saved: a release is built from the saved package.</div>
    <ol class="flow">
      <li class="flow-step" data-step="1">${stepHead(1, 'Files')}
        <fieldset class="flow-body" data-body><legend class="sr-only">Step 1: the files</legend>
          <div class="checks seg" role="radiogroup" aria-label="Source">
            <label class="check"><input type="radio" name="lr-source" value="build" checked> Build it from the package</label>
            <label class="check"><input type="radio" name="lr-source" value="built"> Upload a built package (update.tar.gz + manifest.json from a CI <span class="mono">dist/</span>)</label>
          </div>
          <div data-part="build">
            ${def ? `<label class="drop" for="lr-many">
                <span class="drop-icon" data-icon="arrow-up-tray"></span>
                <span class="drop-text"><strong>Choose files</strong> or drop them here</span>
                <span class="drop-hint">Matched to the package by name; or choose each one in the list.</span>
                <input type="file" id="lr-many" class="drop-input" multiple aria-label="Package files">
              </label>
              <div data-unmatched></div>
              <div data-rows></div>`
              : '<div class="notice warn">This application has no package yet: define it in the Package card first (or import it), then build its releases here. A package built by CI can be uploaded as it is.</div>'}
          </div>
          <div data-part="built" hidden>
            <label class="drop" for="lr-built">
              <span class="drop-icon" data-icon="arrow-up-tray"></span>
              <span class="drop-text"><strong>Choose update.tar.gz and manifest.json</strong> or drop both here</span>
              <span class="drop-hint">Sent as they are; the tarball is checked against the manifest's SHA-256 values here first.</span>
              <input type="file" id="lr-built" class="drop-input" multiple accept=".gz,.tgz,.json,application/gzip,application/json" aria-label="update.tar.gz and manifest.json">
            </label>
            <div data-built-info></div>
          </div>
          <div class="form-grid two">
            ${field('Version', (id) => `<input id="${id}" data-f="version" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="1.2.3" value="${esc(nextPatch(latest))}">`,
              '', `<span data-version-hint>${latest ? `Latest is ${esc(latest)}; this is the next patch.` : 'The first release.'} A pre-release such as 1.0.1-r is allowed.</span>`)}
            ${field('What changed', (id) => `<textarea id="${id}" data-f="description" rows="3" maxlength="500" placeholder="What this release changes"></textarea>`,
              'span-2', 'Required: it goes into the version manifest and the root manifest, next to the version.')}
          </div>
        </fieldset></li>
      <li class="flow-step" data-step="2">${stepHead(2, 'Review')}
        <fieldset class="flow-body" data-body><legend class="sr-only">Step 2: review</legend><div data-review></div></fieldset></li>
      <li class="flow-step" data-step="3">${stepHead(3, 'Publish')}
        <fieldset class="flow-body" data-body><legend class="sr-only">Step 3: publish</legend>
          <div data-plan></div>
          <div class="notice err" data-error hidden></div>
          <div class="btn-row"><button type="button" class="btn primary" data-go data-icon="cloud-arrow-up"><span data-go-label>Publish</span></button></div>
          <div class="run" data-progress hidden></div>
        </fieldset></li>
    </ol>`;
  hydrateIcons(el);

  const q = (/** @type {string} */ s) => /** @type {HTMLElement} */ (el.querySelector(s));
  const steps = [...el.querySelectorAll('.flow-step')];
  const bodies = /** @type {HTMLFieldSetElement[]} */ ([...el.querySelectorAll('[data-body]')]);
  const versionIn = /** @type {HTMLInputElement} */ (q('[data-f="version"]'));
  const descIn = /** @type {HTMLTextAreaElement} */ (q('[data-f="description"]'));
  const errorBox = q('[data-error]');
  const goBtn = /** @type {HTMLButtonElement} */ (q('[data-go]'));

  const st = {
    source: /** @type {'build' | 'built'} */ ('build'),
    /** @type {Map<string, File>} */ chosen: new Map(),
    /** @type {string[]} */ unmatched: [],
    /** @type {File | null} */ tarball: null,
    /** @type {File | null} */ manifestFile: null,
    /** @type {any} */ manifest: null,
    /** @type {string} */ manifestText: '',
    /** @type {string | null} */ manifestProblem: null,
    busy: false,
    // The tarball for the current files (built or checked), and what it was made from.
    /** @type {string | null} */ tarFor: null,
    /** @type {(BuiltTarball & { problems?: string[] }) | null} */ tar: null,
    /** @type {string | null} */ tarError: null,
    tarToken: 0,
  };

  // ── step 1 ──
  const drawRows = () => {
    const rows = el.querySelector('[data-rows]');
    if (!rows || !def) return;
    rows.innerHTML = `<div class="table-wrap"><table class="data cards pkg-pick">
      <thead><tr><th>Package file</th><th>Destination</th><th>Chosen file</th><th><span class="sr-only">Choose</span></th></tr></thead>
      <tbody>${def.files.map((f, i) => {
        const c = st.chosen.get(f.name);
        return `<tr>
        <td data-label="Package file"><span class="cell-main mono">files/${esc(f.name)}</span></td>
        <td data-label="Destination" class="mono">${esc(f.destination)}</td>
        <td data-label="Chosen file">${c ? `${esc(c.name)} <span class="muted">${esc(fmtBytes(c.size))}</span>${c.name !== f.name ? `<div class="cell-sub">packed as ${esc(f.name)}</div>` : ''}` : '<span class="muted">Not chosen</span>'}</td>
        <td data-label="Choose"><input type="file" id="lr-one-${i}" class="drop-input" data-one="${esc(f.name)}" aria-label="File for ${esc(f.name)}">
          <label class="btn sm" for="lr-one-${i}">${c ? 'Change…' : 'Choose…'}</label></td></tr>`;
      }).join('')}</tbody></table></div>`;
    q('[data-unmatched]').innerHTML = st.unmatched.length
      ? `<div class="notice warn">Not in the package, so left out: ${st.unmatched.map((n) => `<span class="mono">${esc(n)}</span>`).join(', ')}.</div>` : '';
  };

  /** Several files at once: matched by name. @param {FileList | File[]} files */
  const takeMany = (files) => {
    if (!def) return;
    const names = new Set(def.files.map((f) => f.name));
    st.unmatched = [];
    for (const f of files) {
      if (names.has(f.name)) st.chosen.set(f.name, f);
      else st.unmatched.push(f.name);
    }
    drawRows();
    draw();
  };

  /** update.tar.gz and manifest.json of a built package. @param {FileList | File[]} files */
  const takeBuilt = async (files) => {
    for (const f of files) {
      if (/\.json$/i.test(f.name)) st.manifestFile = f;
      else if (/\.(tar\.gz|tgz|gz)$/i.test(f.name)) st.tarball = f;
    }
    st.manifest = null;
    st.manifestProblem = null;
    if (st.manifestFile) {
      st.manifestText = await st.manifestFile.text();
      try {
        st.manifest = JSON.parse(st.manifestText);
        st.manifestProblem = builtManifestProblem(st.manifest, appId);
      } catch {
        st.manifestProblem = 'manifest.json is not valid JSON.';
      }
      if (st.manifest && !st.manifestProblem) {
        versionIn.value = String(st.manifest.version);
        descIn.value = String(st.manifest.description ?? '');
      }
    }
    if (st.tarball && st.tarball.size > MAX_TARBALL) st.manifestProblem = `update.tar.gz is ${fmtBytes(st.tarball.size)}; Deploy takes at most 100 MB.`;
    drawBuilt();
    draw();
  };

  const drawBuilt = () => {
    const built = st.source === 'built';
    versionIn.readOnly = built && Boolean(st.manifest);
    descIn.readOnly = built && Boolean(st.manifest);
    q('[data-built-info]').innerHTML = `<dl class="facts compact">
        <div><dt>update.tar.gz</dt><dd>${st.tarball ? `${esc(st.tarball.name)} <span class="muted">${esc(fmtBytes(st.tarball.size))}</span>` : '<span class="muted">Not chosen</span>'}</dd></div>
        <div><dt>manifest.json</dt><dd>${st.manifest ? `<span class="mono">${esc(String(st.manifest.app_id))}</span> v${esc(String(st.manifest.version))}, released ${esc(fmtDay(st.manifest.released))}`
          : st.manifestFile ? esc(st.manifestFile.name) : '<span class="muted">Not chosen</span>'}</dd></div>
      </dl>
      ${st.manifestProblem ? `<div class="notice err">${esc(st.manifestProblem)}</div>` : ''}
      ${st.manifest && !st.manifestProblem ? '<p class="hint">The version and what changed come from manifest.json: the root manifest takes them over as they are.</p>' : ''}`;
  };

  const versionOk = () => !linuxVersionProblem(versionIn.value.trim());
  const filesDone = () => (st.source === 'build'
    ? def !== null && def.files.every((f) => st.chosen.has(f.name))
    : Boolean(st.tarball && st.manifest && !st.manifestProblem));
  const step1Done = () => filesDone() && versionOk() && Boolean(descIn.value.trim());
  /** What the tarball is made from: a new one is needed when this changes. */
  const tarKey = () => (st.source === 'build'
    ? `build|${JSON.stringify(def)}|${(def?.files ?? []).map((f) => fileKey(st.chosen.get(f.name))).join(',')}`
    : `built|${fileKey(st.tarball)}|${st.manifestText}`);
  const step2Done = () => step1Done() && st.tarFor === tarKey() && Boolean(st.tar) && !st.tar?.problems?.length;

  /** Build (or check) the tarball for the current files, once per set of files. */
  const prepare = async () => {
    const key = tarKey();
    if (!filesDone() || st.tarFor === key) return;
    const mine = ++st.tarToken;
    st.tarFor = key;
    st.tar = null;
    st.tarError = null;
    drawReview();
    try {
      if (st.source === 'build' && def) {
        const contents = new Map();
        for (const f of def.files) contents.set(f.name, await readBytes(/** @type {File} */ (st.chosen.get(f.name))));
        const t = await buildTarball({ definition: def, contents });
        if (mine === st.tarToken) st.tar = t;
      } else if (st.tarball) {
        const tarGz = await readBytes(st.tarball);
        const check = await checkBuiltPackage(tarGz, st.manifest);
        if (mine === st.tarToken) {
          st.tar = { tar: new Uint8Array(0), tarGz, sha256: await sha256Hex(tarGz), size: tarGz.length, files: [], postInstall: check.postInstall,
            postInstallSha256: null, problems: check.problems };
        }
      }
    } catch (err) {
      if (mine === st.tarToken) st.tarError = errorText(err);
    }
    if (mine === st.tarToken) draw();
  };

  /** The version manifest that will be written (built here, or the uploaded one). */
  const manifestNow = () => {
    if (st.source === 'built') return { text: st.manifestText, manifest: st.manifest };
    if (!st.tar) return null;
    const m = versionManifest({
      appId, version: versionIn.value.trim(), released: todayUtc(), description: descIn.value.trim(), files: st.tar.files, postInstallSha256: st.tar.postInstallSha256,
    });
    return { text: pythonJson(m), manifest: m };
  };

  /** What happens to latest_version, in words. @param {string} v */
  const latestLine = (v) => {
    if (versions.some((x) => x.version === v)) return `v${v} is published already: publishing again replaces its tarball and manifest (the old ones are archived first). latest_version stays ${latest ?? v}.`;
    if (!latest) return `latest_version becomes ${v}: the first release.`;
    const c = compareLinuxVersions(v, latest);
    if (c > 0) return `latest_version moves from ${latest} to ${v}.`;
    return `v${v} is lower than latest ${latest}: latest stays ${latest}. Controllers set to the latest version do not get it.`;
  };

  // ── step 2 ──
  const drawReview = () => {
    const box = q('[data-review]');
    if (!step1Done()) { box.innerHTML = '<p class="hint">After step 1: the version manifest and the tarball, before anything is written.</p>'; return; }
    if (st.tarError) { box.innerHTML = `<div class="notice err">${esc(st.tarError)}</div>`; return; }
    if (!st.tar || st.tarFor !== tarKey()) { box.innerHTML = `<div class="loading"><span class="spinner dark"></span> ${st.source === 'build' ? 'Building update.tar.gz…' : 'Checking update.tar.gz against manifest.json…'}</div>`; return; }
    const m = manifestNow();
    const manifest = /** @type {any} */ (m?.manifest ?? {});
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const v = versionIn.value.trim();
    box.innerHTML = `
      <div class="notice">Linux packages are not signed: go-deploy has no signature check. It verifies the tarball against the SHA-256 in the root manifest
        (sent by the Moduline dashboard) and every file against the SHA-256 in this version manifest.</div>
      ${st.tar.problems?.length ? `<div class="notice err">This built package does not hold up:<ul>${st.tar.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
      <dl class="facts compact">
        <div><dt>update.tar.gz</dt><dd>${esc(fmtBytes(st.tar.size))}</dd></div>
        <div><dt>SHA-256</dt><dd class="mono" title="${esc(st.tar.sha256)}">${esc(shortHash(st.tar.sha256))}…</dd></div>
        <div><dt>Released</dt><dd>${esc(fmtDay(String(manifest.released ?? todayUtc())))}</dd></div>
        <div class="span-all"><dt>latest_version</dt><dd>${esc(latestLine(v))}</dd></div>
      </dl>
      <div class="table-wrap"><table class="data cards review-files">
        <thead><tr><th>Source</th><th>Destination</th><th>Mode</th><th>Owner</th><th>SHA-256</th></tr></thead>
        <tbody>${files.map((/** @type {any} */ f) => `<tr>
          <td data-label="Source" class="mono">${esc(f.source)}</td>
          <td data-label="Destination" class="mono">${esc(f.destination)}</td>
          <td data-label="Mode" class="mono">${esc(f.mode ?? '—')}</td>
          <td data-label="Owner">${esc(`${f.owner ?? '—'}:${f.group ?? '—'}`)}</td>
          <td data-label="SHA-256" class="mono" title="${esc(f.sha256 ?? '')}">${esc(shortHash(f.sha256))}</td></tr>`).join('')}</tbody>
      </table></div>
      ${st.tar.postInstall !== null
        ? `<details class="script-preview"><summary>files/post-install.sh, run with /bin/bash after install</summary><pre class="keytext">${esc(st.tar.postInstall)}</pre></details>`
        : '<p class="hint">No post-install script.</p>'}
      <details class="script-preview"><summary>manifest.json as it will be written</summary><pre class="keytext">${esc(m?.text ?? '')}</pre></details>`;
  };

  // ── drawing ──
  const draw = () => {
    const done = [step1Done(), step2Done()];
    bodies[0].disabled = st.busy;
    bodies[1].disabled = st.busy || !done[0];
    bodies[2].disabled = st.busy || !done[1];
    steps.forEach((li, i) => {
      const isDone = i < 2 ? done[i] : false;
      const locked = i > 0 && !done[i - 1];
      li.classList.toggle('done', isDone);
      li.classList.toggle('locked', locked);
      /** @type {HTMLElement} */ (li.querySelector('[data-state]')).textContent = isDone ? 'Done' : locked ? `After step ${i}` : '';
    });
    el.querySelectorAll('[data-part]').forEach((p) => { /** @type {HTMLElement} */ (p).hidden = p.getAttribute('data-part') !== st.source; });
    const problem = versionIn.value.trim() ? linuxVersionProblem(versionIn.value.trim()) : null;
    q('[data-version-hint]').innerHTML = problem ? `<span class="error">${esc(problem)}</span>`
      : `${latest ? `Latest is ${esc(latest)}.` : 'The first release.'} A pre-release such as 1.0.1-r is allowed.`;
    drawReview();
    const v = versionIn.value.trim();
    const standing = versions.some((x) => x.version === v);
    q('[data-plan]').innerHTML = done[1]
      ? `<p class="hint">Writes <span class="mono">${esc(appId)}/v${esc(v)}/update.tar.gz</span> and <span class="mono">manifest.json</span>, then the root manifest
          <span class="mono">${esc(appId)}/manifest.json</span>.</p>` : '';
    q('[data-go-label]').textContent = standing ? `Replace v${v}…` : `Publish v${v || '…'}`;
    if (done[0]) prepare();
  };

  // ── events ──
  el.querySelectorAll('[name="lr-source"]').forEach((r) => r.addEventListener('change', () => {
    st.source = /** @type {'build' | 'built'} */ (/** @type {HTMLInputElement} */ (r).value);
    if (st.source === 'build') { versionIn.readOnly = false; descIn.readOnly = false; }
    drawBuilt();
    draw();
  }));
  el.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'lr-many' && t.files) takeMany(t.files);
    else if (t.id === 'lr-built' && t.files) takeBuilt(t.files);
    else if (t.dataset.one && t.files?.[0]) { st.chosen.set(t.dataset.one, t.files[0]); drawRows(); draw(); }
  });
  for (const zone of el.querySelectorAll('.drop')) {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const files = /** @type {DragEvent} */ (e).dataTransfer?.files;
      if (!files?.length) return;
      if (zone.getAttribute('for') === 'lr-built') takeBuilt(files);
      else takeMany(files);
    });
  }
  versionIn.addEventListener('input', draw);
  descIn.addEventListener('input', draw);

  goBtn.addEventListener('click', () => act(goBtn, async () => {
    errorBox.hidden = true;
    const v = versionIn.value.trim();
    const problem = linuxVersionProblem(v);
    if (problem) { flagField(versionIn); throw new ApiError(problem, 400); }
    const description = descIn.value.trim();
    if (!description) { flagField(descIn); throw new ApiError('Describe what this release changes.', 400); }
    if (!step2Done() || !st.tar) throw new PackageError('The package is not ready yet: see step 2.');
    const m = manifestNow();
    if (!m) throw new PackageError('The package is not ready yet: see step 2.');
    const standing = versions.find((x) => x.version === v);
    if (standing && !(await confirmDialog(`Replace v${v}?`, `<p>v${esc(v)} is published already (${esc(fmtDay(standing.released))}: ${esc(standing.description || 'no description')}).
        Replacing it overwrites its tarball and version manifest; the old ones are archived first. Controllers that installed it keep what they have,
        under the same version number.</p>`, 'Replace', true))) return;
    const form = new FormData();
    form.append('appId', appId);
    form.append('version', v);
    form.append('description', description);
    form.append('replace', standing ? '1' : '0');
    form.append('tarball', new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (st.tar.tarGz)], { type: 'application/gzip' }), 'update.tar.gz');
    form.append('manifest', new Blob([m.text], { type: 'application/json' }), 'manifest.json');
    const run = runSteps(q('[data-progress]'), ['Uploading', 'Writing the tarball, the version manifest and the root manifest']);
    st.busy = true;
    draw();
    /** @type {LinuxPublishResult} */
    let res;
    try {
      res = await postForm('/linux-releases', form, { onProgress: (f) => { run.upload(f); if (f >= 1) run.step(1); } });
    } catch (err) {
      run.fail();
      st.busy = false;
      draw();
      throw err;
    }
    run.done();
    await opts.onPublished(res);
  }, (err) => { errorBox.textContent = errorText(err); errorBox.hidden = false; }));

  drawRows();
  drawBuilt();
  draw();
  return { setPackageDirty: (dirty) => { q('[data-dirty]').hidden = !dirty; } };
}

/**
 * Why an uploaded manifest.json will not do here, or null.
 * @param {any} m @param {string} appId
 */
function builtManifestProblem(m, appId) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'manifest.json is not a version manifest.';
  if (m.app_id !== appId) return `manifest.json is for ${String(m.app_id)}, not ${appId}.`;
  const vp = linuxVersionProblem(String(m.version ?? ''));
  if (vp) return `manifest.json: ${vp}`;
  if (!Array.isArray(m.files)) return 'manifest.json has no files list.';
  if (!String(m.description ?? '').trim()) return 'manifest.json has no description; the root manifest needs one.';
  return null;
}

/** The release this page just published. @param {LinuxPublishResult} r */
function publishedCard(r) {
  return `<div class="result published">
    <div class="result-head"><span class="result-icon" data-icon="check"></span>
      <strong>v${esc(r.version)} is ${r.replaced ? 'replaced' : 'published'}</strong></div>
    ${r.latestVersion !== r.version ? `<p class="hint">latest_version stays ${esc(r.latestVersion)}: v${esc(r.version)} is lower.</p>` : ''}
    <div class="key-box">
      <div class="key-head"><span class="section-label">Tarball SHA-256</span>${copyButton('linux-sha', 'tarball SHA-256')}</div>
      <code class="keytext" id="linux-sha">${esc(r.sha256)}</code>
    </div>
    <dl class="facts compact">
      <div><dt>Tarball</dt><dd class="mono">${esc(r.tarballKey)}</dd></div>
      <div><dt>Size</dt><dd>${esc(fmtBytes(r.sizeBytes))}</dd></div>
      <div><dt>Version manifest</dt><dd class="mono">${esc(r.manifestKey)}</dd></div>
      <div><dt>Root manifest</dt><dd class="mono">${esc(r.rootManifestKey)}</dd></div>
      <div><dt>Released</dt><dd>${esc(fmtDay(r.released))}</dd></div>
      <div><dt>latest_version</dt><dd class="mono">${esc(r.latestVersion)}${r.previousLatest && r.previousLatest !== r.latestVersion ? ` <span class="muted">(was ${esc(r.previousLatest)})</span>` : ''}</dd></div>
    </dl>
  </div>`;
}
