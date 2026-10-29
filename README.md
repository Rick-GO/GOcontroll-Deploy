# GOcontroll Deploy

Publishing controller applications at **https://deploy.gocontroll.tools**: Moduline **S1**
firmware (an STM32 application binary in a GOCO container, signed when the application has a
public key, in the browser, with the private key the colleague gives) and, for **M1, L4 and HMI1**, Linux **go-deploy packages** (`update.tar.gz` + version
manifest), into GOcontroll's own distribution bucket (R2 `gocontroll-deploy`), with the manifest
pointing at them so controllers on update-to-latest install them. A binary can also be signed without publishing it (the signed container comes back
as a download). The **Key generator** makes signing key pairs in the browser; Deploy keeps only the
**public key, per application** (to copy or download when a controller is provisioned), never a
private key. And the **status** of every
deployment: customers → their applications (App ID folders) → controller type, releases, file
and header checks, the controllers on that App ID and the download counts. New applications (S1
and Linux) are made here; an application folder can be deleted, strongly protected and always archived
first. Next to that, **module firmware** (the `.srec` files go-modules flashes into the plug-in
modules of an L4, M1 or HMI1) is published to **firmware.gocontroll.tech** (R2
`gocontroll-firmware`), and **Linux images and tools** for customers go to R2 `gocontroll-images`,
which the second Worker of this repo serves on **images.gocontroll.tech** to anyone who signs in
there with their e-mail address and a link by mail ([`images/README.md`](images/README.md)); the
Images tab shows how often each release is downloaded. For the members of the Entra group
**`CF_Deploy`** only.

> **Status: live on `deploy.gocontroll.tools` since 2026-10-21, for the members of `CF_Deploy`.**
> The Worker, the API and the pages are deployed (0.7.0 on 2026-10-29: the tabs are **Applications**, **Firmware**, **Images** and
> **Key generator** (were Status and Keys; old links still work); key pairs are made in the browser and Deploy keeps only the public key
> per application; a signed S1 release is signed in the browser with the private key the colleague gives, and the Worker checks the
> signature against the public key ([Signing keys](#signing-keys)); 0.6.1 on 2026-10-29, version `ebd51294`: choosing a module's repository folder on the Firmware tab
> asks GitHub whether HEAD is the newest commit of its branch and warns when GitHub has newer commits, when HEAD is not pushed, or
> both ([Module firmware](#module-firmware-firmwaregocontrolltech)); 0.6.0 on 2026-10-28, version `86d281d3`, `gocontroll-images` version `5cb45e29`: images.gocontroll.tech signs customers in with
> their e-mail address and a link by mail instead of Access with a one-time PIN; this Worker sends that mail through its RPC
> entrypoint `ImagesMail` (Graph, `MS365_CLIENT_SECRET`); the Images tab counts downloads per release and per month and copies
> a customer link per file; the site is open since 2026-10-28 (`gocontroll-images` version `ebae60ed`, the owner's Turnstile
> widget, [`images/README.md`](images/README.md) → *One-time setup*); 0.5.1 on 2026-10-28: the page says per repository whether Deploy can
> tag and release there; the token is set, valid until 2027-10-29; 0.5.0 on 2026-10-28, version `6370d878`: after a module firmware
> publish Deploy sets the tag and makes the GitHub release itself ([GitHub releases](#github-releases)); 0.4.1 on 2026-10-28, version `acbf96ba`: the Firmware tab follows the
> rules of the retired firmware agent 08: the file as git holds it, review with a dry run, never a changed `.srec`,
> `latest_firmware` never down, the tag for the safety net; 0.4.0 on 2026-10-28, version `4876a23e`: the tabs **Firmware** and
> **Images**, and the Worker `gocontroll-images` on `images.gocontroll.tech` (version `9a2c1639`); 0.3.1 on 2026-10-23: plain HTTP redirected to HTTPS and the
> security headers on `/pub/` too; 0.3.0 on 2026-10-21: Linux releases for M1, L4 and HMI1 next to
> S1; 0.2.0: Status and Keys tabs, new applications, releases from the folder page, protected
> folder delete); the Access application
> (with its `/pub` bypass) exists and its AUD is in `POLICY_AUD`; `DEPLOY_GROUPS` and the hub tile
> hold the object ID of `CF_Deploy`. Download counts wait for the Cloudflare API token
> ([Download counts](#download-counts)).

## Pages

The tab bar holds **Applications**, **Firmware**, **Images** and **Key generator**, in that order (`public/js/routes.js`); an
application (folder) has a page of its own. Plain ES modules in `public/js/` (`app.js` routes, one module per page), no framework,
no build step. Older links keep working (bookmarks), replaced without a new history entry: `#/` and `#/status` (with their
`?q=&show=`) go to `#/applications`, `#/folders/<APP_ID>` to `#/applications/<APP_ID>`, `#/keys` (the Keys tab until 0.6.1) to
`#/key-generator`, and `#/publish` and `#/sign` (milestone 1) to the application of their `?app=`, else to Applications.

| Page | What you do there |
|---|---|
| **Applications** (`#/applications`) | Totals, then every customer with its applications and the folders without a customer. Columns: App ID, Controller (S1, M1, L4, HMI1 or a derived type), latest, releases, public key (short, with Copy for the whole: for provisioning; "No" for an S1 application without one, "n/a" for a Linux application without one), last upload. Search and a filter (all / S1 / S1 without public key / M1 / L4 / HMI1 / controller unknown) stay in the address. At the bottom, **New application…**: controller S1, M1, L4 or HMI1, then the App ID (S1: up to 32 characters, no spaces or "/"; Linux: lower case `^[a-z0-9][a-z0-9._-]*$`, up to 64), customer, and for S1 the distribution host. Creating it opens its folder page. |
| **Application, S1** (`#/applications/<APP_ID>`) | Customer and controller (**Change…** each). **New release** in three steps: **1 File** (`.bin` / S-record / GOCO container, version from the filename) → **2 Sign** (the public key with Copy, and the **private key**: pasted, or from a file (`.pem`, the base64 value, a `.cred` file); checked in the browser against the public key, "belongs" or "does not belong", as soon as it is given; it stays in the browser. A container signed already needs none. Without a public key: *Generate key pair…* or *Attach a public key…* right there, or tick *publish unsigned*) → **3 Publish** (description, Replace… / latest-moves-back confirmations, binary URL with Copy), or **Download signed file instead**. Then the releases with header checks, the **Public key** card (Copy, *Download .pub*, where it came from, *Replace…*; a warning when the signed releases carry another key, with that key to attach), controllers per version, downloads per day, other files, and the **Danger zone**. |
| **Application, Linux (M1, L4, HMI1)** | Customer and controller. **Package** card: the files in `files/` (name, destination, mode, owner, group) with Add / Edit / Remove; default owner and group; after install: Nothing, *Restart services* (comma list, nodered and go-simulink suggested, preview of the rendered `post-install.sh.tmpl`) or *A script of its own*. **Save package**; **Import r2-deploy.config.json…** (paste or file); **From the latest release** (files from its version manifest, `files/post-install.sh` from its tarball). **New release** in three steps: **1 Files**: one file per package file (choose per row, or drop several, matched by name), or *Upload a built package* (`update.tar.gz` + `manifest.json` from a CI `dist/`, sent as they are after a SHA-256 check here), plus the version (next patch of latest) and what changed. **2 Review**: not signed, and why (go-deploy checks SHA-256 only); size and SHA-256 of the tarball; the version manifest's files with destination, mode, owner and short SHA-256; the post-install script; `manifest.json` as it will be written; what happens to `latest_version`. **3 Publish**: Publish / Replace…, progress, result (keys written, SHA-256 with Copy, size, `latest_version`). Then the Versions table (with a Tarball download per version), the **Public key** card (a public key can be kept for provisioning; Linux packages are not signed), controllers per version, downloads, other files, Danger zone. |
| **Firmware** (`#/firmware`) | Module firmware on firmware.gocontroll.tech, the way the Moduline Module Firmware Deployer (agent 08) published it. **Publish firmware**: *Choose the source folder…* (the module's repository, e.g. `Module-Input`; `showDirectoryPicker`, or a folder field in browsers without it, or drop the folder) or *Choose .srec files…*. From a folder Deploy takes every `<…>-BOOT/<name>.srec`, as the CI did, and reads the repository's `.git` in the browser: the line above the files names the repository, branch, HEAD and the number of version tags; the next notice says whether HEAD is the newest commit of its branch, asked of GitHub every time a folder is chosen: green when it is, a warning when GitHub has newer commits (with how many and the newest; pull first and choose the folder again), when HEAD is not on GitHub yet (push first), when both moved on, or when the branch is not on GitHub; without GitHub (no token, a repository Deploy may not read) the same from `origin/<branch>` as of the last fetch, saying so. A notice after that says that the repository has no publish workflow of its own (the safety net, removed from every module repository on 2026-10-29), or, should one be back, what it would do differently. Per file: module (name, hardware ID, hardware version, from the file name), version, file date and status: **New**, **Published** (the same bytes), **Published, other bytes** (cannot be published: a correction gets a new version number) or why it **cannot be used** (not committed, differs from the commit, not an S-record). Per version: the **release date** (the tag's `RELEASE_DATE` when tag `v<version>` exists, else the file's date), the **changelog** (the tag's text, else typed: one line in English, with the commits since the previous version tag beside it), the name of a module that is new on firmware.gocontroll.tech, and for a published version *Publish again* (its manifest entry, same file). **Review N files…** sends each file as a dry run and shows what will be written (new file or identical, entry added or written again, `latest_firmware` before → after, the module manifest); **Publish** writes them, lowest version first. Per version the review has *Then set tag v<version> … and make the GitHub release*, ticked when Deploy can (token set, repository folder chosen, HEAD pushed, not an older version under a safety net; else the reason): after publishing Deploy sets the tag and makes the release with the `.srec` attached, and links both (a tag that says something else: *Replace v<version>…*). Without that, or when GitHub refuses: **Set tag v<version>** with the annotation (Copy, Download), the commands and the link to make the release by hand. Below: every module (name, hardware version and ID, latest, date, number of releases), unfolding into its releases: version (link to the file, *flashed* on the first), date, changelog, SHA-256 with Copy, and who published it from Deploy and from which repository and commit, or *CI of the module repository* (published before 2026-10-29). |
| **Images** (`#/images`) | Linux images and tools for customers on images.gocontroll.tech. **New release…**: image (for L4, M1 and/or HMI1) or tool, product (e.g. `moduline-headless`), version, title, controllers, release date, notes. A release is a **draft** until **Publish**; per draft *Add files…* (role guessed from the name: root file system, kernel, bootloader, device tree, flash script, tool, documentation, other; and the computer it runs on), upload with progress per file (32 MiB parts, three at a time, retried), the SHA-256 of each file as stored; *Remove* a file, *Edit…*, *Delete draft…*. A published release can be edited (text only) or **Withdrawn** (back to a draft; the files stay). Unfinished uploads with *Abort*. Per file of a published release **Copy link**: the customer link `images.gocontroll.tech/download/<path>` (sign in, then that file starts). **Downloads**: per release in all, this month and last month, and per month the downloads, different addresses and countries; the release cards show their count. **Latest downloads**: who downloaded which file when, this month and last month, as images.gocontroll.tech logs it. |
| **Key generator** (`#/key-generator`, `?app=<APP_ID>` picks the application) | **Generate key pair**: an ECDSA P-256 pair made in the browser (`public/js/signing.js`), optionally for an application without a public key. A window shows the public key, the private key as base64 (`FW_PRIVATE_KEY_B64`) and as PEM, each with Copy, and **Download private key** (`<APP_ID>-signing-key.pem`) and **Download public key** (`<APP_ID>-signing-key.pub`): the files of `s1_ble.py keygen --out`. *Attach to <APP_ID>* sends the public key once *I have stored the private key* is ticked. The window closes with Close, the x and Escape; while the private key is neither downloaded nor marked as stored, closing first asks (*Close without it* / *Back to the key pair*), because the private key is gone after it. Closed without attaching (and stored), the page keeps the public key to copy, download or attach to an application. Replacing an application's key is done on its page. |

## How it works

```
browser ──► Cloudflare Access (Entra ID, group CF_Deploy) ──► Worker gocontroll-deploy-intranet
   │ reads .bin/.srec, compresses (zlib)                         │  verifies Cf-Access-Jwt-Assertion
   │ and sends payload + raw size,                               │  and an object ID in DEPLOY_GROUPS
   │ or a ready-made GOCO container;                             │
   │ signs the scope the Worker gives with the                   │  checks the signature against the
   │ colleague's private key (never sent)                        │  application's public key
   │                                                             ├─► R2 gocontroll-deploy        (the distribution bucket: read + publish)
                                                                 ├─► R2 gocontroll-deploy-state  (public keys, folder settings, log, download days, image releases)
                                                                 ├─► R2 gocontroll-firmware      (module firmware: .srec + manifests)
                                                                 ├─► R2 gocontroll-images        (images and tools, manifest.json; reads downloads/)
                                                                 ├─► D1 gocontroll-business      (customers, projects: read only)
                                                                 ├─► D1 gocontroll-db            (controllers, project_provisioning: read only)
                                                                 ├─► Secrets Store               (DEPLOY_GITHUB_TOKEN, MS365_CLIENT_SECRET, DEPLOY_SIGNING_KEYS_KEY of the keys sealed before 0.7.0; DEPLOY_CF_API_TOKEN later)
                                                                 ├─► Microsoft Graph             (ImagesMail: the sign-in links of images.gocontroll.tech)
                                                                 └─► Cloudflare GraphQL Analytics (download counts, once the token exists)
cron 17 2 * * * ─────────────────────────────────────────────► the download counts of finished days, and the image counts of finished months, into STATE

controllers ──► https://deploy.gocontroll.tech (Worker gocontroll-deploy) ┐
            ──► https://deploy.gocontroll.com  (R2 custom domain)         ┴─► the same bucket, byte for byte

go-modules  ──► https://firmware.gocontroll.tech (Worker gocontroll-firmware) ┐
            ──► https://firmware.gocontroll.com  (R2 custom domain)           ┴─► gocontroll-firmware

customers   ──► e-mail address + Turnstile, link by mail ──► Worker gocontroll-images (images/, images.gocontroll.tech)
                                                                 ├─► R2 gocontroll-images (only what manifest.json names; writes downloads/ and access-mails/)
                                                                 └─► service binding MAIL ──► this Worker's entrypoint ImagesMail ──► Graph, from noreply@
```

- **One Worker with static assets** (`public/`), like Logistic, Finance, the CRM and Hours:
  `run_worker_first = true` sends every request through the token check in `src/index.ts`; only
  `/pub/*` (brand assets) skips it, via an Access bypass app. Before all of that, **plain HTTP
  is redirected** to the same path and query on `https://` on every path (301 for GET/HEAD, 308
  otherwise; `src/lib/https.ts`, the copy of GOcontroll-Configurator's): Access does so for the
  paths it protects, not for the `/pub/` bypass (F4 of the external security assessment of
  2026-10-23, `GOcontroll-Team/docs/security/external-security-assessment-configurator-2026-10-23.md`);
  `http://localhost` (`wrangler dev`) is never redirected. Its name is
  `gocontroll-deploy-intranet`, not `gocontroll-deploy`: that is the public Worker of the
  Deployment Tool on `deploy.gocontroll.tech` that serves the same bucket to controllers.
- **Identity and access**: the verified Access token (`src/access.ts`, the copy of Logistic,
  Finance and the CRM), name and groups from `get-identity`. On top of the Access policy the
  Worker requires one of `DEPLOY_GROUPS` (`src/auth.ts`), matched on the group's **object ID
  only**: any employee can create a Microsoft 365 group with any name. An empty `DEPLOY_GROUPS`
  or a failed group lookup lets nobody in. Every write records the colleague as actor.
- **Server**: TypeScript + Hono + zod (`src/`). **Browser**: plain ES modules with
  `// @ts-check` (`public/js/`), no framework, no build step. The CSP forbids inline scripts
  and style attributes:
  `default-src 'none'; style-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  Every page, asset, `/pub/*` file, API answer (refusals and errors included) and HTTP redirect
  carries it together with `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Frame-Options: DENY` and `Strict-Transport-Security:
  max-age=31536000` (this hostname only, no `includeSubDomains`): `SECURITY_HEADERS` in
  `src/lib/headers.ts`; on `/pub/*` and the API, and HSTS and `X-Frame-Options` at all, since
  2026-10-23 (0.3.1, F4). The 403 of the token check (page or JSON) has none of them (the page
  has inline styles).
- **Small uploads, little Worker CPU**: the browser parses the S-record and compresses the
  image (`CompressionStream('deflate')`, a zlib stream); the Worker never inflates. It
  hashes and checks signatures with `crypto.subtle`, computes the CRC over the header only, writes header
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
Python-signed one, which must verify here; and one signed the way Deploy signs since 0.7.0 (the
scope from `src/goco.ts` `signedScope`, signed by `public/js/signing.js` as the browser does, put
together by `headerWithSignature`), which Python's `verify_signature` verified when the fixtures
were made. Python also reads a key pair made by `public/js/signing.js` `generateKeyPair` (what the
Key generator downloads): its PEM gives the same scalar as its base64 value, and the public key
`keys.py` derives is its `.pub` (`browser_key_pair_read_by_python`). The Deployment Tool sits next
to `GOcontroll-Team` (`DEPLOYMENT_TOOL=<its tools dir>` otherwise); its Python needs `cryptography`.

### Publishing a release

`POST /api/releases` does what `r2.py publish()` does; the private key is the colleague's, the
signature is made in the browser ([Signing keys](#signing-keys)):

- a description is mandatory (the manifest carries it as the release note);
- a folder holding a Linux manifest (go-deploy packages: `versions[]`) is refused here (Linux
  releases go through `POST /api/linux-releases`), and so is a manifest that cannot be read or
  has no `binaries`: an S1 release never goes into another format;
- a version already in the manifest is refused (409) unless *replace* is ticked: that binary
  may be on controllers already;
- an application with a public key only gets releases signed with its private key: the upload
  carries the `signature` the browser made (over the scope `POST /api/sign/scope` gave, followed by
  the payload); the Worker builds the scope again from what was uploaded, puts the header together
  and refuses it unless the signature verifies against the public key (422, `signature`), before
  anything is written. An unsigned container is re-wrapped the same way (its payload taken over); a
  container already signed with this key goes out as it is, one signed with another key is
  refused; without a signature (and not signed already) it is refused (422, `signature`). A
  signature for an application without a public key is refused, and so is any request that carries
  a private key (400, `privateKey`: not read, not kept, not logged);
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
  manifest, which the Moduline dashboard sends with the update. Signing stays S1-only; a public key
  can still be attached to a Linux application, kept for provisioning (`POST /api/sign/scope` refuses
  it).
- Controllers download through the Moduline signed route (`updates.gocontroll.tech`), not from a
  Deploy host: root-manifest paths are relative, and a Linux application has no distribution URL.
- `GET /api/folders/:appId/versions/:version/tarball` gives a stored package (Access-protected),
  so the browser can take a post-install script over from the latest release.
- Uploads are multipart; a whole request is at most about 100 MB at Cloudflare's edge, and the
  Worker holds the package in memory once (128 MB per isolate), so stay well below that.

### Module firmware (firmware.gocontroll.tech)

Contract: `GOcontroll-Architecture/cloudflare/firmware/spec.md`. Deploy took over from the
**Moduline Module Firmware Deployer** (agent 08, `18-Agents/08 - Moduline Module Firmware Deployer`,
retired 2026-10-28), which published locally with wrangler and `publish_firmware_r2.py`; its rules are
Deploy's. Deploy is the **only producer** since 2026-10-29. Until then the CI of the module
repositories published too (`Module-*/.github/scripts/publish_firmware.py`, run on a `v*` tag whose
annotation holds `RELEASE_DATE:`, `DEPLOY_FILES:` and the changelog; skill
`module-firmware-deployment`); that workflow, its script and the skill are removed. Deploy writes what
that script wrote, in its order (`src/firmware.ts`):

1. `modules/<hw_id>/<file>.srec` (`application/octet-stream`);
2. `modules/<hw_id>/manifest.json`: `{ id, name, hardware_version, releases: [ { sw_version, file,
   date (DD/MM/YY), sha256, changelog } ] }`;
3. `modules/manifest.json`: `{ updated (YYYY-MM-DD, UTC), modules: [ { id, name, hardware_version,
   latest_firmware, manifest } ] }`.

Both manifests as `json.dumps(indent=2, ensure_ascii=False)`, without a trailing newline. The file
name carries module and version: `20-10-1-6-2-0-3.srec` = hardware ID `20100106` (each of the first
four parts zero-padded to two digits), hardware version `1.06`, firmware `2.0.3`. A new hardware ID
takes the name its manifest will have from another hardware version of the same type in
`modules/manifest.json`, else from the list in `src/firmware.ts` (the manifests' names, agent 08's
table; for `202001` and `204001` they differ from `GOcontroll-Architecture/modules/naming.md`), else
the colleague types it. The name of an existing module is never changed. `test/firmware.test.ts`
checks that Deploy writes the same objects in the same order as the real `publish_firmware.py`, byte
for byte (`modules/manifest.json` apart from `updated`, the script's clock), against what the script
wrote (`test/fixtures/firmware/ci-manifests.json`, made by `npm run fixtures:firmware`: boto3 stubbed,
`python -I`). The script is no longer in the module repositories, so that command only runs with the
script put back at its path from the history
(`git -C ../../Module-4-20mA show 61fa466:.github/scripts/publish_firmware.py`).

Where Deploy differs from the script, on purpose:

- **Releases highest version first**. go-modules flashes `releases[0]`; the script puts the newest
  *upload* first, so an older version published after a newer one would roll every controller back
  (the skill avoided it by pushing tags in order). **`latest_firmware` never goes down**: the higher of
  what it was and the highest release.
- **A published firmware never changes**: other bytes under an existing file name are always refused
  (409, `conflict: "file"`); a correction gets a new version number. A version that is in the
  manifest is refused (409, `conflict: "release"`) unless *Publish again* (`replace`) is ticked, which
  writes its entry again with the same file (a corrected changelog or date). The script replaces the
  entry silently and skips the upload of an existing file while writing the SHA-256 of its own copy.
- **Review first**: `dry_run=true` checks everything and answers what would be written (the module
  manifest as it would be, `latest_firmware` before and after) without writing; the page always shows
  that before it publishes.
- **Conditional writes** (R2 etag) on both manifests, retried on the newer version: a publish at the
  same time (two colleagues) is not lost.
- **The file as git holds it**: from a repository the page sends the blob at HEAD (`git.js`
  `fileAt`), never the work tree's copy, and refuses a file that is not committed or differs from the
  commit; the Worker refuses a CR. A Windows checkout (`core.autocrlf=true`) has CRLF; git
  has LF (`20-20-2-7-2-3-1.srec`: 95,756 bytes in the work tree, 93,758 in git, only the second
  matches the live SHA-256 `27e555f0…`). Loose files are converted from CRLF to LF.
- **The changelog as the CI read it from a tag**: every line without trailing white space, no blank lines,
  trimmed (`normaliseChangelog`); a line may not start with `RELEASE_DATE:` or `DEPLOY_FILES:`.

The browser checks every record of the `.srec` (`parseSrec`, `public/js/source.js`); the Worker only
checks that every line is an S-record and computes the SHA-256. **Git in the browser**
(`public/js/git.js`): from the chosen folder it reads `.git` (loose objects and packs, refs and
`packed-refs`, annotated tags, the files of a commit, origin's URL and tracking branch) without
writing anything. It suggests the release date and changelog of an existing tag `v<version>` (the
annotation without its `RELEASE_DATE:`/`DEPLOY_FILES:` lines and blank lines, as the CI read it), and
lists the commits since the previous version tag (at most 50) to write a new one from. **Is HEAD the
newest commit?** Every time a folder is chosen the page asks GitHub (`GET /api/firmware/github` with
the branch and HEAD; the Worker reads the branch and compares, `src/github.ts` `checkGitHub`, read only)
and says it above the files: GitHub has newer commits (pull first: the files, the suggested changelog
and the tag all follow HEAD), HEAD is not on GitHub yet (push first), both moved on, or the branch is
not on GitHub. When GitHub does not know HEAD at all, the page's own history decides whether GitHub is
also ahead (does HEAD reach GitHub's newest commit?). A detached HEAD is compared with the default
branch. Without GitHub the same comes from `origin/<branch>` as of the last fetch, and the notice says
so. It is a warning, not a block; the review repeats it. A worktree or
submodule (`.git` is a file) cannot be read: choose the main repository. The log entry and
`firmware-log/<hw_id>/<version>.json` keep the repository, branch, HEAD commit, path, tag and whether
HEAD was pushed.

**The tag.** Pushing a tag `v<version>` publishes nothing any more. Until 2026-10-29 every module
repository had `publish-firmware.yml` (the safety net, agent 08's choice of 2026-07-21), which rebuilt
the manifest entry from the tag's annotation; on 2026-10-29 it was removed from all of them. The tag
still records what was published, and Deploy suggests a version's date and changelog from it. After a
publish the page gives, per version, the annotation (`RELEASE_DATE: DD/MM/YY`, `DEPLOY_FILES: <files>`,
blank line, the changelog as stored), to copy or download, and the commands:
`git tag -a v<version> --cleanup=whitespace -F "$HOME/Downloads/tag-v<version>.txt" <commit>`
(the commit the files were read from) and `git push origin v<version>`; when the tag exists with other
text, first `git tag -d` and `git push origin --delete`, as the agent did; nothing when it matches. Then
the GitHub release (link to `…/releases/new?tag=`). With a GitHub token Deploy does all of this itself
([GitHub releases](#github-releases)).
Before publishing the page still looks for the workflow (`safetyNetFindings`). Without it, which is now
every module repository, the notice only says there is no safety net. Should a repository get it back,
the notice lists its `MODULE_NAME` against the manifests' name, the secrets
`FIRM_R2_ACCESS_KEY_ID`/`FIRM_R2_SECRET_ACCESS_KEY`/`CF_ACCOUNT_ID`, and whether its script is there
and has the version check on `latest_firmware`.

### GitHub releases

After a publish Deploy sets the tag and makes the release in the module's repository itself
(`src/github.ts`, `POST /api/firmware/releases`), ticked per version in the review:

1. **What the tag says comes from the published manifests**, not from the browser: per file the entry
   of that version in `modules/<hw_id>/manifest.json`; all files of one version must have the same date
   and changelog (one tag cannot say two things).
2. **The files at that commit on GitHub are the published ones**: every `<…>-BOOT/<file>.srec` at the
   commit (the HEAD the page read) is fetched from GitHub and must have the published SHA-256. So the
   commit is pushed and holds exactly what controllers get; else 409 and nothing is written.
3. **No tag for an older version under a safety net**: when the repository has
   `.github/workflows/publish-firmware.yml` and the version is below the highest of one of its modules,
   pushing the tag would start the workflow, which puts its version first in that module's manifest
   (go-modules would flash the older firmware). 409, no tag. No module repository has the workflow
   since 2026-10-29, so this no longer happens.
4. **The annotated tag**: `POST git/tags` (message `RELEASE_DATE: DD/MM/YY`, `DEPLOY_FILES: <files>`,
   blank line, the changelog; tagger = the colleague) and `POST git/refs`. Never the release API's own
   tag: that is a lightweight tag, with no annotation to read the date and changelog from. A tag that
   says the same on the same commit is kept; one that says
   something else is replaced only when the colleague confirms (*Replace…*: `DELETE git/refs/tags/…`,
   then set again), as agent 08 did.
5. **The release** `v<version>`: the changelog as its notes, the `.srec` files from the bucket as assets;
   an existing release keeps its assets and gets the missing ones.

Every call is in the audit log (`github-release`). Repositories: `GITHUB_REPOS` (`GOcontroll/Module-*`),
and the token's own repository list.

**The token** (once, by the owner): github.com → *Settings → Developer settings → Personal access
tokens → Fine-grained tokens → Generate new token*. Resource owner **GOcontroll** (the organisation may
have to allow or approve fine-grained tokens: *Organization settings → Personal access tokens*).
Repository access: *Only select repositories*, the `Module-*` repositories. Repository permissions:
**Contents: Read and write** (Metadata: Read comes with it), nothing else. Expiry as long as allowed;
note the date. Then Cloudflare → *Secrets Store → default_secrets_store → `DEPLOY_GITHUB_TOKEN` →
Edit*, paste, save; no deploy needed. The secret was made on 2026-10-28 with the placeholder `not-set`
(off): the review then says GitHub is not set up and the page gives the commands. **Set on 2026-10-28**: a
fine-grained token, **valid until 2027-10-29** (renew before then: same steps, same secret), checked the same
day with a read on GitHub: all eleven `Module-*` repositories readable, nothing outside them (GOcontroll-Team:
404). Write access shows at the first tag. When you choose a repository folder, the page says whether Deploy
can tag and release there and whether HEAD is the newest commit of its branch on GitHub (`GET /api/firmware/github`). A tag made with this
token starts workflows (unlike one made with a workflow's own `GITHUB_TOKEN`). Way back: set the value
to `not-set` again and revoke the token on GitHub; tags and releases already made stay.

### Images and tools for customers (images.gocontroll.tech)

The bucket **`gocontroll-images`** holds releases of two kinds, laid out and described in
`src/images-format.ts` (contract `GOcontroll-Architecture/cloudflare/images/spec.md`):
`images/<product>/<version>/<file>` (an image for L4/M1/HMI1: root file system, kernel, bootloader…)
and `tools/<product>/<version>/<file>` (what installs it: flash scripts, `imx-usb-loader`, `fastboot`…),
plus **`manifest.json`**, the catalogue customers see. Deploy (`src/images.ts`) is its only writer.

- **Draft → published**: a release's record is in `STATE` `images/releases/<kind>/<product>/<version>.json`
  (metadata, files with size and SHA-256, who and when). Its files go into the bucket as they are
  uploaded, but images.gocontroll.tech serves nothing that `manifest.json` does not name. **Publish**
  writes the release into `manifest.json` (etag-conditional, retried); **Withdraw** takes it out (files
  stay). `manifest.json` holds no e-mail address and no draft. Only a draft can lose files or be deleted
  (then its files are deleted from the bucket, no archive: images are rebuilt from their source).
- **Upload in parts**: one request carries at most ~100 MB, images are GBs. The browser starts an R2
  multipart upload (`POST …/files`, size, role, platform), sends parts of exactly `PART_SIZE` (32 MiB;
  the last one the rest) as raw bytes (`PUT /api/images/uploads/<id>/parts/<n>`, streamed into R2,
  three at a time, each retried), then completes. On completion the Worker checks the size and reads
  the stored object once through `crypto.DigestStream`: the SHA-256 customers see is that of what they
  download. An unfinished upload is in `STATE` `images/uploads/<id>.json` until it is aborted (R2 drops
  its parts after 7 days).
- **Downloads**: images.gocontroll.tech writes an empty object per download under `downloads/<yyyy>/<mm>/`
  with who (the e-mail address that opened the sign-in link), what and the country in its custom
  metadata; the Images tab lists this month's and last month's (one listing per month, no reads), at
  most 200. They are kept 13 months: an R2 lifecycle rule on `downloads/` ([`images/README.md`](images/README.md)).
- **Counts** (`src/images-stats.ts`): per release in all, this month and last month; per month the
  downloads, the number of different addresses and the countries. Every finished month is summed once
  from the log into `STATE` `images/stats/<yyyy-mm>.json`, **without addresses**, and kept, so the counts
  outlive the 13-month log; the month under way is counted live. Stored by the daily cron and when
  someone looks (at most 6 months per run), an hour after the month ended. A download counts when a file
  starts (not a resume or a later chunk).
- **Customer link**: *Copy link* next to a file of a published release gives
  `https://images.gocontroll.tech/download/<path>`: it asks a customer to sign in first, then shows that
  file and starts it.
- **The sign-in mail** (`src/images-mail.ts`): the download site binds this Worker's RPC entrypoint
  **`ImagesMail`** (`export { ImagesMail }` in `src/index.ts`). `sendAccessLink({ email, link, file? })`
  mails one fixed message in the house style (logo inline from `public/pub/logo.png`) through Microsoft
  Graph from `MAIL_FROM` (noreply@gocontroll.com), Reply-To `IMAGES_MAIL_REPLY_TO` (info@gocontroll.com),
  only to that one address (`normaliseEmail`), only with a link `<IMAGES_URL>/access?t=<LINK_TOKEN_RE>`
  and a file name; anything else is refused before Microsoft is asked. Answers `{ ok }` or
  `{ ok: false, error }`, never throws; the log names the address's domain only. Graph as in Hours and
  the Configurator (`src/mail/graph.ts`, a copy of the Configurator's): `MS365_TENANT_ID`,
  `MS365_CLIENT_ID`, `MS365_CLIENT_SECRET` (Secrets Store, shared with Hours, the Configurator and
  Finance). The abuse checks (Turnstile, a rate limit per IP, 5 links per address per hour) are the
  download site's, before it calls.

The download site is the Worker **`gocontroll-images`** in [`images/`](images/README.md): no Cloudflare
Access; customers type their e-mail address (Turnstile), get a link by mail, and opening it sets a
signed session cookie for 7 days (`TURNSTILE_SITE_KEY` empty = 503 for everything). It reads
`manifest.json` and the files it names, and binds this bucket, `MAIL` (`ImagesMail` only), a rate limit
and two secrets of its own (`IMAGES_SESSION_KEY`, `IMAGES_TURNSTILE_SECRET`); no Microsoft 365 secret.

### Applications, settings and the controller type

An application is a folder: what the bucket holds under `<APP_ID>/`, a public key, or settings
in `STATE` (`folders/<APP_ID>.json`). Any of the three makes it show on Applications and gives it a
page.

- **New application** (`POST /api/folders`): only settings (customer, controller, who and
  when; for S1 also the distribution URL its first release gets); nothing in the bucket until its
  first release. 409 when the App ID has objects, a public key or settings already. S1 App IDs follow
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
  folder counts as `s1` when its settings say S1 (or when it has a public key and no controller
  set: signing is for S1), and as `linux` when they say M1, L4 or HMI1 (a Linux application can
  hold a public key too, for provisioning).

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
- **The public key stays** (`keys/<APP_ID>.json`): controllers in the field carry it, and a
  folder made again under that App ID is signed with the same key pair.

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
| `keys/<APP_ID>.json` | The public key of an application: `app_id`, `public_key` (130 hex, upper case), `source`, `created_at`, `created_by`. Since 0.7.0 `source` is `attached` and there is nothing else. A key made in the Worker before 0.7.0 (`source` generated / imported) also holds `sealed_private_key` (`v1.<iv>.<ciphertext+tag>`), kept as it is and opened by nothing ([Signing keys](#signing-keys)). Kept when the folder is deleted. |
| `keys-retired/<APP_ID>/<timestamp>.json` | A key that was replaced, with who replaced it when. Never deleted. |
| `folders/<APP_ID>.json` | Folder settings: `customer_id` and `controller` set by hand, `distribution_url` (an S1 application made here, for its first release), `package` (a Linux application's package definition), `created_at` / `created_by`, `updated_at` / `updated_by`. Customer, controller and URL are also in the object's custom metadata (marked `index`), so the overview needs one listing. |
| `log/<yyyy>/<mm>/<timestamp>-<APP_ID>-<version or action>.json` | One entry per publish, sign, key action (`key-attach`, `key-replace` with the previous public key; `key-generate` and `key-import` until 0.6.1), `publish-linux`, `create-folder`, `settings`, `package`, `delete-folder`, `publish-firmware` (App ID `module-<hw_id>`: the file, date, changelog, source, and both manifests as they were before) and `images-*` (App ID `<kind>-<product>`: create, update, upload, abort, remove-file, publish, withdraw, delete): action, App ID, version, actor, time, signed, replaced, payload SHA-256, size, description; a publish also its URL, the previous `latest`, the previous manifest and where a replaced binary went; a delete its reason, objects, bytes, controllers and archive. |
| `replaced/<APP_ID>/<APP_ID>-<version>/<timestamp>.bin` | A binary a publish overwrote. |
| `replaced/<APP_ID>/v<version>/<timestamp>/update.tar.gz`, `…/manifest.json` | A Linux release a publish replaced. |
| `deleted/<APP_ID>/<timestamp>/<original key>` | Every object of a deleted folder, plus its `folder-settings.json` ([Deleting a folder](#deleting-a-folder)). |
| `deleting/<APP_ID>.json` | A delete under way: archive timestamp, actor, reason, progress. Gone when it is done. |
| `downloads/<yyyy-mm-dd>.json` | Download counts of a finished UTC day ([Download counts](#download-counts)). |
| `firmware-log/<hw_id>/<version>.json` | Who published that module firmware from Deploy, when, its SHA-256, and the repository, branch, commit and tag it came from (also in the custom metadata, for the overview's one listing). None for a version the CI published (until 2026-10-29). |
| `images/releases/<kind>/<product>/<version>.json` | A release for images.gocontroll.tech: kind, product, title, version, controllers, release date, notes, files (name, path, size, SHA-256, role, platform, who uploaded it when), `draft`/`published`, who made, changed and published it when. |
| `images/uploads/<id>.json` | An upload to `gocontroll-images` under way: R2 upload ID, object key, size, part size and count, who started it. Gone once completed or aborted. |
| `images/stats/<yyyy-mm>.json` | The downloads of a finished month on images.gocontroll.tech: in all, different addresses (a number), per release, per file, per country. No e-mail address. Kept after the download log expires. |

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

- One ECDSA P-256 key pair per S1 App ID. The private key is the 32-byte scalar, the public key the
  65-byte point `04 || X || Y` as 130 hex characters (`code-signing-local.md`, the formats of
  `GOcontroll-Deployment-Tool/tools/keys.py`).
- **Deploy keeps no private key** (since 0.7.0). The **Key generator** makes the pair in the
  browser (`public/js/signing.js` `generateKeyPair`, WebCrypto) and shows it once: the public key,
  the private key as base64 (the CI pipeline's `FW_PRIVATE_KEY_B64`) and as PKCS#8 PEM, and two
  downloads, `<APP_ID>-signing-key.pem` and `<APP_ID>-signing-key.pub` (the hex and a newline): the
  files `s1_ble.py keygen --out <APP_ID>-signing-key.pem` writes. The colleague stores the private
  key in 1Password (the `.pem` as a document, or the base64 value), or as `private_key` in the
  application's `.cred` file for the Deployment Tool.
- **The public key is kept with the application** (`STATE` `keys/<APP_ID>.json`, `PUT
  /api/folders/:appId/key`): on its page to copy or download as `.pub`, and on Applications next
  to the App ID, for provisioning a controller (Deployment Tool → Configuration). It is attached
  from the key pair window (only once *I have stored the private key* is ticked), from the Key
  generator page afterwards, or on the application's page: a new pair, or a public key there is
  already (pasted, a `.pub` file, `public_key` of `deploy/metadata.json`, or the key the signed
  releases of that application carry). The Worker checks that it is a point on P-256. A Linux
  application can hold one too (for provisioning; nothing Linux is signed).
- **Signing** (`src/release.ts`, `public/js/release.js`): for an application with a public key,
  New release asks for the private key (pasted, or a `.pem`, base64 or `.cred` file, read with
  `readPrivateKey` as `keys.py load_private_key()` reads it). The page checks at once that it belongs
  to the public key (`signerFor`: a signature over random bytes must verify against the public key;
  a key that does not belong is refused with "does not belong to the public key of …" before
  anything is sent). On Publish or *Download signed file instead*, the page asks the Worker for the
  scope (`POST /api/sign/scope`: the signed header's common body + the public key, built by
  `src/goco.ts` `signedScope` from the payload's size, raw size and SHA-256, or from the header of
  an unsigned container), signs scope + payload (`signScope`, raw R || S) and sends the 64-byte
  `signature` with the upload. The Worker builds the scope again from what was uploaded, puts the
  header together (`headerWithSignature`) and refuses it unless the signature verifies against the
  application's public key (422, `signature`), before anything is written. `src/goco.ts` stays the
  only producer of the container; the private key never leaves the browser, and a request that
  carries one is refused unread (400, `privateKey`).
- **Replacing a public key** asks for the App ID as confirmation: controllers that carry the old
  public key refuse firmware signed with the new one. The old key moves to `keys-retired/`, never
  deleted.
- **Deleting a folder keeps its public key**: controllers in the field carry it, and a folder made
  again under that App ID is signed with the same pair.
- **Keys made before 0.7.0.** Until 0.6.1 a key generated or imported here was kept with its private
  key sealed: AES-256-GCM under the key-encryption key **`DEPLOY_SIGNING_KEYS_KEY`** (Secrets Store,
  binding `SIGNING_KEYS_KEY`), AAD `deploy-key:<APP_ID>` (format in `src/keys.ts`). Those objects stay
  as they are, the binding stays, `/api/health` still says whether the KEK is readable
  (`signingKeys`); nothing opens them any more. Their public key is the application's public key,
  and signing for them, too, asks for the private key (the backup shown when the key was made). The
  API says only that a sealed copy exists (`sealedPrivateKey`), never more. Whether to export them
  once (to 1Password) or keep them as a fallback is the owner's decision; until then: do not delete
  them and do not change `DEPLOY_SIGNING_KEYS_KEY` (rotating it needs a re-seal path that does not
  exist). Stand 2026-10-29: one such key, `gocontroll-application` (generated 2026-10-29 06:51 UTC).

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
curl localhost:8787/api/health   # {"ok":true,"version":…,"signingKeys":false,"downloads":false} (signingKeys: the KEK of the keys sealed before 0.7.0 is readable)
npm test                         # vitest in the Workers runtime; Cloudflare's API mocked
npm run typecheck                # strict TS for the Worker, JSDoc-checked JS for public/js
npm run fixtures:goco            # only when the container format changes (needs Python + cryptography)
npm run fixtures:linux           # only when upload-r2.py changes (the skill next to GOcontroll-Team)
npm run fixtures:tar             # only when build-package.py or public/js/package.js changes
npm run fixtures:firmware        # publish_firmware.py is retired: only with the script back from Module-4-20mA's history (Module firmware)
npm run fixtures:git             # only when public/js/git.js needs other repository shapes (needs git)
npm run test:images              # the tests of images.gocontroll.tech (part of npm test)
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
`publicKey`, `signature`, `privateKey` (a private key sent: refused unread), `distributionUrl`, `confirm`,
`customerId`, `controller`, `reason`, `acknowledgeControllers`, `days`) with
400/403/404/409/410/413/415/422/500/503.

| Method | Path | |
|---|---|---|
| GET | `/api/me` | Signed-in colleague: email, name, groups (object IDs and names, to look an ID up) |
| GET | `/api/health` | `{ ok, version, signingKeys, downloads }`: whether the KEK and the API token are readable |
| GET | `/api/overview` | Every folder (kind s1/linux/unknown, `controller` + `controllerSource`, latest, releases, bytes, last upload, distribution URL, `hasKey` and `publicKey`, `inBucket`, customer, controllers), the customers with their folders, totals, `distributionUrls`, download totals of 7 and 30 days |
| GET | `/api/folders/:appId` | One folder: kind, controller, customer, `key` (as `GET …/key`); releases with their stored header (range read), `keyMatches`, `digestMatches`, size, upload time and downloads; Linux versions; objects the manifest does not name; `objects: { count, bytes }`; `deleting` (an unfinished delete, or null); for a Linux application `package`, `packageSource`, and `latestVersionManifest` (the parsed version manifest of the latest release) or `latestVersionManifestError`; controllers per version and per distribution URL; downloads per day. 404 when nothing exists for it |
| POST | `/api/folders` | `{ appId, customerId, controller: "S1" \| "M1" \| "L4" \| "HMI1", distributionUrl }` (no `distributionUrl` for Linux) → 201 `{ appId }`: a new application (settings only). 409 when it exists |
| PUT | `/api/folders/:appId/package` | A Linux application's package definition `{ owner?, group?, files: [ { name, destination, mode, owner?, group? } ], post_install?: { mode: "none" } \| { mode: "services", services } \| { mode: "script", script } }` → `{ package, packageSource: "manual" }` |
| POST | `/api/linux-releases` | multipart `appId`, `version`, `description`, `replace`, `tarball` (gzip, ≤ 100 MB), `manifest` (the version manifest, text or file) → `{ tarballKey, manifestKey, rootManifestKey, version, released, sha256, sizeBytes, previousLatest, latestVersion, replaced }` |
| GET | `/api/folders/:appId/versions/:version/tarball` | The stored package of a Linux release (`application/gzip`, `private, no-store`) |
| PUT | `/api/folders/:appId/settings` | `{ customerId?: number \| null, controller?: "S1" \| "M1" \| "L4" \| "HMI1" \| null }` (absent: unchanged, null: derived) → `{ customer, controller, controllerSource }` |
| PUT | `/api/folders/:appId/customer` | `{ customerId: number \| null }` → `{ customer }` (the milestone-1 call; same as settings with the customer only) |
| DELETE | `/api/folders/:appId` | `{ confirm, reason, acknowledgeControllers }` → `{ done, deleted, remaining, archive }`; repeat until `done` ([Deleting a folder](#deleting-a-folder)) |
| GET | `/api/customers` | `[ { id, name } ]` from gocontroll-business, for the picker |
| GET | `/api/folders/:appId/key` | `{ publicKey, source: "attached" \| "generated" \| "imported", createdAt, createdBy, sealedPrivateKey }` (`sealedPrivateKey`: a key of before 0.7.0 whose private key Deploy holds sealed; never the sealed value), or 404 |
| PUT | `/api/folders/:appId/key` | `{ publicKey }` (130 hex, a point on P-256), with `{ replace: true, confirm: "<APP_ID>" }` when there is one (else 409; the same key: 422) → the key as `GET`. An existing folder (S1 or Linux), or a new S1 App ID. A body with `privateKey`: 400, nothing stored |
| POST | `/api/folders/:appId/key` | 410: generating and importing in the Worker ended with 0.7.0 (the body is not read) |
| POST | `/api/sign/scope` | `{ appId, version, payload: { size, rawSize, sha256 } }` or `{ appId, version, containerHeader }` (base64 of the first ≤ 211 bytes of an unsigned container) → `{ appId, version, publicKey, scope, payloadOffset }`: the bytes to sign (base64), followed by the payload from `payloadOffset`. 422 without a public key, for a Linux application, for a container of another App ID or version, or one signed already |
| POST | `/api/sign` | multipart `appId`, `version`, `signature` (base64, 64 bytes), and `payload` (zlib) + `rawSize`, or `container` → the signed container as a download `<APP_ID>-<version>.bin`; nothing goes into the bucket. A container signed with the application's key already needs no signature (it comes back as it is) |
| POST | `/api/releases` | multipart `appId`, `version`, `description`, `replace`, `distributionUrl` (new folder only), `signature` (an application with a public key), and `payload` + `rawSize` or `container` → `{ binaryKey, binaryUrl, manifestKey, version, releaseDate, previousLatest, replaced, latestMovedBack, signed }` |
| GET | `/api/firmware` | `{ github: { configured, repos }, updated, modules: [ { id, name, hardwareVersion, latest, releases: [ { version, file, date, sha256, changelog, publishedBy: { email, at, source } \| null } ], error? } ], manifestError?, firmwareUrl, moduleTypeNames }` |
| GET | `/api/firmware/github?repo=owner/name[&commit=<sha>&branch=<name>]` | `{ configured, allowed, readable, canPush, error, sync, syncError }`: whether Deploy can tag and release there (one read on GitHub; the page shows it next to the repository). With `commit` (HEAD of the chosen clone; `branch` omitted = the default branch) also `sync` = `{ branch, head: { sha, date, subject } \| null, state: "up-to-date" \| "github-newer" \| "local-newer" \| "diverged" \| "not-on-github" \| "no-branch", githubNewer, localNewer }` (two more reads at most: the branch, then the comparison), or `syncError` with the reason; 400 for a commit that is not a full id |
| POST | `/api/firmware/releases` | `{ repo: "GOcontroll/Module-…", commit, version, files: [ { file, path } ], replaceTag? }` → `{ repo, tag, tagState: "created" \| "kept" \| "replaced", tagUrl, releaseUrl, releaseState, assets, safetyNet }`; 409 `field: "files" \| "commit" \| "version"`, or `conflict: "tag"` with `existingMessage`/`existingCommit`; 403 repository not in `GITHUB_REPOS`; 503 without a token ([GitHub releases](#github-releases)) |
| POST | `/api/firmware` | multipart `file` (`<a>-<b>-<c>-<d>-<x>-<y>-<z>.srec`, LF, ≤ 4 MB), `released` (YYYY-MM-DD), `changelog` (≤ 2000), `module_name` (a new hardware ID), `replace` (`true`: write the entry of a published version again, same file), `dry_run` (`true`: write nothing), `source` (JSON `{ repo, branch, commit, tag, path, pushed }`) → `{ dryRun, hwId, version, file, url, sha256, date, changelog, moduleName, latest, latestBefore, objectWritten, replacedRelease, newModule, moduleManifest }`; 409 with `conflict: "release"` (published; *replace*) or `"file"` (other bytes: never) |
| GET | `/api/images` | `{ releases: [ … + inCatalogue ], uploads, downloads: [ { at, email, path, kind, product, version, country } ], stats: { month, months: [ { month, downloads, addresses, releases, files, countries, final } ], releases: [ { release, total, thisMonth, lastMonth } ], total, error? }, catalogueError?, publicUrl, limits: { partSize, maxFileSize } }` |
| POST | `/api/images/releases` | `{ kind: "image" \| "tool", product, version, title, controllers: ["L4", "M1", "HMI1"], released, notes }` → 201, the draft; 409 when it exists |
| PATCH | `/api/images/releases/:kind/:product/:version` | `{ title, controllers, released, notes }` → the release (a published one is updated in `manifest.json` too) |
| DELETE | `/api/images/releases/:kind/:product/:version` | A draft, with its files and unfinished uploads |
| POST | `/api/images/releases/:kind/:product/:version/publish` · `/withdraw` | Into / out of `manifest.json` |
| POST | `/api/images/releases/:kind/:product/:version/files` | `{ name, size, role, platform }` → 201 `{ id, partSize, parts }` (a draft only) |
| DELETE | `/api/images/releases/:kind/:product/:version/files/:name` | A file of a draft, from the bucket too |
| PUT | `/api/images/uploads/:id/parts/:n` | `application/octet-stream`, exactly the part's size, same origin → `{ partNumber, etag }` |
| POST | `/api/images/uploads/:id/complete` | `{ parts: [ { partNumber, etag } ] }` → the file `{ name, path, size, sha256, role, platform, uploaded_at, uploaded_by }` |
| DELETE | `/api/images/uploads/:id` | Abort an upload |
| GET | `/api/downloads?appId=&days=30` | `{ configured, days: [ { day, downloads, headerReads, manifestReads } ] }`, every day of the window (1–90; a day without counts has `null`s and `unavailable` or `pending`); without `appId` every folder |

## Deployment

### Hostnames, bindings and secrets

| What | Name |
|---|---|
| Worker | `gocontroll-deploy-intranet` |
| Hostname | `deploy.gocontroll.tools` (custom domain, the only route; `workers_dev` and preview URLs off) |
| R2 (read + write) | `DEPLOY_BUCKET` → `gocontroll-deploy`, public as `deploy.gocontroll.com` and `deploy.gocontroll.tech` |
| R2 (private) | `STATE` → `gocontroll-deploy-state` (created 2026-10-21) |
| R2 (read + write) | `FIRMWARE_BUCKET` → `gocontroll-firmware` (module firmware; `brcm/` is never touched), public as `firmware.gocontroll.tech` and `firmware.gocontroll.com` |
| R2 (read + write) | `IMAGES_BUCKET` → `gocontroll-images` (created 2026-10-28; no public access, no custom domain: only the Worker `gocontroll-images` serves it) |
| D1 (read only) | `BUSINESS_DB` → `gocontroll-business`, `MODULINE_DB` → `gocontroll-db` |
| Secrets Store | `SIGNING_KEYS_KEY` → `DEPLOY_SIGNING_KEYS_KEY` (exists; the KEK of the private keys sealed before 0.7.0, which stay; nothing opens them now); `GITHUB_TOKEN` → `DEPLOY_GITHUB_TOKEN` (exists since 2026-10-28; the owner set the token, [GitHub releases](#github-releases)); `MS365_CLIENT_SECRET` → `MS365_CLIENT_SECRET` (since 0.6.0; shared with Hours, the Configurator and Finance); `CF_API_TOKEN` → `DEPLOY_CF_API_TOKEN` (to be made, [Download counts](#download-counts)) |
| Vars | `TEAM_DOMAIN`, `POLICY_AUD`, `DEPLOY_GROUPS`, `DISTRIBUTION_URLS`, `DOWNLOAD_HOSTS`, `FIRMWARE_URLS`, `IMAGES_URL`, `GITHUB_REPOS`, `MAIL_FROM`, `MS365_TENANT_ID`, `MS365_CLIENT_ID`, `IMAGES_MAIL_REPLY_TO` |
| RPC entrypoint | `ImagesMail` (`src/images-mail.ts`), bound by `gocontroll-images` as `MAIL`: deploy this Worker before the download site |
| Second Worker | `gocontroll-images` on `images.gocontroll.tech` ([`images/`](images/README.md), `npm run deploy:images`) |
| Cron | `17 2 * * *`: stores the download counts of finished days ([Download counts](#download-counts)) and the image download counts of finished months |

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
   one policy: **Bypass**, include **Everyone** (brand assets only). Access redirects plain HTTP
   only on the paths it protects: for `/pub/` the Worker does it (every path, 301/308), and it
   gives the `/pub/` files the same security headers as everything else (since 2026-10-23).
   Signing out ends on the hub's `https://gocontroll.tools/pub/signed-out`. Done 2026-10-21: AUD `d26a80ee…cab10`,
   bypass on `/pub` in place.
3. **Tile on the hub** (`GOcontroll-Team/src/cards.js`), link `https://deploy.gocontroll.tools`,
   shown to the object ID of `CF_Deploy` (since 2026-10-21). Hiding a tile is not access
   control: the Access application and `DEPLOY_GROUPS` are.
4. Optionally the API token for [download counts](#download-counts).
5. **images.gocontroll.tech** (2026-10-28): the bucket `gocontroll-images`, its lifecycle rules and the
   store secrets `IMAGES_SESSION_KEY` and `IMAGES_TURNSTILE_SECRET` (made by the session), then the
   owner's Turnstile widget, in the order of [`images/README.md`](images/README.md) → *One-time setup*.
   No Access application and no one-time PIN (the plan until 0.6.0).

### Worker

`npm run deploy`. It first runs `predeploy`: the typecheck and the tests. There is no
migration check: Deploy has no D1 of its own. Its cron (`17 2 * * *`) stores the download
counts of finished days. First deploy 2026-10-21: version
`211d969d-5468-45eb-b102-57746d737af5` (without the cron). Verify:

```sh
curl -sI https://deploy.gocontroll.tools/              # 302 to gocontroll.cloudflareaccess.com
curl -sI http://deploy.gocontroll.tools/pub/logo.svg   # 301, location: https://deploy.gocontroll.tools/pub/logo.svg
curl -sI https://deploy.gocontroll.tools/pub/logo.svg  # 200 with content-security-policy, strict-transport-security,
                                                       # x-frame-options, x-content-type-options, referrer-policy
```

### Rolling back

- **Code**: `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`.
  0.3.1 (HTTPS redirect and security headers on `/pub/`, 2026-10-23; no data or binding
  changed): back to 0.3.0 with `npx wrangler rollback 961ad1da-be9c-47f0-b196-f26f035a16bf`, which
  serves `/pub/` over plain HTTP and without the headers again. Browsers that saw the HSTS header
  keep using `https://` for this hostname for a year either way; that needs no rollback.
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
- **0.7.0** (tabs Applications, Firmware, Images, Key generator; key pairs in the browser, only the public key in Deploy;
  signing in the browser, the signature checked here; 2026-10-29; no binding changed, no existing object changed):
  back to 0.6.1 with `npx wrangler rollback ebd51294-6086-4a8e-8587-a702b9a945b6`. Public keys attached with 0.7.0
  (`keys/<APP_ID>.json` with `source: "attached"`, no `sealed_private_key`) then show in 0.6.1, but 0.6.1 cannot sign with them
  (it answers 503 for that folder: the sealed key is missing); remove such a key (copy it to `keys-retired/` first) or roll
  forward again. Releases signed with 0.7.0 stay valid: the container format did not change. The keys of before 0.7.0 were not
  touched, so 0.6.1 signs with them again.
- **0.6.1** (the Firmware tab compares HEAD with its branch on GitHub, 2026-10-29; no data or binding changed):
  back to 0.6.0 with `npx wrangler rollback 86d281d3-446d-4fd5-a2e0-ac7199b6a11e` (the page then says again
  only whether HEAD is on `origin/<branch>` as of the last fetch). images.gocontroll.tech is not touched.
- **0.6.0** (the sign-in mail `ImagesMail`, binding `MS365_CLIENT_SECRET`, download counts per month in
  `STATE` `images/stats/`, *Copy link*; 2026-10-28): roll **images.gocontroll.tech back first**
  (`npx wrangler rollback 9a2c1639-79b6-4057-9c8e-b5b98b4483cd -c images/wrangler.toml`, the Access
  version: 503 without an Access application; its download site binds `ImagesMail`, which 0.5.1 does not
  have), then this Worker with `npx wrangler rollback e582f30e-2524-4ea3-9859-92736792a705` (0.5.1).
  `images/stats/` stays and is ignored by 0.5.1.
- **0.5.0** (tags and GitHub releases from the Firmware tab, binding `GITHUB_TOKEN`, 2026-10-28): back to
  0.4.1 with `npx wrangler rollback acbf96ba-4f0f-4689-b06d-74f4f4059b20`; without a deploy: `DEPLOY_GITHUB_TOKEN`
  back to `not-set`. Tags and releases already made stay on GitHub (delete them there if needed).
- **0.4.1** (the Firmware tab by agent 08's rules, 2026-10-28; no data or binding changed): back to 0.4.0 with
  `npx wrangler rollback 4876a23e-944b-4f73-b497-d978d321036b` (which allows replacing an `.srec` again and publishes
  the work tree's copy: avoid).
- **0.4.0** (Firmware and Images tabs, bindings `FIRMWARE_BUCKET` and `IMAGES_BUCKET`, 2026-10-28; no
  data changed): back to 0.3.1 with `npx wrangler rollback 8ccd2c42-fe88-459b-8b10-d2b37238797d`.
  The buckets and their contents stay; images.gocontroll.tech keeps serving what is published.
- **A module firmware publish**: its `publish-firmware` log entry holds `previous_module_manifest` and
  `previous_master_manifest`; write them back (module manifest first, then `modules/manifest.json`)
  with `npx wrangler r2 object put gocontroll-firmware/<key> --remote --file=<file> --content-type application/json`
  (`null` = there was none: delete the object instead). Leave a new `.srec` in place: without a
  manifest entry nobody downloads it. A pushed tag starts nothing (no module repository has the
  publish workflow since 2026-10-29); delete the tag and the release on GitHub too if the version
  should not stay there (`git push origin --delete v<version>`).
- **An image release**: *Withdraw* takes it off images.gocontroll.tech at once; the files stay until the
  draft is deleted.
- **A public key**: the replaced one is in `keys-retired/<APP_ID>/`; copying it back to
  `keys/<APP_ID>.json` makes it active again (a key of before 0.7.0 keeps its sealed part, for that App ID).
- **A deleted folder**: put it back from `deleted/…`, the manifest last
  ([Restoring a deleted folder](#deleting-a-folder)).
- **Removing the app**: delete the Worker (`npx wrangler delete gocontroll-deploy-intranet`)
  and the hub tile. The distribution bucket is not this app's and stays as it is; keep the
  state bucket (the public keys, the sealed keys of before 0.7.0, the log).

## Relation to the Deployment Tool, the CI pipeline and the specs

Module firmware follows `GOcontroll-Architecture/cloudflare/firmware/spec.md`; Deploy is its only
producer since the CI of the module repositories (`publish_firmware.py`, skill
`module-firmware-deployment`) was removed on 2026-10-29, its consumers go-modules (`check`/`update`), the Modules page of go-web-ui and the iOS app. Images and tools
follow `GOcontroll-Architecture/cloudflare/images/spec.md`; Deploy is their only producer, the Worker
`gocontroll-images` (this repo, `images/`) their only reader.

Linux applications follow `GOcontroll-Architecture/cloudflare/linux-application/spec.md`; their
other producer is the CI pipeline of the skill `r2-application-deploy-setup` (Deploy writes what
its `upload-r2.py` writes), their consumers the Moduline dashboard (which sends the update with
the root manifest's SHA-256 and the version manifest's `files[]`) and go-deploy on the
controller.

The **Deployment Tool** (`GOcontroll-Deployment-Tool`) programs and provisions S1 controllers
over Bluetooth and publishes from a laptop with a `.cred` file; Deploy publishes to the same
bucket in the same format from the browser, signed there with the same private key (the
colleague's: from the `.cred` file, a `.pem` or 1Password; Deploy keeps only the public key). The
Key generator's downloads are the files of `s1_ble.py keygen`. Both
follow the S1 knowledge base (`cloud-r2-distribution.md`, `code-signing-local.md`,
`deployment-tool.md`); when a format changes there, both follow. Provisioning a controller's
App ID, distribution URL and public key stays the Deployment Tool's job; moving an App ID from
`deploy.gocontroll.com` to `deploy.gocontroll.tech` follows `cloud-r2-distribution.md` §2.1
(Deploy shows `mixedHosts` and the controllers' distribution URLs per folder, and never mixes
hosts when it writes).
