// @ts-check
// The firmware file picker of Publish and Sign: a file field that also takes a dropped
// file. A chosen file is read and compressed right away (source.js), so a file that will
// not do says so before anything is sent, and the version can be filled in from it.

import { errorText } from './api.js';
import { fmtBytes, fmtCount } from './format.js';
import { esc, hydrateIcons, uniqueId } from './lib.js';
import { ACCEPT, STM32_FLASH_BASE, compress, readSource } from './source.js';

/**
 * @typedef {import('./source.js').Source} Source
 * @typedef {{ file: File, source: Source, payload: Uint8Array | null }} Picked
 *   payload: the compressed image of a raw source; null for a container (sent as it is)
 * @typedef {{ get: () => Picked | null, reading: () => boolean, clear: () => void }} FilePicker
 */

/** @param {number} n */
const hex8 = (n) => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

/**
 * Draw the picker into `root`. onChange gets the prepared file, or null while there is none
 * (nothing chosen, still reading, or a file that will not do).
 * @param {HTMLElement} root
 * @param {(picked: Picked | null) => void} onChange
 * @returns {FilePicker}
 */
export function mountFilePicker(root, onChange) {
  const id = uniqueId('file');
  root.innerHTML = `<div class="field">
    <span class="label" id="${id}-label">Firmware file</span>
    <label class="drop" for="${id}">
      <span class="drop-icon" data-icon="arrow-up-tray"></span>
      <span class="drop-text"><strong>Choose a file</strong> or drop it here</span>
      <span class="drop-hint">A .bin or an S-record (.srec, .s19, .s28, .s37, .mot, .hex). A ready-made GOCO container goes as it is.</span>
      <input type="file" id="${id}" class="drop-input" accept="${esc(ACCEPT)}" aria-labelledby="${id}-label">
    </label>
    <div class="file-info" hidden aria-live="polite"></div>
  </div>`;
  hydrateIcons(root);
  const drop = /** @type {HTMLLabelElement} */ (root.querySelector('.drop'));
  const input = /** @type {HTMLInputElement} */ (root.querySelector('input[type=file]'));
  const info = /** @type {HTMLElement} */ (root.querySelector('.file-info'));
  /** @type {Picked | null} */
  let current = null;
  let token = 0;
  let busy = false;

  const clear = () => {
    token++;
    busy = false;
    current = null;
    input.value = '';
    info.hidden = true;
    info.innerHTML = '';
    drop.hidden = false;
    onChange(null);
  };

  /** @param {File} file */
  const take = async (file) => {
    const mine = ++token;
    busy = true;
    current = null;
    onChange(null);
    info.hidden = false;
    info.innerHTML = `<div class="loading"><span class="spinner dark"></span> Reading ${esc(file.name)}…</div>`;
    try {
      const source = await readSource(file);
      let payload = null;
      if (source.kind === 'raw') {
        if (mine === token) info.innerHTML = `<div class="loading"><span class="spinner dark"></span> Compressing ${esc(file.name)}…</div>`;
        payload = await compress(source.bytes);
      }
      if (mine !== token) return;
      busy = false;
      current = { file, source, payload };
      info.innerHTML = describe(current);
      hydrateIcons(info);
      drop.hidden = true;
      onChange(current);
    } catch (err) {
      if (mine !== token) return;
      busy = false;
      input.value = '';
      info.innerHTML = `<div class="notice err">${esc(file.name)}: ${esc(errorText(err))}</div>`;
      onChange(null);
    }
  };

  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) take(f); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) take(f);
  });
  info.addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('[data-clear]')) { clear(); input.focus(); }
  });

  return { get: () => current, reading: () => busy, clear };
}

/** What was read out of the file. @param {Picked} p */
function describe(p) {
  const s = p.source;
  /** @type {[string, string][]} */
  const facts = [];
  if (s.kind === 'container') {
    const h = s.header;
    facts.push(['Kind', `GOCO container${h ? (h.signed ? ', signed' : ', unsigned') : ''}`]);
    if (h) {
      facts.push(['App ID in the header', h.appId || '(empty)']);
      facts.push(['Version in the header', h.version]);
      facts.push(['Image', fmtBytes(h.uncompressedSize)]);
    }
    facts.push(['File', fmtBytes(p.file.size)]);
  } else {
    const gapBytes = s.gaps.reduce((n, g) => n + g[1], 0);
    facts.push(['Kind', s.format === 'srec' ? 'S-record' : 'Raw binary']);
    facts.push(['Image', `${fmtBytes(s.rawSize)} from ${hex8(STM32_FLASH_BASE)}`]);
    if (s.format === 'srec') {
      facts.push(['Gaps', s.gaps.length ? `${fmtCount(s.gaps.length)} (${fmtBytes(gapBytes)}), filled with 0xFF` : 'none']);
    }
    if (p.payload) facts.push(['Compressed', `${fmtBytes(p.payload.length)} (${Math.round((p.payload.length / Math.max(1, s.rawSize)) * 100)}%)`]);
  }
  if (s.versionFromName) facts.push(['Version in the name', s.versionFromName]);
  return `<div class="file-card">
    <div class="file-name"><span class="file-icon" data-icon="document"></span><strong>${esc(p.file.name)}</strong>
      <button type="button" class="link-btn" data-clear>Choose another file</button></div>
    <dl class="facts compact">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${s.kind === 'container' && !s.header ? '<div class="notice warn">This container header could not be read here; the Worker checks it when you send it.</div>' : ''}
  </div>`;
}

/** The version the file suggests: from its name, else from its container header. @param {Picked | null} p */
const suggestedVersion = (p) => (p ? p.source.versionFromName ?? p.source.header?.version ?? '' : '');

/**
 * Fill in the version field from a newly chosen file, unless the colleague typed one: what
 * is typed wins (the Deployment Tool's rule). `state.auto` remembers the last value filled in.
 * @param {HTMLInputElement} input @param {Picked | null} p @param {{ auto: string }} state
 */
export function prefillVersion(input, p, state) {
  if (!p) return;
  const now = input.value.trim();
  if (now && now !== state.auto) return;
  const v = suggestedVersion(p);
  input.value = v;
  state.auto = v;
}

/**
 * The form fields that carry the file to the Worker: the compressed payload and its raw
 * size, or the container as it is.
 * @param {FormData} form @param {Picked} p
 */
export function appendFile(form, p) {
  if (p.source.kind === 'container') {
    form.append('container', new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (p.source.bytes)], { type: 'application/octet-stream' }), p.file.name);
  } else {
    form.append('payload', new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (p.payload)], { type: 'application/octet-stream' }), 'payload.zlib');
    form.append('rawSize', String(p.source.rawSize));
  }
}
