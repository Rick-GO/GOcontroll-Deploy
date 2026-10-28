# GOcontroll Downloads — images.gocontroll.tech

The download site for GOcontroll's **customers**: Linux images (root file system, kernel,
bootloader, …) for the Moduline **L4, M1 and HMI1**, and the tools to flash them. A separate
Worker, **`gocontroll-images`**, in this folder of the Deploy repo; it shares nothing with the
intranet Worker of the repo but three source files and the bucket.

> **Status: built, not deployed.** No Cloudflare resources exist for it yet. Until the owner has done
> the [one-time setup](#one-time-setup-in-the-cloudflare-dashboard), every request gets
> **503 "Downloads are being set up"** (`IMAGES_AUD` is empty: fail closed). There are no images
> yet either; the page shows "No images have been published yet." until there are.

## How it works

- **Who publishes**: colleagues, on the Images tab of Deploy (`deploy.gocontroll.tools`, the intranet
  Worker of this repo, `../src/images.ts`). It uploads the files into the R2 bucket
  **`gocontroll-images`** and writes **`manifest.json`**, the published catalogue. It is the only
  writer of both.
- **Who downloads**: customers, on `https://images.gocontroll.tech`, behind its own Cloudflare Access
  application with one login method, the **one-time PIN** (the customer types an e-mail address and
  gets a code by mail), and a managed challenge in front of it (a WAF rule). Both are dashboard
  configuration, below.
- **This Worker** reads `manifest.json`, shows it, streams the files it names, and writes one log
  entry per download. It never writes a release or the manifest.

The contract between the two Workers — the bucket layout, the catalogue format, which files may be
served, the download log — is **`../src/images-format.ts`** (no imports, bundled by both). It is
not repeated here. In short: `manifest.json`, `images/<product>/<version>/<file>`,
`tools/<product>/<version>/<file>`, `downloads/<yyyy>/<mm>/<time>-<random>.json`.

### Every request, in this order (`src/index.ts`)

1. **Plain HTTP** → 301 (GET/HEAD) or 308 to the same path and query on `https://`
   (`../src/lib/https.ts`, the same module as the intranet Worker; `localhost` never).
2. **`IMAGES_AUD` empty** → **503** for everything: the page, the assets, the API and the files (a
   self-contained page, or JSON under `/api/`). Nothing is served before the Access application
   exists.
3. **The Access token** (`Cf-Access-Jwt-Assertion`) verified with `verifyAccessJwt` of
   `../src/access.ts`: RS256 signature against the team's keys, issuer
   `https://gocontroll.cloudflareaccess.com`, audience `IMAGES_AUD`, expiry. Refused → **403**.
   The e-mail address comes only from that token. **No group check**: a one-time-PIN identity has no
   groups, and any address Access let in may download. The team's keys unreachable → 503.
4. **GET and HEAD only** (else 405), then:

| Path | Answer |
|---|---|
| `GET /` and the assets | the page (`public/index.html`, `app.js`, `format.js`, `styles.css`, logo, favicons); anything else 404 |
| `GET /api/catalogue` | `{ email, catalogue }`: `manifest.json` through `parseCatalogue` (no manifest yet = the empty catalogue); `cache-control: private, no-store`; a manifest that is not JSON = 503 |
| `GET` / `HEAD /files/<path>` | the file, only when `findPublishedFile` finds `<path>` in the catalogue. A draft whose files are already in the bucket, `downloads/…`, `manifest.json`, an unknown path, a `%` escape (`%2F`, `%2e%2e`), `..` (the URL is normalised first): 404 |

Every answer — page, assets, API, files, 403/404/405/416/503, the redirect — carries the security
headers of `src/headers.ts` (CSP without inline script or style and without `data:`, nosniff,
Referrer-Policy, `X-Frame-Options: DENY`, HSTS for this host only). The plain pages (503, 403, 404,
405) load nothing, because the assets are refused in the same situations and the CSP forbids inline
styles.

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
  with `DownloadMeta` as custom metadata: `email` (from the verified token), `path`, `kind`, `product`,
  `version`, `country` (`request.cf.country`, or empty). Written in `waitUntil` only for a GET that
  starts the file and gets the bytes (no Range, or a range from byte 0): never for HEAD, a 304, a
  refusal or a range further into the file, so a resumed or chunked download counts once. The log is
  personal data (an e-mail address per download): only the intranet reads it; keep it no longer than
  needed (step 4 below).

### The page (`public/`)

Plain ES modules with `// @ts-check` and JSDoc, no framework, no build step, as the intranet apps.
Header with the logo, "Downloads", the signed-in address and *Sign out* (`/cdn-cgi/access/logout`);
the anthracite hero; **Controller images** with a filter All / L4 / M1 / HMI1 (kept in the address,
`#M1`); **Tools**; *Verify your download* (`sha256sum`, `shasum -a 256`, `Get-FileHash -Algorithm SHA256`).
Per product its releases newest first, the newest open, older ones collapsed (`<details>`); per
release the version, release date (en-GB), controllers, notes as plain text and the files: name,
role, platform (not when `any`), size, SHA-256 with *Copy*, *Download*.

Catalogue text only ever goes into the page as text (`textContent`, `setAttribute`): `app.js` has no
`innerHTML` at all (`test/page.test.ts` checks it). `public/format.js` holds the labels, sizes, dates
and grouping without the DOM; its two label maps are copies of `FILE_ROLE_LABELS` and
`PLATFORM_LABELS` in `../src/images-format.ts` (the source; the test fails when they drift apart).
`public/tsconfig.json` is not served (`public/.assetsignore`).

## Bindings

Only `IMAGES_BUCKET` (R2 `gocontroll-images`), `ASSETS`, and the vars `TEAM_DOMAIN` and `IMAGES_AUD`.
No state bucket, no D1, no secret, no service binding: anyone who receives a one-time PIN reaches this
Worker, so nothing here may lead to the intranet's data. `test/config.test.ts` pins the list.

## Development and tests

From the repo root (the scripts live in the root `package.json`):

```bash
npm run test:images                 # this suite only (vitest --config images/vitest.config.ts)
npm test                            # the intranet suite, then this one
npm run typecheck                   # includes tsc -p images and tsc -p images/public
npx wrangler dev -c images/wrangler.toml
```

Locally, put `DEV_USER_EMAIL=you@example.com` in `images/.dev.vars` (not in git): honoured only on a
`localhost` URL, and then no AUD or token is needed. `wrangler dev` uses a local, empty bucket; put a
`manifest.json` there with `npx wrangler r2 object put gocontroll-images/manifest.json --file=manifest.json --local -c images/wrangler.toml`.

The tests run in the Workers runtime (Miniflare) with the real assets and a local bucket that each
test empties first (the pool keeps storage between tests, so the files run one after the other).
Access tokens are signed with a key of the test's own, and the team's certs endpoint is mocked.

## Deploy

```bash
npm run deploy:images               # typecheck + both suites, then wrangler deploy -c images/wrangler.toml
```

The bucket **`gocontroll-images`** must exist before the first deploy (`npx wrangler r2 bucket create
gocontroll-images`; it is shared with the Images tab of Deploy, which needs it too). Made on 2026-10-28
by the session, with the lifecycle rule of step 4. The first deploy
creates the custom domain `images.gocontroll.tech` (zone `gocontroll.tech`). With `IMAGES_AUD` still
empty it answers 503 everywhere, so deploying before the Access application exists is safe.

After a deploy:

```bash
curl -sI https://images.gocontroll.tech/      # 503 while IMAGES_AUD is empty; afterwards 302 to gocontroll.cloudflareaccess.com (or the challenge)
curl -sI http://images.gocontroll.tech/       # 301 to https://
```

**Rolling back**: `npx wrangler deployments list -c images/wrangler.toml` →
`npx wrangler rollback <version-id> -c images/wrangler.toml`. Closing the site at once without a
rollback: set `IMAGES_AUD = ""` and deploy (503 everywhere), or withdraw releases on the Images tab of
Deploy (a file stops being served as soon as `manifest.json` no longer names it). Removing it
altogether: `npx wrangler delete gocontroll-images` (the custom domain goes with it; the bucket stays).

## One-time setup in the Cloudflare dashboard

By the owner, in this order. Until step 2 is done the Worker answers 503 to everything.

### 1. The one-time PIN login method

Zero Trust → **Settings → Authentication → Login methods** → *Add new* → **One-time PIN** (if it is
not there yet).

> **Check every existing Access application first.** A login method added here is offered to every
> application that has *Accept all available identity providers* on. For the intranet apps (the hub,
> Hours, HR, CRM, Finance, Deploy, …) that would let anyone who can read a `@gocontroll.com` mailbox
> sign in with a code instead of Entra ID (no MFA, no conditional access) wherever a policy matches on
> the e-mail address or domain. In each intranet Access application: *Login methods* → turn
> *Accept all available identity providers* **off** and select **only Entra ID**. Group-based policies
> do not match a one-time-PIN identity (it has no groups), but policies on e-mail addresses do.

Way back: remove One-time PIN again (only when no other application uses it).

### 2. The Access application

Zero Trust → **Access → Applications** → *Add an application* → **Self-hosted**:

- Name **GOcontroll Images**; session duration **24 hours**.
- Public hostname: subdomain `images`, domain `gocontroll.tech`, no path.
- Login methods: *Accept all available identity providers* **off**, only **One-time PIN**;
  **Instant Auth** on (skips the choice of login method).
- Policy: name *Customers*, action **Allow**, include **Everyone** — any e-mail address that receives the
  code. Narrow it later to *Emails ending in* (customers' domains) or a list of *Emails* when the
  customers are known.
- Save, then copy the **Application Audience (AUD) Tag** (Overview) into `IMAGES_AUD` in
  `images/wrangler.toml`, commit, and `npm run deploy:images`.
- Check: `curl -sI https://images.gocontroll.tech/` → 302 to `gocontroll.cloudflareaccess.com`; sign in
  with a code in a private window and see the page.

Way back: set `IMAGES_AUD = ""` and deploy (503 everywhere), then delete the application. Deleting only
the application leaves the Worker refusing every request (403: no token).

### 3. The human check (WAF)

Zone **gocontroll.tech** → **Security → WAF → Custom rules** → *Create rule*: name *Images: human
check*, expression `(http.host eq "images.gocontroll.tech")`, action **Managed Challenge**.

This puts a challenge in front of the code form, so scripts cannot have codes mailed to arbitrary
addresses through `images.gocontroll.tech`. It does not cover someone who opens the team domain's
login URL (`gocontroll.cloudflareaccess.com`) directly; there Access's own rate limit on codes applies.
Downloads in a browser pass (the challenge cookie is set when the page is opened); a download manager
or `curl` without that cookie gets the challenge too.

Way back: disable or delete the rule.

### 4. Expire the download log (done 2026-10-28)

R2 → bucket **`gocontroll-images`** → *Settings* → **Object lifecycle rules**: rule `expire-download-log`,
prefix `downloads/`, **delete objects 395 days** after upload (13 months and a margin). The log holds an
e-mail address per download; this keeps it from growing forever. Never a rule without that prefix: it
would delete the images. Made by the session with
`npx wrangler r2 bucket lifecycle add gocontroll-images expire-download-log downloads/ --expire-days 395`
(next to R2's default rule that aborts unfinished multipart uploads after 7 days).

Way back: `npx wrangler r2 bucket lifecycle remove gocontroll-images --name expire-download-log`
(objects already expired stay deleted).

## Files

| File | What |
|---|---|
| `wrangler.toml` | the Worker: custom domain, assets, the bucket, `TEAM_DOMAIN`, `IMAGES_AUD` |
| `src/index.ts` | the request flow above |
| `src/auth.ts` | the verified e-mail address; `DEV_USER_EMAIL` on localhost |
| `src/files.ts` | `/files/`: published paths only, ranges, conditionals, the download log |
| `src/catalogue.ts` | `manifest.json` → `Catalogue` |
| `src/headers.ts`, `src/respond.ts` | security headers; JSON and the plain pages |
| `public/` | the page: `index.html`, `app.js`, `format.js`, `styles.css`, logo, favicons |
| `test/` | the suite (`npm run test:images`) |
| `../src/images-format.ts` | the contract with the intranet Worker (not in this folder) |
