# GOcontroll Downloads — images.gocontroll.tech

The download site for GOcontroll's **customers**: Linux images (root file system, kernel,
bootloader, …) for the Moduline **L4, M1 and HMI1**, and the tools to flash them. A separate
Worker, **`gocontroll-images`**, in this folder of the Deploy repo; it shares nothing with the
intranet Worker of the repo but a few source files, the bucket and one RPC call (the mail with the
sign-in link).

> **Status: open since 2026-10-28** (Deploy 0.6.0; version `ebae60ed-91ed-4a42-afe5-41cef60fc598`, the first open one
> `0bc661ef`; before the site key `5cb45e29`, 503 everywhere). Customers sign in with their e-mail address and a link by
> mail (no Cloudflare Access, no one-time PIN). The Turnstile widget *GOcontroll Downloads* exists (site key in
> `TURNSTILE_SITE_KEY`, secret in `IMAGES_TURNSTILE_SECRET`, checked on 2026-10-28: siteverify accepts it). Not yet seen:
> a real link mailed and opened. There are no images yet either; the page shows "No images have been published yet."
> until there are.

## How it works

- **Who publishes**: colleagues, on the Images tab of Deploy (`deploy.gocontroll.tools`, the intranet
  Worker of this repo, `../src/images.ts`). It uploads the files into the R2 bucket
  **`gocontroll-images`** and writes **`manifest.json`**, the published catalogue. It is the only
  writer of both.
- **Who downloads**: customers, on `https://images.gocontroll.tech`. They type their e-mail address
  (with a Cloudflare Turnstile check), get a **link by mail** from `noreply@gocontroll.com`, and
  opening it gives them access **on that device for 7 days**. The link works for **60 minutes**. No
  accounts, no passwords, nothing to install.
- **Who mails**: the intranet Worker, through its RPC entrypoint **`ImagesMail`**
  (`../src/images-mail.ts`), which this Worker binds as `MAIL`. The Microsoft 365 secret stays on the
  intranet; ImagesMail sends one fixed message, only to the address it is given and only with a link to
  this site.
- **This Worker** shows the catalogue, streams the files it names, and writes one log entry per
  download (with the address that signed in). It never writes a release or the manifest.
- **Counts**: the Images tab of Deploy shows per release how often it was downloaded (in all, this
  month, last month), per month the downloads, the number of different addresses and the countries, and
  the latest downloads with who. Finished months are kept without addresses (`../src/images-stats.ts`).

The contract between the two Workers — the bucket layout, the catalogue format, which files may be
served, the download log, the sign-in mail — is **`../src/images-format.ts`** (no imports, bundled by
both). It is not repeated here. In short: `manifest.json`, `images/<product>/<version>/<file>`,
`tools/<product>/<version>/<file>`, `downloads/<yyyy>/<mm>/<time>-<random>.json`, `access-mails/<hmac>`.

### Every request, in this order (`src/index.ts`)

1. **Plain HTTP** → 301 (GET/HEAD) or 308 to the same path and query on `https://`
   (`../src/lib/https.ts`, the same module as the intranet Worker; `localhost` never).
2. **`TURNSTILE_SITE_KEY` empty** → **503** for everything: the pages, the assets, the API, the files
   and the sign-in (a self-contained page, or JSON under `/api/`). Locally `DEV_USER_EMAIL` on a
   `localhost` URL passes.
3. The routes:

| Path | Answer |
|---|---|
| `POST /api/access` | ask for a link (below); the only POST |
| `GET /access?t=<token>` | the link from the mail: valid → the session cookie and **303** to where the customer was going (`/` or `/download/<path>`); expired → `/sign-in?link=expired` (keeping `next`); anything else → `/sign-in?link=invalid` |
| `GET /sign-in` | the sign-in page, for anyone, with the widget's site key put into `#turnstile` (`data-sitekey`) and the only CSP that allows Turnstile; signed in already → 303 onwards |
| `GET /sign-out` | the cookie cleared, 303 to `/sign-in?signed-out` |
| `GET /` | the downloads page; without a session 303 to `/sign-in` |
| `GET /download/<path>` | the page that shows one file and starts its download; without a session 303 to `/sign-in?next=/download/<path>`; a path that is not `<images\|tools>/<product>/<version>/<file>` → 404 |
| `GET /api/catalogue` | `{ email, catalogue }`: `manifest.json` through `parseCatalogue` (no manifest yet = the empty catalogue); `cache-control: private, no-store`; a manifest that is not JSON = 503; without a session **401** `{ error, signIn }` |
| `GET` / `HEAD /files/<path>` | the file, only when `findPublishedFile` finds `<path>` in the catalogue. A draft whose files are already in the bucket, `downloads/…`, `manifest.json`, an unknown path, a `%` escape, `..`: 404. Without a session 303 to the sign-in page, back to `/download/<path>` |
| anything else | the static assets (scripts, stylesheet, brand images, `robots.txt`): public, they hold no data. The pages by file name (`/index.html`, `/sign-in.html`, `/download.html`, `/download`, `/index`): 404 |

The session key unreadable (Secrets Store down, or not a key) → 503 for everything that needs it:
nobody gets in and nobody is signed out.

Every answer — pages, assets, API, files, redirects, 303/401/404/405/416/503 — carries the security
headers of `src/headers.ts` (CSP without inline script or style and without `data:`, nosniff,
Referrer-Policy, `X-Frame-Options: DENY`, HSTS for this host only, **`X-Robots-Tag: noindex, nofollow`**).
Only the sign-in page may load `https://challenges.cloudflare.com` (script and frame, `SIGN_IN_CSP`).
`robots.txt` keeps crawlers off `/api/`, `/files/`, `/download/` and `/access`; the sign-in page stays
crawlable so its `noindex` is seen. The plain pages (503, 404, 405) load nothing.

### Signing in (`src/access.ts`, `src/session.ts`, `src/turnstile.ts`)

`POST /api/access` `{ email, turnstile, next }`, from the sign-in page only, checked in this order:

1. **Same origin** (`Origin` = `SITE_URL`, or the localhost origin locally), JSON, at most 8 kB → else 403/415/413/400.
2. **`RL_ACCESS`** per client IP (Workers rate limiting, 5 per minute; a brake, not a lock) → 429.
3. **A valid e-mail address** (`normaliseEmail`: trimmed, lower case, plain ASCII) → else 400.
4. **Turnstile**: siteverify with `IMAGES_TURNSTILE_SECRET`, solved on this site's hostname for the
   action `access` → else 403; no secret (`not-set`), a secret siteverify does not know
   (`invalid-input-secret`), siteverify down or Cloudflare's own error → 503 (not the visitor's fault).
5. **At most 5 links per address per hour**: one empty object `access-mails/<HMAC of the address>` with
   the times in its custom metadata `sent` (the key does not reveal the address; an R2 lifecycle rule
   deletes these after a day) → 429.
6. The link signed and handed to **`MAIL.sendAccessLink({ email, link, file? })`**; its `{ ok: false }`
   or a failed call → 503 "could not be sent". Then **200** `{ ok, email }`.

Tokens are signed by this Worker with **`SESSION_KEY`** (HMAC-SHA256; Secrets Store `IMAGES_SESSION_KEY`):

| Token | Form | Life | Holds |
|---|---|---|---|
| link (in the mail) | `l.<payload>.<sig>` in `?t=` | 60 minutes | address, expiry, where to go (`next`) |
| session (cookie `__Host-images-session`) | `s.<payload>.<sig>` | 7 days | address, expiry |

`payload` is base64url JSON, `sig` = base64url HMAC over `<kind>.<payload>`, so a link never passes as a
session or the other way round. The cookie is `Secure; HttpOnly; SameSite=Lax; Path=/`, host-only.
`next` is only ever `/` or `/download/<release file path>` (`safeNext`): a link can never send anyone
off this site. Nothing is kept on the server: a link opens as often as it is clicked within its hour (a
mail scanner may open it first), and a new `SESSION_KEY` ends every session and link at once.

### Downloads (`src/files.ts`)

- Headers: `content-type: application/octet-stream`, `content-disposition: attachment; filename="<name>"`,
  `content-length`, `etag`, `last-modified`, `accept-ranges: bytes`, `cache-control: private, no-store`.
- **Conditional requests**: `If-None-Match`/`If-Modified-Since` → 304, `If-Match`/`If-Unmodified-Since`
  → 412 (R2 evaluates the request's headers, as in `moduline-firmware/worker`).
- **Ranges**: one range (`bytes=a-b`, `bytes=a-`, `bytes=-n`) → 206 with `content-range`; past the
  end → 416 with `content-range: bytes */<size>`; a malformed or multi-range header is ignored (the
  whole file). The Range header is parsed here and passed to R2 as an explicit range: R2 refuses an
  unsatisfiable explicit range (10039, answered with 416), while one passed as headers can be ignored
  silently (Miniflare sends the whole object). `If-Range` is honoured
  (strong ETag or the Last-Modified date), so resuming a file that changed starts over.
- **The download log**: one empty object `downloads/<yyyy>/<mm>/<ISO time>-<12 hex>.json` per download,
  with `DownloadMeta` as custom metadata: `email` (from the session: the address that opened the link),
  `path`, `kind`, `product`, `version`, `country` (`request.cf.country`, or empty). Written in
  `waitUntil` only for a GET that starts the file and gets the bytes (no Range, or a range from byte 0):
  never for HEAD, a 304, a refusal or a range further into the file, so a resumed or chunked download
  counts once. The log is personal data (an e-mail address per download): only the intranet reads it;
  it expires after 395 days (step 3 below). The sign-in page says so.

### The pages (`public/`)

Plain ES modules with `// @ts-check` and JSDoc, no framework, no build step, as the intranet apps.

- **`sign-in.html` + `sign-in.js`**: the e-mail address, the Turnstile widget (Cloudflare's `api.js`,
  rendered explicitly, reset after every request), *Send me the link*; then *Check your e-mail* (from
  noreply@gocontroll.com, look in spam) and *Use another address or send again*. Says what the address
  is used for. Coming from a file link it names the file. Notices for an expired or broken link and for
  signing out (`signInNotice`).
- **`index.html` + `app.js`**: header with the logo, "Downloads", the signed-in address and *Sign out*
  (`/sign-out`); the anthracite hero; **Controller images** with a filter All / L4 / M1 / HMI1 (kept in
  the address, `#M1`); **Tools**; *Verify your download*. Per product its releases newest first, the
  newest open, older ones collapsed (`<details>`); per release the version, release date (en-GB),
  controllers, notes as plain text and the files: name, role, platform (not when `any`), size, SHA-256
  with *Copy*, *Download*.
- **`download.html` + `download.js`**: `/download/<path>`, the link to give a customer for one file
  (Deploy's Images tab copies it): the release, the file card, "Your download has started" (it starts
  once when the page opens; the browser stays on the page), and the checksum commands with the file's
  own name. A file that is not published (any more): a notice and a link to all downloads.
- **`ui.js`**: the DOM helpers, the file card and loading the catalogue (401 → to `/sign-in`, back
  to the page). **`format.js`**: labels, sizes, dates, grouping, the sign-in notices, the checksum
  commands, without the DOM; its label maps and durations are copies of `../src/images-format.ts`
  (the source; the test fails when they drift apart).

Catalogue text only ever goes into a page as text (`textContent`, `setAttribute`): no script has
`innerHTML` at all (`test/page.test.ts` checks it). `public/tsconfig.json` is not served
(`public/.assetsignore`).

## Bindings

`IMAGES_BUCKET` (R2 `gocontroll-images`), `ASSETS`, **`MAIL`** (service binding to
`gocontroll-deploy-intranet`, entrypoint `ImagesMail`), **`RL_ACCESS`** (rate limit, namespace 4731),
the Secrets Store secrets **`SESSION_KEY`** (`IMAGES_SESSION_KEY`) and **`TURNSTILE_SECRET`**
(`IMAGES_TURNSTILE_SECRET`), and the vars `SITE_URL` and `TURNSTILE_SITE_KEY`. No state bucket, no D1,
no Microsoft 365 secret, no other service: anyone on the internet reaches this Worker, so nothing here
may lead to the intranet's data, and the most `MAIL` can do is mail a link to this site to one address.
`test/config.test.ts` pins the list.

## Development and tests

From the repo root (the scripts live in the root `package.json`):

```bash
npm run test:images                 # this suite only (vitest --config images/vitest.config.ts)
npm test                            # the intranet suite, then this one
npm run typecheck                   # includes tsc -p images and tsc -p images/public
npx wrangler dev -c images/wrangler.toml
```

Locally, put `DEV_USER_EMAIL=you@example.com` in `images/.dev.vars` (not in git): honoured only on a
`localhost` URL, and then no site key, link or cookie is needed. The sign-in itself cannot run locally
(no ImagesMail behind `MAIL`). `wrangler dev` uses a local, empty bucket; put a `manifest.json` there
with `npx wrangler r2 object put gocontroll-images/manifest.json --file=manifest.json --local -c images/wrangler.toml`.

The tests run in the Workers runtime (Miniflare) with the real assets, a local bucket that each test
empties first (the pool keeps storage between tests, so the files run one after the other), the two
secrets in Miniflare's local store (`test/setup.ts`), Cloudflare's always-passing Turnstile site key,
a stand-in Worker for `ImagesMail` (`vitest.config.ts`) and, where a test looks at what was sent, a
recording fake instead. siteverify is stubbed; nothing leaves the test.

## Deploy

```bash
npm run deploy:images               # typecheck + both suites, then wrangler deploy -c images/wrangler.toml
```

Before the first deploy with these bindings (all done on 2026-10-28):

- the bucket **`gocontroll-images`** (`npx wrangler r2 bucket create gocontroll-images`; shared with the
  Images tab of Deploy);
- the store secrets **`IMAGES_SESSION_KEY`** (made by the session, never seen:
  `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secrets-store secret create 33801ac6937549ae8f6f92169586a707 --name IMAGES_SESSION_KEY --scopes workers --remote`)
  and **`IMAGES_TURNSTILE_SECRET`** (made with the value `not-set`; the owner pastes the real one);
- the intranet Worker deployed with the entrypoint `ImagesMail` (Deploy 0.6.0): `npm run deploy` first,
  then `npm run deploy:images`.

The first deploy (2026-10-28) created the custom domain `images.gocontroll.tech` (zone
`gocontroll.tech`). With `TURNSTILE_SITE_KEY` empty it answers 503 everywhere, so deploying before the
widget exists is safe.

After a deploy:

```bash
curl -sI https://images.gocontroll.tech/            # 503 while TURNSTILE_SITE_KEY is empty; afterwards 303 to /sign-in
curl -sI https://images.gocontroll.tech/sign-in     # 200, content-security-policy with challenges.cloudflare.com, x-robots-tag
curl -sI http://images.gocontroll.tech/             # 301 to https://
```

**Rolling back**: `npx wrangler deployments list -c images/wrangler.toml` →
`npx wrangler rollback <version-id> -c images/wrangler.toml`. The version before the e-mail sign-in is
`9a2c1639-79b6-4057-9c8e-b5b98b4483cd` (Access with one-time PIN, 503 without an Access application).
Closing the site at once without a rollback: set `TURNSTILE_SITE_KEY = ""` and deploy (503 everywhere),
or withdraw releases on the Images tab of Deploy (a file stops being served as soon as `manifest.json`
no longer names it). Ending every session: a new value for `IMAGES_SESSION_KEY` (no deploy needed).
Removing it altogether: `npx wrangler delete gocontroll-images` (the custom domain goes with it; the
bucket stays).

## One-time setup

### 1. The Turnstile widget (the owner, in the dashboard; done 2026-10-28)

The wrangler login has no Turnstile rights, so the owner does this. Cloudflare dashboard →
**Turnstile** → *Add widget*:

- Name **GOcontroll Downloads**; hostname **`images.gocontroll.tech`** (only that one).
- Widget mode **Managed**; no pre-clearance.
- Create, then:
  - the **secret key**: Secrets Store → `default_secrets_store` → `IMAGES_TURNSTILE_SECRET` → *Edit* →
    paste it (no deploy needed);
  - the **site key** (not a secret): to the session, which puts it in `TURNSTILE_SITE_KEY` in
    `images/wrangler.toml`, commits and deploys. From then on the site is open.
- Check: `curl -sI https://images.gocontroll.tech/` → 303 to `/sign-in`; in a private window ask for a
  link with your own address, open it, see the downloads; *Sign out*; open the link of a file
  (`/download/…`, *Copy link* on the Images tab) and see it ask, then start that file.

Way back: `TURNSTILE_SITE_KEY = ""` and deploy (503 everywhere); the widget can stay.

No Cloudflare Access application, no one-time PIN login method and no WAF rule are needed (the plan
before 2026-10-28): Turnstile is the human check, and the account-wide one-time PIN never had to be
switched on, so the intranet's Access applications are unaffected.

### 2. Expire the hourly cap (done 2026-10-28)

R2 → bucket **`gocontroll-images`** → lifecycle rule `expire-access-mails`, prefix `access-mails/`,
**delete objects 1 day** after upload. Made by the session with
`npx wrangler r2 bucket lifecycle add gocontroll-images expire-access-mails access-mails/ --expire-days 1`.

Way back: `npx wrangler r2 bucket lifecycle remove gocontroll-images --name expire-access-mails`.

### 3. Expire the download log (done 2026-10-28)

R2 → bucket **`gocontroll-images`** → *Settings* → **Object lifecycle rules**: rule `expire-download-log`,
prefix `downloads/`, **delete objects 395 days** after upload (13 months and a margin). The log holds an
e-mail address per download; this keeps it from growing forever. The counts per month stay (Deploy's
`images/stats/`, without addresses). Never a rule without a prefix: it would delete the images. Made by
the session with
`npx wrangler r2 bucket lifecycle add gocontroll-images expire-download-log downloads/ --expire-days 395`
(next to R2's default rule that aborts unfinished multipart uploads after 7 days).

Way back: `npx wrangler r2 bucket lifecycle remove gocontroll-images --name expire-download-log`
(objects already expired stay deleted).

## Files

| File | What |
|---|---|
| `wrangler.toml` | the Worker: custom domain, assets, the bucket, `MAIL`, `RL_ACCESS`, the two secrets, `SITE_URL`, `TURNSTILE_SITE_KEY` |
| `src/index.ts` | the request flow above |
| `src/access.ts` | `POST /api/access` (ask for a link) and `GET /access` (open it) |
| `src/session.ts` | the link and session tokens, the cookie, `safeNext`, `DEV_USER_EMAIL` on localhost |
| `src/turnstile.ts` | siteverify (adapted from GOcontroll-Configurator) |
| `src/files.ts` | `/files/`: published paths only, ranges, conditionals, the download log |
| `src/catalogue.ts` | `manifest.json` → `Catalogue` |
| `src/headers.ts`, `src/respond.ts` | security headers (and the sign-in CSP); JSON, redirects and the plain pages |
| `public/` | the pages: `sign-in`, `index`, `download` (`.html` + `.js`), `ui.js`, `format.js`, `styles.css`, `robots.txt`, logo, favicons |
| `test/` | the suite (`npm run test:images`) |
| `../src/images-format.ts` | the contract with the intranet Worker (not in this folder) |
| `../src/images-mail.ts` | ImagesMail, the intranet's entrypoint that sends the link (not in this folder) |
