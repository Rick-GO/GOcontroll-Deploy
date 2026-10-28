// @ts-check
// The sign-in page of images.gocontroll.tech: an e-mail address and a Turnstile check, sent to
// POST /api/access, which mails a link (images/src/access.ts). Opening that link sets the session
// and goes on to the downloads, or to the one file the customer came for (?next=/download/<path>).
//
// Turnstile: Cloudflare's api.js, rendered explicitly into #human-check with the site key the Worker
// put into its data-sitekey (images/src/index.ts). Never give an element the id "turnstile": the
// browser exposes it as window.turnstile, which then looks like the loaded API (it did, 2026-10-28). It cannot be self-hosted; the CSP of this page
// alone allows it (SIGN_IN_CSP in images/src/headers.ts). A token is single use, so the widget is
// reset after every request. Texts go into the page as text only (images/test/page.test.ts).

import { ACCESS_DAYS, downloadTarget, fileName, LINK_MINUTES, signInNotice } from './format.js';
import { byId } from './ui.js';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const ACTION = 'access'; // TURNSTILE_ACTION in images/src/turnstile.ts

const params = new URLSearchParams(window.location.search);
const target = downloadTarget(params.get('next'));
const form = /** @type {HTMLFormElement} */ (byId('form'));
const email = /** @type {HTMLInputElement} */ (byId('email'));
const send = /** @type {HTMLButtonElement} */ (byId('send'));

/** The widget's current token ('' until the check passed), and its id for reset(). */
let token = '';
/** @type {string | undefined} */
let widgetId;
/** @type {any} */
let turnstile = null;

/** @param {'err' | 'info' | 'ok'} kind @param {string} text */
function notice(kind, text) {
  const box = byId('notice');
  box.className = `notice ${kind}`;
  byId('notice-text').textContent = text;
  box.hidden = false;
}

/** @param {string} text */
function checkText(text) {
  const el = byId('check-text');
  el.textContent = text;
  el.hidden = !text;
}

/** Cloudflare's window.turnstile once api.js has run; null before (or for anything else by that name). */
function turnstileApi() {
  const t = /** @type {any} */ (window).turnstile;
  return t && typeof t.render === 'function' ? t : null;
}

function loadTurnstile() {
  return new Promise((resolve, reject) => {
    const loaded = turnstileApi();
    if (loaded) {
      resolve(loaded);
      return;
    }
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.setAttribute('data-cfasync', 'false');
    s.addEventListener('load', () => {
      const api = turnstileApi();
      if (api) resolve(api);
      else reject(new Error('Turnstile did not start.'));
    });
    s.addEventListener('error', () => reject(new Error('Turnstile could not be loaded.')));
    document.head.append(s);
  });
}

async function startCheck() {
  const box = byId('human-check');
  const siteKey = box.getAttribute('data-sitekey') ?? '';
  if (!siteKey) {
    checkText('The sign-in is not available right now. Please try again later.');
    return;
  }
  try {
    turnstile = await loadTurnstile();
  } catch {
    checkText('The check could not be loaded: check your connection or any content blocker (it needs challenges.cloudflare.com), then reload the page.');
    return;
  }
  try {
    widgetId = turnstile.render(box, {
      sitekey: siteKey,
      action: ACTION,
      theme: 'light',
      language: 'en',
      size: box.clientWidth > 0 && box.clientWidth < 300 ? 'compact' : 'flexible',
      'response-field': false,
      'refresh-expired': 'auto',
      'refresh-timeout': 'auto',
      callback: (/** @type {string} */ t) => { token = t; checkText(''); },
      'expired-callback': () => { token = ''; },
      'timeout-callback': () => { token = ''; },
      'error-callback': () => { token = ''; checkText('The check could not be completed. Reload the page and try again.'); return true; },
      'unsupported-callback': () => { checkText('Your browser cannot run the check. Please use a recent browser.'); },
    });
  } catch {
    checkText('The check could not be started. Reload the page and try again.');
  }
}

function resetCheck() {
  token = '';
  if (turnstile && widgetId !== undefined) turnstile.reset(widgetId);
}

/** @param {string} text */
function emailError(text) {
  const el = byId('email-error');
  el.textContent = text;
  el.hidden = !text;
  email.setAttribute('aria-invalid', String(Boolean(text)));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const address = email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    emailError('Fill in your e-mail address, like name@company.com.');
    email.focus();
    return;
  }
  emailError('');
  if (!token) {
    checkText('Please wait for the check below to finish (or confirm it), then send again.');
    return;
  }
  send.disabled = true;
  send.textContent = 'Sending…';
  try {
    const res = await fetch('/api/access', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: address, turnstile: token, next: target ? `/download/${target}` : '/' }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      byId('sent-to').textContent = body.email || address;
      byId('ask').hidden = true;
      byId('notice').hidden = true;
      byId('sent').hidden = false;
      return;
    }
    if (res.status === 400) emailError(body.error || 'Fill in a valid e-mail address.');
    else notice('err', body.error || 'The link could not be sent. Please try again.');
  } catch {
    notice('err', 'The link could not be sent. Check your connection and try again.');
  } finally {
    send.disabled = false;
    send.textContent = 'Send me the link';
    resetCheck();
  }
});

byId('again').addEventListener('click', () => {
  byId('sent').hidden = true;
  byId('ask').hidden = false;
  email.focus();
});

const first = signInNotice(params);
if (first) notice(first.kind, first.text);
if (target) {
  const forFile = byId('for-file');
  forFile.textContent = `You asked for ${fileName(target)}. After you open the link, its download starts.`;
  forFile.hidden = false;
}
byId('how').textContent = `Enter your e-mail address. We send you a link that opens the downloads. The link works for ${LINK_MINUTES} minutes; once you open it, you have access on that device for ${ACCESS_DAYS} days.`;
byId('sent-how').textContent = `The link works for ${LINK_MINUTES} minutes. After that, ask for a new one here.`;
void startCheck();
