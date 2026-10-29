// @ts-check
// The danger zone at the bottom of a folder page: delete the application folder from the
// distribution bucket. Never one click: the dialog says what goes, and Delete stays disabled
// until the App ID is typed out, a reason of at least 10 characters is given and, when
// controllers still run this App ID, that is acknowledged. The Worker archives every object
// to the private state bucket before it deletes it (the manifest first) and keeps the
// public key; it works in batches, so the dialog repeats the same DELETE until it is done.
// A delete that stopped halfway continues where it was when Delete is pressed again.

import { ApiError, api, folderPath } from './api.js';
import { fmtBytes, fmtCount, plural } from './format.js';
import { $, esc, field, holdDialog } from './lib.js';
import { formDialog, formValues } from './ui.js';

/**
 * @typedef {import('./ui.js').Ctx} Ctx
 * @typedef {import('./api.js').FolderDetail} FolderDetail
 * @typedef {import('./api.js').DeleteStep} DeleteStep
 */

/** The shortest reason the Worker accepts. */
const MIN_REASON = 10;

/** @param {FolderDetail} d */
export const dangerPanel = (d) => `<section class="panel danger-zone">
  <div class="panel-head"><h2>Danger zone</h2></div>
  <p class="text">Delete this application folder from the distribution bucket: its manifest and every file under <span class="mono">${esc(d.appId)}/</span>.
    Everything is archived in Deploy's private state bucket first, and the public key is kept.</p>
  <div class="btn-row"><button type="button" class="btn sm danger" data-delete data-icon="trash">Delete application folder…</button></div>
</section>`;

/**
 * What a delete takes away, in words. @param {FolderDetail} d
 */
function whatGoes(d) {
  const other = d.otherObjects ?? [];
  const otherBytes = other.reduce((n, o) => n + (o.size ?? 0), 0);
  if (d.kind === 'linux') {
    const n = d.linuxVersions?.length ?? 0;
    const bytes = (d.linuxVersions ?? []).reduce((s, v) => s + (v.sizeBytes ?? 0), 0) + otherBytes;
    return `the manifest, ${plural(n, 'version')} with their files${other.length ? ` and ${plural(other.length, 'other file')}` : ''}${bytes ? ` (${fmtBytes(bytes)})` : ''}`;
  }
  const stored = (d.releases ?? []).filter((r) => r.size !== null);
  const bytes = stored.reduce((s, r) => s + (r.size ?? 0), 0) + otherBytes;
  const parts = [d.releases?.length || d.latest ? 'the manifest' : 'the manifest, if there is one'];
  parts.push(plural(stored.length, 'release binary', 'release binaries'));
  if (other.length) parts.push(plural(other.length, 'other file'));
  return `${parts.join(', ')}${bytes ? ` (${fmtBytes(bytes)})` : ''}`;
}

/**
 * Ask, then delete. On success the colleague lands on Applications with a notice.
 * @param {Ctx} ctx @param {FolderDetail} d
 */
export async function deleteFolder(ctx, d) {
  const appId = d.appId;
  /** @type {HTMLDialogElement} */
  const dialog = $('form-dialog');
  const st = { controllers: d.controllers?.total ?? 0, deleted: 0 };
  /** @type {{ archive: string | null }} */
  const out = { archive: null };
  const ackText = () => `I understand that ${plural(st.controllers, 'controller')} still run${st.controllers === 1 ? 's' : ''} ${appId} and will find no updates here any more`;

  const ok = await formDialog({
    title: `Delete ${appId}?`,
    submitLabel: 'Delete',
    danger: true,
    body: `<div class="notice err"><strong>This removes <span class="mono">${esc(appId)}</span> from the distribution bucket</strong>: ${esc(whatGoes(d))}.
        Controllers and the Deployment Tool that read <span class="mono">${esc(appId)}/manifest.json</span> find nothing there any more.</div>
      <ul class="plain-list">
        <li>Every object is copied to Deploy's private state bucket first (<span class="mono">deleted/${esc(appId)}/…</span>), then deleted.
          The manifest goes first, so nothing ever reads a manifest that points at deleted files.</li>
        <li>The public key is kept: controllers in the field carry it, and a folder made again under this App ID is signed with the same key pair.</li>
        <li>The folder can be put back from the archive (README, "Restoring a deleted folder").</li>
      </ul>
      <div class="notice warn" data-controllers${st.controllers ? '' : ' hidden'}><span data-controllers-text>${esc(controllersLine(d, st.controllers))}</span></div>
      <label class="check ack" data-ack${st.controllers ? '' : ' hidden'}><input type="checkbox" name="acknowledgeControllers"> <span data-ack-text>${esc(ackText())}</span></label>
      ${field('Type the App ID to confirm', (id) => `<input id="${id}" name="confirm" class="mono" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${esc(appId)}">`)}
      ${field('Reason', (id) => `<textarea id="${id}" name="reason" rows="2" maxlength="500" placeholder="Why this folder goes, for the log"></textarea>`, '',
        `<span data-reason-hint>At least ${MIN_REASON} characters; it goes into the log with your name.</span>`)}
      <div class="run" data-delete-progress hidden></div>`,
    onOpen: (form) => {
      const reason = /** @type {HTMLTextAreaElement} */ (form.querySelector('[name=reason]'));
      const hint = /** @type {HTMLElement} */ (form.querySelector('[data-reason-hint]'));
      reason.addEventListener('input', () => {
        const n = reason.value.trim().length;
        hint.textContent = n >= MIN_REASON ? 'It goes into the log with your name.' : `At least ${MIN_REASON} characters (${n} so far); it goes into the log with your name.`;
      });
    },
    valid: (form) => {
      const v = formValues(form);
      return String(v.confirm ?? '').trim() === appId
        && String(v.reason ?? '').trim().length >= MIN_REASON
        && (st.controllers === 0 || Boolean(v.acknowledgeControllers));
    },
    submit: async (form) => {
      const v = formValues(form);
      const body = { confirm: appId, reason: String(v.reason).trim(), acknowledgeControllers: Boolean(v.acknowledgeControllers) };
      const progress = /** @type {HTMLElement} */ (form.querySelector('[data-delete-progress]'));
      holdDialog(dialog, true);
      progress.hidden = false;
      let stuck = 0;
      try {
        for (;;) {
          /** @type {DeleteStep} */
          let step;
          try {
            step = await api('DELETE', folderPath(appId), body);
          } catch (err) {
            // More controllers than the page knew of: show them, and ask for the tick.
            if (err instanceof ApiError && err.status === 409 && err.body?.field === 'acknowledgeControllers') {
              st.controllers = Math.max(1, Number(err.body.controllers) || 0);
              /** @type {HTMLElement} */ (form.querySelector('[data-controllers]')).hidden = false;
              /** @type {HTMLElement} */ (form.querySelector('[data-controllers-text]')).textContent = controllersLine(d, st.controllers);
              /** @type {HTMLElement} */ (form.querySelector('[data-ack]')).hidden = false;
              /** @type {HTMLElement} */ (form.querySelector('[data-ack-text]')).textContent = ackText();
            }
            throw err;
          }
          st.deleted += step.deleted;
          out.archive = step.archive;
          drawProgress(progress, st.deleted, step.remaining, step.done);
          if (step.done) break;
          stuck = step.deleted ? 0 : stuck + 1;
          if (stuck >= 3) throw new ApiError('The delete makes no progress. Press Continue deleting to go on where it stopped.', 503);
        }
      } catch (err) {
        // The Worker keeps where it was: the same call goes on in the same archive.
        if (st.deleted) $('form-dialog-submit').textContent = 'Continue deleting';
        throw err;
      } finally {
        holdDialog(dialog, false);
      }
    },
  });
  if (!ok) return;
  ctx.flash = `<div class="notice ok">Application folder <span class="mono">${esc(appId)}</span> is deleted: ${plural(st.deleted, 'object')} archived
    ${out.archive ? `under <span class="mono">${esc(out.archive)}</span> ` : ''}in Deploy's state bucket.${d.key ? ` Its public key is kept, so ${esc(appId)} still shows under Applications.` : ''}</div>`;
  location.hash = '#/applications';
}

/** @param {FolderDetail} d @param {number} n */
function controllersLine(d, n) {
  const online = n === (d.controllers?.total ?? 0) ? d.controllers?.online ?? 0 : null;
  return `${plural(n, 'controller')} still run${n === 1 ? 's' : ''} this App ID${online !== null ? ` (${fmtCount(online)} online now)` : ''}. They stop finding updates here.`;
}

/** @param {HTMLElement} el @param {number} deleted @param {number} remaining @param {boolean} done */
function drawProgress(el, deleted, remaining, done) {
  const total = deleted + remaining;
  const pct = total ? Math.round((deleted / total) * 100) : 100;
  el.innerHTML = `<p class="hint">${done ? 'Done' : 'Archiving and deleting'}: ${fmtCount(deleted)} of ${fmtCount(total)} objects.</p>
    <progress class="upload-bar" max="100" value="${pct}" aria-label="Delete progress"></progress>`;
}
