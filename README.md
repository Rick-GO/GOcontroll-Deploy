# GOcontroll Deploy

Publishing Moduline **S1** firmware at **https://deploy.gocontroll.tools**: an STM32 application
binary goes into GOcontroll's own distribution bucket (R2 `gocontroll-deploy`), signed with the
folder's key when it has one, and its manifest points at it, so controllers on update-to-latest
install it. A binary can also be signed without publishing it (the signed container comes back
as a download). One **signing key per App ID** lives here, sealed. And the **status** of every
deployment: customers → their applications (App ID folders) → controller type, releases, file
and header checks, the controllers on that App ID and the download counts. New S1 applications
are made here; an application folder can be deleted, strongly protected and always archived
first. For the members of the Entra group **`CF_Deploy`** only.

> **Status: live on `deploy.gocontroll.tools` since 2026-10-21, for the members of `CF_Deploy`.**
> The Worker, the API and the pages are deployed (0.2.0 on 2026-10-21: Status and Keys tabs, new
> applications, releases from the folder page, protected folder delete); the Access application
> (with its `/pub` bypass) exists and its AUD is in `POLICY_AUD`; `DEPLOY_GROUPS` and the hub tile
> hold the object ID of `CF_Deploy`. Download counts wait for the Cloudflare API token
> ([Download counts](#download-counts)).

## Pages

The tab bar holds **Status** and **Keys**; an application (folder) has a page of its own. Plain ES
modules in `public/js/` (`app.js` routes, one module per page), no framework, no build step.
Old links `#/publish` and `#/sign` (milestone 1) lead to the folder page with `?app=`, else to Status.

| Page | What you do there |
|---|---|
| **Status** (`#/`) | Totals: applications (S1 / Linux), releases, storage, controllers (how many online) and downloads over 7 and 30 days (approx., or *Not configured*). Below that every customer with its applications, then the folders without a customer. Columns: App ID, Controller (S1, M1, L4, HMI1 or a derived type such as M2), latest version, releases, whether a signing key exists, last upload. Search (App ID, customer, version) and a filter (all / S1 / S1 without key / M1 / L4 / HMI1 / controller unknown) work without reloading and stay in the address. At the bottom, **New application…**: App ID (checked as you type, including "already exists"), customer, controller fixed to S1 (Linux releases are published by go-deploy), and distribution host (default deploy.gocontroll.tech). Creating it opens its folder page. |
| **Folder** (`#/folders/<APP_ID>`) | Customer and controller, each with **Change…** (by hand, or back to derived), plus latest, releases, last upload, distribution host and controllers on the App ID. **New release** in three steps (S1 only). **1 File:** pick or drop a `.bin`, S-record or GOCO container; it is read and compressed in the browser and the version comes from the filename or header, with what you type winning. **2 Sign:** the folder's public key with **Copy**; signing is ticked and locked when a key exists. Without a key you **Generate key…** or **Import key…** right there, or tick *Publish unsigned*. **3 Publish:** shows the latest release now, requires a description, warns when the version exists (**Replace…** asks first) or when latest moves back, then progress and the binary URL with **Copy**. **Download signed file instead** saves `<APP_ID>-<version>.bin` for a local upload with the Deployment Tool, without publishing. Below: the releases table with badges, the signing key card (Generate / Import / Replace with the App ID typed out), controllers per version, downloads per day, and files the manifest does not name. Linux folders (and non-S1 controllers) get a read-only note instead of New release. **Danger zone → Delete application folder…**: the dialog says what goes, that everything is archived first (manifest first) and that the signing key stays. Delete stays disabled until the App ID is typed, a reason of at least 10 characters is given and, if controllers still run the App ID, that is acknowledged. It then repeats the delete until done, with progress, and returns to Status with a notice; a delete that stopped halfway continues with **Continue deleting**. An unknown App ID offers **Create it as a new application…**. |
| **Keys** (`#/keys`) | Applications with a key: App ID (link, with a badge if it is not in the bucket yet), customer, controller, the public key shortened with **Copy** for the full key, made when and by whom, generated or imported. S1 applications without a key: **Generate…** (the private key is shown once and must be acknowledged) or **Import…**. A short note on where the keys are kept: encrypted with the Secrets Store master key in `gocontroll-deploy-state`. |

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
- the distribution URL of an existing folder is the host its manifest's URLs name; a folder
  made with *New application* takes the host chosen then (its settings); any other new folder
  the one sent, from `DISTRIBUTION_URLS` (the first is the default);
- a folder whose controller is set to a Linux type gets no S1 release (422), and a folder that
  is being deleted gets nothing new (409);
- the binary goes to `<APP_ID>/<APP_ID>-<version>.bin` **first**
  (`application/octet-stream`), then the manifest: `application_id`, `latest` = this version,
  `binaries[version] = { url: "<dist>/<key>?v=<first 16 hex of the payload SHA-256>",
  release_date, description }`, every other field kept, JSON with indent 2 and a newline,
  `application/json`, written only over the version that was read (R2 etag; `If-None-Match: *`
  for a new folder), so a publish racing another is a 409, not a lost release;
- a binary that is overwritten (a replaced version) is first copied to `STATE` `replaced/…`,
  and the publish's log entry keeps the manifest as it stood before. Publishing never deletes:
  only the protected [folder delete](#deleting-a-folder) removes objects, and it archives every
  one to `STATE` first.

Publishing an older version than `latest` is allowed (a bad release has to be undone) and the
answer says so (`latestMovedBack`).

### Applications, settings and the controller type

An application is a folder: what the bucket holds under `<APP_ID>/`, a signing key, or settings
in `STATE` (`folders/<APP_ID>.json`). Any of the three makes it show on Status and gives it a
page.

- **New application** (`POST /api/folders`): only settings (customer, controller `S1`,
  distribution URL, who and when); nothing in the bucket until its first release. 409 when the
  App ID has objects, a key or settings already. Only S1 (422 otherwise: Linux releases are not
  published here); App ID rules as for publishing.
- **Settings** (`PUT /api/folders/:appId/settings`): customer and controller by hand; a field
  left out stays, `null` goes back to the derived value.
- **Controller type**, first that applies: set by hand (`S1`, `M1`, `L4`, `HMI1`); an S1 manifest
  (`binaries`) means `S1`; the most common `controller_series.controller_type` of the controllers
  on that App ID in gocontroll-db, without its `Moduline ` prefix (so it can also be, say, `M2`),
  where a Linux manifest leaves the S1 controllers out (one App ID can have both); else none.
  The API gives `controller` and `controllerSource` (`manual`, `manifest`, `controllers` or
  `null`) next to `kind` (`s1`, `linux`, `unknown`: what the manifest is). Without a manifest a
  folder counts as `s1` when its settings say S1, or when it has a key and no controller set
  (keys are only made for S1).

### Deleting a folder

`DELETE /api/folders/:appId` with `{ confirm: "<APP_ID exactly>", reason: "<at least 10
characters>", acknowledgeControllers }` is the **only** path that removes objects from the
bucket (`src/delete.ts`). Refused without the exact App ID (400, `confirm`), without a reason
(400, `reason`), and while gocontroll-db has controllers on that App ID unless
`acknowledgeControllers` is true (409 with `controllers`): their cloud updates stop once the
folder is gone.

- Every object under `<APP_ID>/` (S1 containers, Linux tarballs and version manifests alike) is
  first **copied** to `STATE` `deleted/<APP_ID>/<ISO timestamp of the first call>/<original key>`
  (body, content type and custom metadata, plus `archived-etag` and `archived-uploaded`), its size
  checked, and only then deleted.
- **The manifest goes first**, alone: no client ever reads a manifest that points at deleted
  binaries.
- At most 200 objects per call; the answer `{ done, deleted, remaining, archive }` says whether to
  call again. An unfinished delete is kept in `deleting/<APP_ID>.json` (archive timestamp, who,
  why, progress), so a repeat, or a retry after a failure, continues in the same archive; the
  folder page shows it (`deleting`), and publishing into it is refused meanwhile.
- When the bucket holds nothing more, the folder settings move to the archive
  (`folder-settings.json`), the record goes and the log gets `delete-folder` (who, why, objects,
  bytes, controllers, archive).
- **The signing key stays** (`keys/<APP_ID>.json`): controllers in the field carry its public
  key, and a folder made again under that App ID signs with the same key.

**Restoring a deleted folder** (by hand, with an account that may write both buckets): the
`delete-folder` entry in `log/…` names the archive and how many objects it holds; list them in
the dashboard (R2 → `gocontroll-deploy-state` → `deleted/<APP_ID>/<timestamp>/`). Put back every
object **except the manifest** first, then the manifest last, so no client reads a manifest
before its binaries are there:

```sh
A=deleted/<APP_ID>/<timestamp>
npx wrangler r2 object get "gocontroll-deploy-state/$A/<APP_ID>/<file>" --remote --file=<file>
npx wrangler r2 object put "gocontroll-deploy/<APP_ID>/<file>" --remote --file=<file> --content-type=application/octet-stream
# … every binary / tarball, then last:
npx wrangler r2 object get "gocontroll-deploy-state/$A/<APP_ID>/manifest.json" --remote --file=manifest.json
npx wrangler r2 object put "gocontroll-deploy/<APP_ID>/manifest.json" --remote --file=manifest.json --content-type=application/json
# the settings (customer, controller), if there were any:
npx wrangler r2 object get "gocontroll-deploy-state/$A/folder-settings.json" --remote --file=folder-settings.json
npx wrangler r2 object put "gocontroll-deploy-state/folders/<APP_ID>.json" --remote --file=folder-settings.json --content-type=application/json
```

Settings put back by hand carry no index metadata; Deploy then reads the object itself, so
they show as before. The archive stays where it is.

## Data

### No D1 of its own: the STATE bucket

Deploy's own state is JSON in the private R2 bucket **`gocontroll-deploy-state`** (binding
`STATE`; no public access, no custom domain), written only by this Worker (`src/state.ts`). When
Deploy was made (2026-10-21) the account was at the Free-plan D1 limit; JSON objects in R2 are
enough for this data, so it stays there.

| Key | What |
|---|---|
| `keys/<APP_ID>.json` | The active signing key of a folder: `app_id`, `public_key` (130 hex), `sealed_private_key` (`v1.<iv>.<ciphertext+tag>`), `source` (generated / imported), `created_at`, `created_by`. Kept when the folder is deleted. |
| `keys-retired/<APP_ID>/<timestamp>.json` | A key that was replaced, with who replaced it when. Never deleted. |
| `folders/<APP_ID>.json` | Folder settings: `customer_id` and `controller` set by hand, `distribution_url` (an application made here, for its first release), `created_at` / `created_by`, `updated_at` / `updated_by`. Customer, controller and URL are also in the object's custom metadata (marked `index`), so the overview needs one listing. |
| `log/<yyyy>/<mm>/<timestamp>-<APP_ID>-<version or action>.json` | One entry per publish, sign, key action (generate, import, replace), `create-folder`, `settings` and `delete-folder`: action, App ID, version, actor, time, signed, replaced, payload SHA-256, size, description; a publish also its URL, the previous `latest`, the previous manifest and where a replaced binary went; a delete its reason, objects, bytes, controllers and archive. |
| `replaced/<APP_ID>/<APP_ID>-<version>/<timestamp>.bin` | A binary a publish overwrote. |
| `deleted/<APP_ID>/<timestamp>/<original key>` | Every object of a deleted folder, plus its `folder-settings.json` ([Deleting a folder](#deleting-a-folder)). |
| `deleting/<APP_ID>.json` | A delete under way: archive timestamp, actor, reason, progress. Gone when it is done. |
| `downloads/<yyyy-mm-dd>.json` | Download counts of a finished UTC day ([Download counts](#download-counts)). |

Read it with `npx wrangler r2 object get gocontroll-deploy-state/<key> --remote --file=-`.

### gocontroll-business and gocontroll-db (read only)

- **`gocontroll-business`** (schema owner GOcontroll-Hours): `customers` (id, name) for the
  picker and the names, `projects` (id, customer_id) for the customer of a project.
- **`gocontroll-db`** (schema owner GOcontroll-Database, `schema.sql`): of `controllers` only
  `client_id`, `project_id`, `app_id`, `app_version`, `app_uptodate`, `distribution_url`,
  `online`, `last_online`, `controller_series_id` (and `COUNT(*)`), joined to
  `controller_series(id, controller_type)` for the controller type, and
  `project_provisioning(project_id, app_id)`. Never a secret column or table
  (`controller_tunnels`, `app_settings`).

`test/readonly-db.test.ts` runs every flow with recording bindings and fails on any statement
that is not such a SELECT or names a table or column outside these, and scans `src/` for
anything but SELECT literals on the two bindings. Both bindings have `migrations_dir = "no-migrations-here"`, a folder that does not
exist, so no migration can be applied to them from this repo. `test/fixtures/business` (Hours
`0001_init.sql`) and `test/fixtures/moduline` (excerpts of `schema.sql`: controllers,
project_provisioning, controller_series, and the tunnel table to prove it is never read) are
pinned copies for the test and local databases only.

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
- A folder with a Linux manifest gets no key (signing is for S1 firmware). A key can be made
  before the folder has anything in the bucket (Keys page, or a new application's page).
- **Deleting a folder keeps its key**: controllers in the field carry its public key, and a
  folder made again under that App ID signs with the same key.
- Why one KEK and not a Secrets Store secret per App ID: a Worker cannot create store secrets it
  can read; every secret needs its own binding in `wrangler.toml` and a deploy.

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
`confirm`, `customerId`, `controller`, `reason`, `acknowledgeControllers`, `days`) with
400/403/404/409/413/415/422/500/503.

| Method | Path | |
|---|---|---|
| GET | `/api/me` | Signed-in colleague: email, name, groups (object IDs and names, to look an ID up) |
| GET | `/api/health` | `{ ok, version, signingKeys, downloads }`: whether the KEK and the API token are readable |
| GET | `/api/overview` | Every folder (kind s1/linux/unknown, `controller` + `controllerSource`, latest, releases, bytes, last upload, distribution URL, key, `inBucket`, customer, controllers), the customers with their folders, totals, `distributionUrls`, download totals of 7 and 30 days |
| GET | `/api/folders/:appId` | One folder: kind, controller, customer, key; releases with their stored header (range read), `keyMatches`, `digestMatches`, size, upload time and downloads; Linux versions; objects the manifest does not name; `objects: { count, bytes }`; `deleting` (an unfinished delete, or null); controllers per version and per distribution URL; downloads per day. 404 when nothing exists for it |
| POST | `/api/folders` | `{ appId, customerId, controller: "S1", distributionUrl }` → 201 `{ appId }`: a new application (settings only). 409 when it exists, 422 for another controller |
| PUT | `/api/folders/:appId/settings` | `{ customerId?: number \| null, controller?: "S1" \| "M1" \| "L4" \| "HMI1" \| null }` (absent: unchanged, null: derived) → `{ customer, controller, controllerSource }` |
| PUT | `/api/folders/:appId/customer` | `{ customerId: number \| null }` → `{ customer }` (the milestone-1 call; same as settings with the customer only) |
| DELETE | `/api/folders/:appId` | `{ confirm, reason, acknowledgeControllers }` → `{ done, deleted, remaining, archive }`; repeat until `done` ([Deleting a folder](#deleting-a-folder)) |
| GET | `/api/keys` | `{ keys: [ { appId, publicKey, source, createdAt, createdBy, inBucket, customer, controller } ], withoutKey: [ { appId, customer, controller } ] }` (S1 folders without a key) |
| GET | `/api/customers` | `[ { id, name } ]` from gocontroll-business, for the picker |
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
- **A deleted folder**: put it back from `deleted/…`, the manifest last
  ([Restoring a deleted folder](#deleting-a-folder)).
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
