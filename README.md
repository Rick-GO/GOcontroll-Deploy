# GOcontroll Deploy

Publishing controller applications at **https://deploy.gocontroll.tools**: Moduline **S1**
firmware (an STM32 application binary in a GOCO container, signed with the folder's key when it
has one) and, for **M1, L4 and HMI1**, Linux **go-deploy packages** (`update.tar.gz` + version
manifest), into GOcontroll's own distribution bucket (R2 `gocontroll-deploy`), with the manifest
pointing at them so controllers on update-to-latest install them. A binary can also be signed without publishing it (the signed container comes back
as a download). One **signing key per App ID** lives here, sealed. And the **status** of every
deployment: customers → their applications (App ID folders) → controller type, releases, file
and header checks, the controllers on that App ID and the download counts. New applications (S1
and Linux) are made here; an application folder can be deleted, strongly protected and always archived
first. For the members of the Entra group **`CF_Deploy`** only.

> **Status: live on `deploy.gocontroll.tools` since 2026-10-21, for the members of `CF_Deploy`.**
> The Worker, the API and the pages are deployed (0.3.0 on 2026-10-21: Linux releases for M1, L4 and HMI1 next to
> S1; 0.2.0: Status and Keys tabs, new applications, releases from the folder page, protected
> folder delete); the Access application
> (with its `/pub` bypass) exists and its AUD is in `POLICY_AUD`; `DEPLOY_GROUPS` and the hub tile
> hold the object ID of `CF_Deploy`. Download counts wait for the Cloudflare API token
> ([Download counts](#download-counts)).

## Pages

The tab bar holds **Status** and **Keys**; an application (folder) has a page of its own. Plain ES
modules in `public/js/` (`app.js` routes, one module per page), no framework, no build step.
Old links `#/publish` and `#/sign` (milestone 1) lead to the folder page with `?app=`, else to Status.

| Page | What you do there |
|---|---|
| **Status** (`#/`) | Totals, then every customer with its applications and the folders without a customer. Columns: App ID, Controller (S1, M1, L4, HMI1 or a derived type), latest, releases, signing key ("n/a" for Linux applications, which are not signed), last upload. Search and a filter (all / S1 / S1 without key / M1 / L4 / HMI1 / controller unknown) stay in the address. At the bottom, **New application…**: controller S1, M1, L4 or HMI1, then the App ID (S1: up to 32 characters, no spaces or "/"; Linux: lower case `^[a-z0-9][a-z0-9._-]*$`, up to 64), customer, and for S1 the distribution host. Creating it opens its folder page. |
| **Folder, S1** (`#/folders/<APP_ID>`) | Customer and controller (**Change…** each). **New release** in three steps: **1 File** (`.bin` / S-record / GOCO container, version from the filename) → **2 Sign** (public key with Copy; Generate or Import a key there, or tick *publish unsigned*) → **3 Publish** (description, Replace… / latest-moves-back confirmations, binary URL with Copy), or **Download signed file instead**. Then the releases with header checks, the signing key card, controllers per version, downloads per day, other files, and the **Danger zone**. |
| **Folder, Linux (M1, L4, HMI1)** | Customer and controller. **Package** card: the files in `files/` (name, destination, mode, owner, group) with Add / Edit / Remove; default owner and group; after install: Nothing, *Restart services* (comma list, nodered and go-simulink suggested, preview of the rendered `post-install.sh.tmpl`) or *A script of its own*. **Save package**; **Import r2-deploy.config.json…** (paste or file); **From the latest release** (files from its version manifest, `files/post-install.sh` from its tarball). **New release** in three steps: **1 Files**: one file per package file (choose per row, or drop several, matched by name), or *Upload a built package* (`update.tar.gz` + `manifest.json` from a CI `dist/`, sent as they are after a SHA-256 check here), plus the version (next patch of latest) and what changed. **2 Review**: not signed, and why (go-deploy checks SHA-256 only); size and SHA-256 of the tarball; the version manifest's files with destination, mode, owner and short SHA-256; the post-install script; `manifest.json` as it will be written; what happens to `latest_version`. **3 Publish**: Publish / Replace…, progress, result (keys written, SHA-256 with Copy, size, `latest_version`). Then the Versions table (with a Tarball download per version), controllers per version, downloads, other files, Danger zone. |
| **Keys** (`#/keys`) | S1 applications with a key (App ID, customer, controller, short public key with Copy, made by and when, source) and without one (Generate / Import with the one-time backup). Plus: Linux packages (M1, L4, HMI1) are not signed; go-deploy checks the SHA-256 only. |

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
- a folder holding a Linux manifest (go-deploy packages: `versions[]`) is refused here (Linux
  releases go through `POST /api/linux-releases`), and so is a manifest that cannot be read or
  has no `binaries`: an S1 release never goes into another format;
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
- a folder whose controller is set to a Linux type gets no S1 release (422: it takes Linux
  releases), and a folder that is being deleted gets nothing new (409);
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

### Linux applications (M1, L4, HMI1)

The contract is `GOcontroll-Architecture/cloudflare/linux-application/spec.md` (§1 bucket, §2 root
manifest, §3 version manifest, §4 tarball and go-deploy install); the producer Deploy mirrors is
the CI pipeline of the skill `GOcontroll-Claude-Skills/r2-application-deploy-setup`
(`build-package.py`, `upload-r2.py`). Deploy is a second producer next to it, in the same layout:

```
<APP_ID>/v<version>/update.tar.gz   application/gzip: files/<name> per package file (+ files/post-install.sh)
<APP_ID>/v<version>/manifest.json   the version manifest, stored as sent
<APP_ID>/manifest.json              root manifest { app_id, latest_version, versions[] }
```

- **Package definition** (`PUT /api/folders/:appId/package`, in `folders/<APP_ID>.json`): owner
  and group (default `root`), the files (`name` in `files/`, absolute `destination`, octal
  `mode`, optional owner/group; names and destinations unique, no `post-install.sh`), and the
  post-install: none, restart services (the skill's `post-install.sh.tmpl` with the service
  names), or a script. The browser builds the tarball (ustar, gzip) and the version manifest
  (build-package.py's shape) from it; a CI-built `dist/` can be sent as it is.
- **Publishing** (`POST /api/linux-releases`): the folder must be a Linux application (a
  go-deploy root manifest, or settings with M1, L4 or HMI1) and never S1 (422 either way round);
  version `major.minor.patch[-suffix]`; the version manifest must name this App ID, version and
  description, have a `released` date, `files[]` with source `files/<name>`, absolute
  destination, octal mode and lower-case SHA-256, and a `post_install` (if any) with source
  `files/post-install.sh`; the package must be gzip, at most 100 MB. The Worker computes the
  package's SHA-256 (streamed) and size; it does **not** unpack it, so the per-file SHA-256
  values are the browser's or CI's (go-deploy checks them when it installs).
- A version already in the root manifest is refused (409, `version`) unless *replace*; then the
  old `v<version>/update.tar.gz` and `manifest.json` are first copied to `STATE`
  `replaced/<APP_ID>/v<version>/<timestamp>/`.
- Order: package, version manifest, then the root manifest, written over the version that was
  read (etag; `If-None-Match: *` for the first), so a race is a 409. The root manifest is built
  exactly as `upload-r2.py` does: the entry of this version replaced, versions sorted newest
  first by its `semver_key` (numbers, a release above its pre-releases), **`latest_version` =
  the highest** version (publishing a lower one does not make it latest; the answer says
  `latestVersion`), every other field kept, `json.dumps(indent=2)` + newline with its ASCII
  escaping. `test/linux-release.test.ts` holds the Worker to `upload-r2.py`'s own output
  (`test/fixtures/linux/root-manifests.json`, made by `npm run fixtures:linux` with the real
  `upload()` against an in-memory bucket).
- **No signature**: the go-deploy contract has none; integrity is the SHA-256 in the root
  manifest, which the Moduline dashboard sends with the update. The Keys page stays S1-only.
- Controllers download through the Moduline signed route (`updates.gocontroll.tech`), not from a
  Deploy host: root-manifest paths are relative, and a Linux application has no distribution URL.
- `GET /api/folders/:appId/versions/:version/tarball` gives a stored package (Access-protected),
  so the browser can take a post-install script over from the latest release.
- Uploads are multipart; a whole request is at most about 100 MB at Cloudflare's edge, and the
  Worker holds the package in memory once (128 MB per isolate), so stay well below that.

### Applications, settings and the controller type

An application is a folder: what the bucket holds under `<APP_ID>/`, a signing key, or settings
in `STATE` (`folders/<APP_ID>.json`). Any of the three makes it show on Status and gives it a
page.

- **New application** (`POST /api/folders`): only settings (customer, controller, who and
  when; for S1 also the distribution URL its first release gets); nothing in the bucket until its
  first release. 409 when the App ID has objects, a key or settings already. S1 App IDs follow
  the publishing rules; Linux ones (M1, L4, HMI1) `^[a-z0-9][a-z0-9._-]*$`, at most 64
  characters (the CI config's pattern), without a distribution URL.
- **Settings** (`PUT /api/folders/:appId/settings`): customer and controller by hand; a field
  left out stays, `null` goes back to the derived value.
- **Controller type**, first that applies: set by hand (`S1`, `M1`, `L4`, `HMI1`); an S1 manifest
  (`binaries`) means `S1`; the most common `controller_series.controller_type` of the controllers
  on that App ID in gocontroll-db, without its `Moduline ` prefix (so it can also be, say, `M2`),
  where a Linux manifest leaves the S1 controllers out (one App ID can have both); else none.
  The API gives `controller` and `controllerSource` (`manual`, `manifest`, `controllers` or
  `null`) next to `kind` (`s1`, `linux`, `unknown`: what the manifest is). Without a manifest a
  folder counts as `s1` when its settings say S1 (or when it has a key and no controller set:
  keys are only made for S1), and as `linux` when they say M1, L4 or HMI1.

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
| `folders/<APP_ID>.json` | Folder settings: `customer_id` and `controller` set by hand, `distribution_url` (an S1 application made here, for its first release), `package` (a Linux application's package definition), `created_at` / `created_by`, `updated_at` / `updated_by`. Customer, controller and URL are also in the object's custom metadata (marked `index`), so the overview needs one listing. |
| `log/<yyyy>/<mm>/<timestamp>-<APP_ID>-<version or action>.json` | One entry per publish, sign, key action (generate, import, replace), `publish-linux`, `create-folder`, `settings`, `package` and `delete-folder`: action, App ID, version, actor, time, signed, replaced, payload SHA-256, size, description; a publish also its URL, the previous `latest`, the previous manifest and where a replaced binary went; a delete its reason, objects, bytes, controllers and archive. |
| `replaced/<APP_ID>/<APP_ID>-<version>/<timestamp>.bin` | A binary a publish overwrote. |
| `replaced/<APP_ID>/v<version>/<timestamp>/update.tar.gz`, `…/manifest.json` | A Linux release a publish replaced. |
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
npm run fixtures:linux           # only when upload-r2.py changes (the skill next to GOcontroll-Team)
npm run fixtures:tar             # only when build-package.py or public/js/package.js changes
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
(`field`: `appId`, `version`, `description`, `file`, `tarball`, `manifest`, `files.<n>.<name>`,
`privateKey`, `sign`, `distributionUrl`, `confirm`, `customerId`, `controller`, `reason`,
`acknowledgeControllers`, `days`) with
400/403/404/409/413/415/422/500/503.

| Method | Path | |
|---|---|---|
| GET | `/api/me` | Signed-in colleague: email, name, groups (object IDs and names, to look an ID up) |
| GET | `/api/health` | `{ ok, version, signingKeys, downloads }`: whether the KEK and the API token are readable |
| GET | `/api/overview` | Every folder (kind s1/linux/unknown, `controller` + `controllerSource`, latest, releases, bytes, last upload, distribution URL, key, `inBucket`, customer, controllers), the customers with their folders, totals, `distributionUrls`, download totals of 7 and 30 days |
| GET | `/api/folders/:appId` | One folder: kind, controller, customer, key; releases with their stored header (range read), `keyMatches`, `digestMatches`, size, upload time and downloads; Linux versions; objects the manifest does not name; `objects: { count, bytes }`; `deleting` (an unfinished delete, or null); for a Linux application `package`, `packageSource`, and `latestVersionManifest` (the parsed version manifest of the latest release) or `latestVersionManifestError`; controllers per version and per distribution URL; downloads per day. 404 when nothing exists for it |
| POST | `/api/folders` | `{ appId, customerId, controller: "S1" \| "M1" \| "L4" \| "HMI1", distributionUrl }` (no `distributionUrl` for Linux) → 201 `{ appId }`: a new application (settings only). 409 when it exists |
| PUT | `/api/folders/:appId/package` | A Linux application's package definition `{ owner?, group?, files: [ { name, destination, mode, owner?, group? } ], post_install?: { mode: "none" } \| { mode: "services", services } \| { mode: "script", script } }` → `{ package, packageSource: "manual" }` |
| POST | `/api/linux-releases` | multipart `appId`, `version`, `description`, `replace`, `tarball` (gzip, ≤ 100 MB), `manifest` (the version manifest, text or file) → `{ tarballKey, manifestKey, rootManifestKey, version, released, sha256, sizeBytes, previousLatest, latestVersion, replaced }` |
| GET | `/api/folders/:appId/versions/:version/tarball` | The stored package of a Linux release (`application/gzip`, `private, no-store`) |
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
- **A Linux release**: publish the version before it again (*replace*) or a newer one; a
  replaced one is in `STATE` `replaced/<APP_ID>/v<version>/<timestamp>/` (package and version
  manifest) and the root manifest before every publish is in its `publish-linux` log entry
  (`previous_manifest`); put them back with `npx wrangler r2 object put`, the root manifest last
  (`application/gzip` for the package, `application/json` for the manifests).
- **A key**: the replaced one is in `keys-retired/<APP_ID>/`; copying it back to
  `keys/<APP_ID>.json` makes it active again (it stays sealed for that App ID).
- **A deleted folder**: put it back from `deleted/…`, the manifest last
  ([Restoring a deleted folder](#deleting-a-folder)).
- **Removing the app**: delete the Worker (`npx wrangler delete gocontroll-deploy-intranet`)
  and the hub tile. The distribution bucket is not this app's and stays as it is; keep the
  state bucket (the sealed keys, the log).

## Relation to the Deployment Tool, the CI pipeline and the specs

Linux applications follow `GOcontroll-Architecture/cloudflare/linux-application/spec.md`; their
other producer is the CI pipeline of the skill `r2-application-deploy-setup` (Deploy writes what
its `upload-r2.py` writes), their consumers the Moduline dashboard (which sends the update with
the root manifest's SHA-256 and the version manifest's `files[]`) and go-deploy on the
controller.

The **Deployment Tool** (`GOcontroll-Deployment-Tool`) programs and provisions S1 controllers
over Bluetooth and publishes from a laptop with a `.cred` file; Deploy publishes to the same
bucket in the same format from the browser, with the key kept here instead of in a file. Both
follow the S1 knowledge base (`cloud-r2-distribution.md`, `code-signing-local.md`,
`deployment-tool.md`); when a format changes there, both follow. Provisioning a controller's
App ID, distribution URL and public key stays the Deployment Tool's job; moving an App ID from
`deploy.gocontroll.com` to `deploy.gocontroll.tech` follows `cloud-r2-distribution.md` §2.1
(Deploy shows `mixedHosts` and the controllers' distribution URLs per folder, and never mixes
hosts when it writes).
