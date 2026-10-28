// @ts-check
// The download page /download/<path> of images.gocontroll.tech: the link to give a customer for one
// file (Deploy's Images tab copies it). It shows the file, starts its download once (the browser
// stays on this page: the file is an attachment) and says how to check the SHA-256. Without a
// session the Worker sends the browser to /sign-in?next=… first, and back here after the link.
//
// Texts go into the page as text only (images/test/page.test.ts).

import { controllersText, downloadTarget, findFile, formatDate, verifyCommands } from './format.js';
import { byId, fileItem, h, loadCatalogue, showWho, wireCopyButtons } from './ui.js';

const path = downloadTarget(window.location.pathname);

/** @param {string} text */
function showError(text) {
  byId('loading').hidden = true;
  byId('file-panel').hidden = true;
  byId('notice-text').textContent = text;
  byId('notice').hidden = false;
}

async function load() {
  const data = await loadCatalogue(window.location.pathname);
  if (!data) return;
  if ('error' in data) {
    showError(data.error);
    return;
  }
  showWho(data.email);
  const hit = path ? findFile(data.catalogue, path) : null;
  if (!hit) {
    byId('title').textContent = 'File not available';
    showError('This file is not available (any more). A newer version may be on the start page.');
    return;
  }
  const { release, file } = hit;
  document.title = `${file.name} · GOcontroll Downloads`;
  byId('title').textContent = `${release.title} ${release.version}`;
  const date = formatDate(release.released);
  byId('lede').textContent = [date ? `Released ${date}` : '', controllersText(release)].filter(Boolean).join(' · ');
  byId('file-title').textContent = file.name;
  byId('file-sub').textContent = `${release.title}, version ${release.version}`;
  byId('file-list').replaceChildren(fileItem(file));
  byId('started').textContent = 'Your download has started. If it does not, use the Download button.';
  byId('verify-list').replaceChildren(...verifyCommands(file.name).map((c) =>
    h('div', {}, h('dt', {}, c.system), h('dd', {}, h('code', {}, c.command)))));
  byId('loading').hidden = true;
  byId('file').hidden = false;
  byId('verify').hidden = !file.sha256;
  // Once per opening of the page; the Download button stays for another try.
  window.location.assign(`/files/${file.path}`);
}

wireCopyButtons();
void load();
