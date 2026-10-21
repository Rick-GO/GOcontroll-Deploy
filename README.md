# GOcontroll Deploy

Publishing Moduline **S1** firmware at **https://deploy.gocontroll.tools**: an STM32 application
binary goes into GOcontroll's own distribution bucket (R2 `gocontroll-deploy`), signed with the
folder's key when it has one, and its manifest points at it, so controllers on update-to-latest
install it. A binary can also be signed without publishing it (the signed container comes back
as a download). One **signing key per App ID** lives here, sealed. And the **status** of every
deployment: customers → their folders (App IDs) → releases, file and header checks, the
controllers on that App ID and the download counts. For the members of the Entra group
**`CF_Deploy`** only.

> **Status: live on `deploy.gocontroll.tools` since 2026-10-21, for the members of `CF_Deploy`.**
> The Worker, the API and the pages are deployed; the Access application (with its `/pub`
> bypass) exists and its AUD is in `POLICY_AUD`; `DEPLOY_GROUPS` and the hub tile hold the object
> ID of `CF_Deploy`. Download counts wait for the Cloudflare API token
> ([Download counts](#download-counts)).

## Pages

The tab bar holds **Status**, **Publish** and **Sign**; a folder has a page of its own. Plain ES
modules in `public/js/` (`app.js` routes, one module per page), no framework, no build step.

| Page | What you do there |
|---|---|
| **Status** (`#/`) | Totals: folders (S1 / Linux), releases, storage, controllers (and how many are online) and downloads over 7 and 30 days (approx., or *Not configured*). Below that every customer with its folders — App ID, kind, latest version, releases, controllers online / up to date, whether a signing key exists, last upload — then the folders without a customer. Search (App ID, customer, version) and a filter (all / S1 / S1 without key / Linux / unrecognised) work without reloading and stay in the address. |
| **Folder** (`#/folders/<APP_ID>`) | The folder at a glance, its distribution host (with a warning when the manifest names more than one host) and its customer: assigned by hand, or derived — the page says from where. The signing key card shows the public key with a **Copy** button; **Generate** (the private key is shown once, as base64 and PEM with Copy buttons and **Download .pem**, and has to be acknowledged), **Import** (paste a PEM, the base64 scalar or a `.cred` JSON, or pick a file) and **Replace** (type the App ID to confirm: controllers carrying the old public key refuse every image signed with the new one). The releases table: version, date, what changed, size, short SHA-256, badges (Signed / Key matches / Digest ok / header problems) and downloads. A Linux folder gets a read-only versions table instead. Also controllers per version, downloads per day, and files in the folder the manifest does not name. An App ID that is not in the bucket yet shows only the key card and a link to publish its first release. |
| **Publish** (`#/publish?app=`) | Pick an S1 folder, or **New folder…** with an App ID (checked as you type) and one of the two distribution hosts. What the manifest holds now stands on screen first (latest version, its date and what it changed, the releases before it). Pick or drop a file — `.bin`, S-record or a ready-made GOCO container — and it is read and compressed in the browser straight away. The version comes from the filename or the container header; what you type wins. A description is mandatory. Signing is ticked and locked when the folder has a key; without one the page says the release goes out unsigned and links to the folder to make a key. A version that is already published turns the button into **Replace…** with a confirmation; a version below `latest` asks before `latest` moves back. An upload bar, then a result card with the binary URL to copy. |
| **Sign** (`#/sign?app=`) | Sign a binary without publishing it: a folder with a key, a file and a version. **Sign and download** saves `<APP_ID>-<version>.bin` — for a local upload with the Deployment Tool, for instance. Nothing goes into the bucket. |

## How it works

```
browser ──► Cloudflare Access (Entra ID, group CF_Deploy) ──► Worker gocontroll-deploy-intranet
   │ reads .bin/.srec, compresses (zlib)                         │  verifies Cf-Access-Jwt-Assertion
   │ and sends payload + raw size,                               │  and an object ID in DEPLOY_GROUPS
   │ or a ready-made GOCO container                              ├─► R2 gocontroll-deploy        (the distribution bucket: read + publish)
                                                                 ├─► R2 gocontroll-deploy-state  (keys, folder settings, log, download days)
                                                                 ├─► D1 gocontroll-business      (customers, projects: read only)
                                                                 ├─► D1 gocontroll-db            (controllers, project_provisioning: read only)
                                                                 ├─► Secrets Store               (DEPLOY_SIGNING_KEYS_KEY; DEPLOY_CF_API_TOKEN later)
                                                                 └─► Cloudflare GraphQL Analytics (download counts, once the token exists)
cron 17 2 * * * ─────────────────────────────────────────────► the download counts of finished days, into STATE

controllers ──► https://deploy.gocontroll.tech (Worker gocontroll-deploy) ┐
            ──► https://deploy.gocontroll.com  (R2 custom domain)         ┴─► the same bucket, byte for byte
```

- **One Worker with static assets** (`public/`), like Logistic, Finance, the CRM and Hours:
  `run_worker_first = true` sends every request through the token check in `src/index.ts`; only
  `/pub/*` (brand assets) skips it, via an Access bypass app. Its name is
  `gocontroll-deploy-intranet`, not `gocontroll-deploy`: that is the public Worker of the
  Deployment Tool on `deploy.gocontroll.tech` that serves the same bucket to controllers.
- **Identity and access**: the verified Access token (`src/access.ts`, the copy of Logistic,
  Finance and the CRM), name and groups from `get-identity`. On top of the Access policy the
  Worker requires one of `DEPLOY_GROUPS` (`src/auth.ts`), matched on the group's **object ID
  only**: any employee can create a Microsoft 365 group with any name. An empty `DEPLOY_GROUPS`
  or a failed group lookup lets nobody in. Every write records the colleague as actor.
- **Server**: TypeScript + Hono + zod (`src/`). **Browser**: plain ES modules with
  `// @ts-check` (`public/js/`), no framework, no build step. The CSP forbids inline scripts
  and style attributes.
- **Small uploads, little Worker CPU**: the browser parses the S-record and compresses the
  image (`CompressionStream('deflate')`, a zlib stream); the Worker never inflates. It
  hashes and signs with `crypto.subtle`, computes the CRC over the header only, writes header
  and payload as one body, reads a stored binary's header with a range read of its first
  211 bytes, and lists the bucket once for the overview.
- **Uploads** (`/api/sign`, `/api/releases`) are `multipart/form-data`, which a cross-site form
  can send without a preflight, so they must carry this origin's `Origin` (and
  `Sec-Fetch-Site: same-origin` when sent); every other write is same-origin JSON.

### The container and the manifest

`src/goco.ts` is the only producer and reader of the GOCO container in this repo, a port of
`GOcontroll-Deployment-Tool/tools/goco.py`; `src/keys.ts` ports the key formats of `keys.py`;
`src/bucket.ts` and `src/release.ts` follow `r2.py` (`publish`). The formats are normative in
the **S1 knowledge base** (`%USERPROFILE%\GOcontroll\10-GOcontroll Algemeen - Documenten\18-Agents\10 - Moduline S1 Controller Guru\docs\`):
`cloud-r2-distribution.md` §2 (bucket layout), §2.1 (two hosts, never a redirect, never two
hosts in one manifest), §3 (manifest, the `?v=` digest), §4 (container) and
`code-signing-local.md` (key formats). This repo does not copy those tables; when the spec
changes, `src/goco.ts` follows, and so do its cross-check fixtures.

`test/fixtures/goco/fixtures.json` is made by `npm run fixtures:goco` (`scripts/goco-fixtures.mjs`,
which runs `python -I scripts/goco-fixtures.py` against the Deployment Tool's own `goco.py` and
`keys.py`): per App ID (4, 8, 9 and 32 characters, so all four header versions) an unsigned
container from a known zlib payload, which `src/goco.ts` must rebuild byte for byte; a
Python-signed one, which must verify here; and one signed by `src/goco.ts`, which Python's
`verify_signature` verified when the fixtures were made. Python also reads back the PEM backup
`src/keys.ts` writes. The Deployment Tool sits next to `GOcontroll-Team`
(`DEPLOYMENT_TOOL=<its tools dir>` otherwise); its Python needs `cryptography`.

### Publishing a release

`POST /api/releases` does what `r2.py publish()` does, with the folder's key held here:

- a description is mandatory (the manifest carries it as the release note);
- a folder holding a Linux manifest (go-deploy tarballs: `versions[]`) is refused, and so is a
  manifest that cannot be read or has no `binaries`: Deploy never writes into another format;
- a version already in the manifest is refused (409) unless *replace* is ticked: that binary
  may be on controllers already;
- a folder with a signing key only gets signed releases, signed with that key: an unsigned
  payload or container is signed here (the container's payload is taken over), a container
  already signed with the folder's key goes out as it is, one signed with another key is
  refused; *sign* without a key is refused;
- a container's App ID and version must be the folder's and the release's;
- the distribution URL of an existing folder is the host its manifest's URLs name; a new
  folder takes the one chosen, from `DISTRIBUTION_URLS` (the first is the default);
- the binary goes to `<APP_ID>/<APP_ID>-<version>.bin` **first**
  (`application/octet-stream`), then the manifest: `application_id`, `latest` = this version,
  `binaries[version] = { url: "<dist>/<key>?v=<first 16 hex of the payload SHA-256>",
  release_date, description }`, every other field kept, JSON with indent 2 and a newline,
  `application/json`, written only over the version that was read (R2 etag; `If-None-Match: *`
  for a new folder), so a publish racing another is a 409, not a lost release;
- nothing is ever deleted: a binary that is overwritten (a replaced version) is first copied to
  `STATE` `replaced/…`, and the publish's log entry keeps the manifest as it stood before.

Publishing an older version than `latest` is allowed (a bad release has to be undone) and the
answer says so (`latestMovedBack`).

## Data

### No D1 of its own: the STATE bucket

Deploy's own state is JSON in the private R2 bucket **`gocontroll-deploy-state`** (binding
`STATE`; no public access, no custom domain), written only by this Worker (`src/state.ts`). When
Deploy was made (2026-10-21) the account was at the Free-plan D1 limit; JSON objects in R2 are
enough for this data, so it stays there.

| Key | What |
|---|---|
| `keys/<APP_ID>.json` | The active signing key of a folder: `app_id`, `public_key` (130 hex), `sealed_private_key` (`v1.<iv>.<ciphertext+tag>`), `source` (generated / imported), `created_at`, `created_by`. |
| `keys-retired/<APP_ID>/<timestamp>.json` | A key that was replaced, with who replaced it when. Never deleted. |
| `folders/<APP_ID>.json` | Folder settings: the customer assigned by hand (`customer_id`, also in the object's custom metadata, so the overview needs one listing), `updated_at`, `updated_by`. |
| `log/<yyyy>/<mm>/<timestamp>-<APP_ID>-<version or action>.json` | One entry per publish, sign, key action (generate, import, replace) and customer assignment: action, App ID, version, actor, time, signed, replaced, payload SHA-256, size, description; a publish also its URL, the previous `latest`, the previous manifest and where a replaced binary went. |
| `replaced/<APP_ID>/<APP_ID>-<version>/<timestamp>.bin` | A binary a publish overwrote. |
| `downloads/<yyyy-mm-dd>.json` | Download counts of a finished UTC day ([Download counts](#download-counts)). |

Read it with `npx wrangler r2 object get gocontroll-deploy-state/<key> --remote --file=-`.

### gocontroll-business and gocontroll-db (read only)

- **`gocontroll-business`** (schema owner GOcontroll-Hours): `customers` (id, name) for the
  picker and the names, `projects` (id, customer_id) for the customer of a project.
- **`gocontroll-db`** (schema owner GOcontroll-Database, `schema.sql`): of `controllers` only
  `client_id`, `project_id`, `app_id`, `app_version`, `app_uptodate`, `distribution_url`,
  `online`, `last_online` (and `COUNT(*)`), and `project_provisioning(project_id, app_id)`.
  Never a secret column or table (`controller_tunnels`, `app_settings`).

`test/readonly-db.test.ts` runs every flow with recording bindings and fails on any statement
that is not such a SELECT, and scans `src/` for anything but SELECT literals on the two
bindings. Both bindings have `migrations_dir = "no-migrations-here"`, a folder that does not
exist, so no migration can be applied to them from this repo. `test/fixtures/business` (Hours
`0001_init.sql`) and `test/fixtures/moduline` (an excerpt of `schema.sql`, with the tunnel table
to prove it is never read) are pinned copies for the test and local databases only.

**Customer of a folder**, first that applies: assigned by hand in Deploy; else the most common
`client_id` of the controllers that report the App ID; else the customer of a project whose
provisioning names the App ID. **Up to date**: controllers on the folder's `latest` (or, without
a latest, those with `app_uptodate = 1`).

## Signing keys

- One ECDSA P-256 key per App ID. The private key is the 32-byte scalar, the public key the
  65-byte point `04 || X || Y` as 130 hex characters (`code-signing-local.md`). *Generate* makes
  one here; *import* takes a PEM (PKCS#8 or SEC1 "EC PRIVATE KEY", also pasted on one line), the
  base64 scalar (the `FW_PRIVATE_KEY_B64` format of the CI pipeline) or a Deployment Tool `.cred`
  document with `private_key`.
- **The private key leaves the Worker once**: right after *generate*, as a backup (base64 and
  PEM) to keep in a password manager or a `.cred` file. Never again; an imported key comes back
  as nothing but its public key.
- At rest every private key is sealed with AES-256-GCM under the key-encryption key
  **`DEPLOY_SIGNING_KEYS_KEY`** (Secrets Store, binding `SIGNING_KEYS_KEY`; 32 random bytes
  made in the store, never seen by anyone), with `deploy-key:<APP_ID>` as additional
  authenticated data, so a sealed key cannot be moved to another folder. A key is opened only to
  sign, for that one request (`src/vault.ts`).
- **Lost KEK = every key here lost.** Controllers carrying those public keys then only accept
  firmware signed with the backup of the key (if it was kept) or after their public key is
  changed with the Deployment Tool. The store cannot be exported; keep the backups.
- **Rotating the KEK needs a re-seal path that does not exist yet**: a second binding with the
  new key, code that opens every `keys/*.json` with the old one and seals it with the new one,
  and only after every key is shown to open, the switch and removal of the old one. Until that
  code exists, do not change `DEPLOY_SIGNING_KEYS_KEY`. An unreadable store or a key that does
  not open is a 503; it is never treated as "no key".
- **Replacing a key** asks for the App ID as confirmation: controllers that carry the old public
  key refuse firmware signed with the new one. The old key moves to `keys-retired/`.
- A folder with a Linux manifest gets no key (signing is for S1 firmware).

## Download counts

Counts come from Cloudflare's GraphQL Analytics API (`httpRequestsAdaptiveGroups`) for the
hosts in `DOWNLOAD_HOSTS`, per zone (`gocontroll.com`, `gocontroll.tech`), per UTC day: a
**download** is a GET of a `.bin` answered 200, a **header read** a 206 on a `.bin` (a client
reading the header with a range), a **manifest read** a GET of `manifest.json` answered 200 or
304. They are Cloudflare's sample-based estimates: approximate. Cloudflare keeps these data only
briefly, so a finished day is stored in `STATE` (`downloads/<day>.json`) by a daily cron
(`17 2 * * *`, 02:17 UTC, `scheduled()` in `src/index.ts`) and the first time someone looks,
whichever comes first: at most 7 missing days per run or request, newest first. Without the
token the cron does nothing. A day the API refuses as too old is stored as unavailable; today
is always live. A day without counts comes back with `null`s and `unavailable: true` or
`pending: true` (not fetched yet). A release's count is the sum over the days of the window.

**Turning it on** (not done yet):

1. Cloudflare dashboard → My Profile → API Tokens → *Create Custom Token*: permissions
   **Zone → Analytics → Read** and **Zone → Zone → Read**; zone resources: the specific zones
   **`gocontroll.com`** and **`gocontroll.tech`**. Nothing else.
2. Secrets Store → `default_secrets_store` → *Create secret*: name **`DEPLOY_CF_API_TOKEN`**,
   scope *Workers*, the token as value.
3. In `wrangler.toml`, uncomment the binding (deploying with it before the secret exists fails):

   ```toml
   [[secrets_store_secrets]]
   binding = "CF_API_TOKEN"
   store_id = "33801ac6937549ae8f6f92169586a707"
   secret_name = "DEPLOY_CF_API_TOKEN"
   ```

4. `npm run deploy`; `/api/health` then says `"downloads": true`, and the overview shows counts.

Without the binding every answer says `configured: false` and no call is made.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # DEV_USER_* stands in for the Access token, on localhost only
npm run db:setup:local           # local D1s from the pinned schemas in test/fixtures
npm run dev                      # http://localhost:8787 (local R2 buckets: nothing reaches the real bucket)
curl localhost:8787/api/health   # {"ok":true,"version":…,"signingKeys":false,"downloads":false}
npm test                         # vitest in the Workers runtime; Cloudflare's API mocked
npm run typecheck                # strict TS for the Worker, JSDoc-checked JS for public/js
npm run fixtures:goco            # only when the container format changes (needs Python + cryptography)
```

`.dev.vars` needs `DEPLOY_GROUPS` and `DEV_USER_GROUPS` with the same value (or every request
gets 403). Locally `SIGNING_KEYS_KEY` reads wrangler's local Secrets Store (see
`.dev.vars.example` to give it a throwaway value). `vitest.config.ts` pins the test bindings, so a
developer's `.dev.vars` never changes what the tests see; `test/setup.ts` puts a fixed test KEK in
Miniflare's local store, so the tests go through the real binding. GitHub Actions
(`.github/workflows/ci.yml`) runs the typecheck and the tests on every push to `main` and on
every pull request.

### API

All `/api/*` need the Access token and `DEPLOY_GROUPS`. Errors are `{ "error": "…", "field"?: "…" }`
(`field`: `appId`, `version`, `description`, `file`, `privateKey`, `sign`, `distributionUrl`,
`confirm`, `customerId`, `days`) with 400/403/404/409/413/415/422/503.

| Method | Path | |
|---|---|---|
| GET | `/api/me` | Signed-in colleague: email, name, groups (object IDs and names, to look an ID up) |
| GET | `/api/health` | `{ ok, version, signingKeys, downloads }`: whether the KEK and the API token are readable |
| GET | `/api/overview` | Every folder (kind s1/linux/unknown, latest, releases, bytes, last upload, distribution URL, key, customer, controllers), the customers with their folders, totals, `distributionUrls`, download totals of 7 and 30 days |
| GET | `/api/folders/:appId` | One folder: releases with their stored header (range read), `keyMatches`, `digestMatches`, size, upload time and downloads; Linux versions; objects the manifest does not name; controllers per version and per distribution URL; downloads per day. 404 when nothing exists for it |
| GET | `/api/customers` | `[ { id, name } ]` from gocontroll-business, for the picker |
| PUT | `/api/folders/:appId/customer` | `{ customerId: number \| null }`: assign by hand (null: back to the derived one) → `{ customer }` |
| GET | `/api/folders/:appId/key` | The active key's public part, or 404. Works for an App ID without a folder yet |
| POST | `/api/folders/:appId/key` | `{ action: "generate" }` or `{ action: "import", privateKey }`, with `{ replace: true, confirm: "<APP_ID>" }` when a key exists (else 409) → key info, plus `backup` on generate only |
| POST | `/api/sign` | multipart `appId`, `version`, and `payload` (zlib) + `rawSize`, or `container` → the signed container as a download `<APP_ID>-<version>.bin`; nothing goes into the bucket |
| POST | `/api/releases` | multipart `appId`, `version`, `description`, `sign`, `replace`, `distributionUrl` (new folder only), and `payload` + `rawSize` or `container` → `{ binaryKey, binaryUrl, manifestKey, version, releaseDate, previousLatest, replaced, latestMovedBack, signed }` |
| GET | `/api/downloads?appId=&days=30` | `{ configured, days: [ { day, downloads, headerReads, manifestReads } ] }`, every day of the window (1–90; a day without counts has `null`s and `unavailable` or `pending`); without `appId` every folder |

## Deployment

### Hostnames, bindings and secrets

| What | Name |
|---|---|
| Worker | `gocontroll-deploy-intranet` |
| Hostname | `deploy.gocontroll.tools` (custom domain, the only route; `workers_dev` and preview URLs off) |
| R2 (read + write) | `DEPLOY_BUCKET` → `gocontroll-deploy`, public as `deploy.gocontroll.com` and `deploy.gocontroll.tech` |
| R2 (private) | `STATE` → `gocontroll-deploy-state` (created 2026-10-21) |
| D1 (read only) | `BUSINESS_DB` → `gocontroll-business`, `MODULINE_DB` → `gocontroll-db` |
| Secrets Store | `SIGNING_KEYS_KEY` → `DEPLOY_SIGNING_KEYS_KEY` (exists); `CF_API_TOKEN` → `DEPLOY_CF_API_TOKEN` (to be made, [Download counts](#download-counts)) |
| Vars | `TEAM_DOMAIN`, `POLICY_AUD`, `DEPLOY_GROUPS`, `DISTRIBUTION_URLS`, `DOWNLOAD_HOSTS` |
| Cron | `17 2 * * *`: stores the download counts of finished days ([Download counts](#download-counts)) |

### One-time setup

1. **Entra ID**: the security group **`CF_Deploy`**, object ID
   `b5877d29-e509-40b2-9784-17e649996f1f` (made 2026-10-21), in `DEPLOY_GROUPS` (`wrangler.toml`)
   with the name in a comment; a name never matches. An empty `DEPLOY_GROUPS` lets **nobody** in
   (fail closed). Add the colleagues who publish S1 firmware to the group.
2. **Cloudflare Access** (before the first deploy, so the custom domain is never reachable
   without it): Zero Trust → Access → Applications → Add → Self-hosted, domain
   `deploy.gocontroll.tools`, identity provider Entra ID, policy **Allow**, include the group
   **`CF_Deploy`**. Copy its **Audience (AUD) tag** into `POLICY_AUD` (empty: every request
   403). Add a second self-hosted application, domain `deploy.gocontroll.tools`, path `pub`,
   one policy: **Bypass**, include **Everyone** (brand assets only). Signing out ends on the
   hub's `https://gocontroll.tools/pub/signed-out`. Done 2026-10-21: AUD `d26a80ee…cab10`,
   bypass on `/pub` in place.
3. **Tile on the hub** (`GOcontroll-Team/src/cards.js`), link `https://deploy.gocontroll.tools`,
   shown to the object ID of `CF_Deploy` (since 2026-10-21). Hiding a tile is not access
   control: the Access application and `DEPLOY_GROUPS` are.
4. Optionally the API token for [download counts](#download-counts).

### Worker

`npm run deploy`. It first runs `predeploy`: the typecheck and the tests. There is no
migration check: Deploy has no D1 of its own. Its cron (`17 2 * * *`) stores the download
counts of finished days. First deploy 2026-10-21: version
`211d969d-5468-45eb-b102-57746d737af5` (without the cron). Verify:

```sh
curl -sI https://deploy.gocontroll.tools/   # 302 to gocontroll.cloudflareaccess.com
```

### Rolling back

- **Code**: `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`.
- **A release**: publish the version before it again (*replace*) or a newer one; a replaced
  binary is in `STATE` `replaced/…` and the manifest before every publish is in its log entry
  (`log/…`, `previous_manifest`); put either back with
  `npx wrangler r2 object put gocontroll-deploy/<key> --remote --file=<file>` (content type
  `application/json` for a manifest, `application/octet-stream` for a binary).
- **A key**: the replaced one is in `keys-retired/<APP_ID>/`; copying it back to
  `keys/<APP_ID>.json` makes it active again (it stays sealed for that App ID).
- **Removing the app**: delete the Worker (`npx wrangler delete gocontroll-deploy-intranet`)
  and the hub tile. The distribution bucket is not this app's and stays as it is; keep the
  state bucket (the sealed keys, the log).

## Relation to the Deployment Tool and the S1 knowledge base

The **Deployment Tool** (`GOcontroll-Deployment-Tool`) programs and provisions S1 controllers
over Bluetooth and publishes from a laptop with a `.cred` file; Deploy publishes to the same
bucket in the same format from the browser, with the key kept here instead of in a file. Both
follow the S1 knowledge base (`cloud-r2-distribution.md`, `code-signing-local.md`,
`deployment-tool.md`); when a format changes there, both follow. Provisioning a controller's
App ID, distribution URL and public key stays the Deployment Tool's job; moving an App ID from
`deploy.gocontroll.com` to `deploy.gocontroll.tech` follows `cloud-r2-distribution.md` §2.1
(Deploy shows `mixedHosts` and the controllers' distribution URLs per folder, and never mixes
hosts when it writes).
