# GOcontroll-Deploy — architectuur en werkregels

## Stand
- Live op `deploy.gocontroll.tools` sinds 2026-10-21 (eerste versie `211d969d-5468-45eb-b102-57746d737af5`). Access-app
  met `/pub`-bypass bestaat; de AUD staat in `POLICY_AUD`. `DEPLOY_GROUPS` en de hubtegel staan op het object-ID van
  `CF_Deploy` (`b5877d29-e509-40b2-9784-17e649996f1f`). Downloadtellingen wachten op `DEPLOY_CF_API_TOKEN`.
- **0.4.0 (2026-10-28, versie `4876a23e-944b-4f73-b497-d978d321036b`; `gocontroll-images` versie
  `9a2c1639-79b6-4057-9c8e-b5b98b4483cd`)**: tabs *Firmware* (module-firmware naar `firmware.gocontroll.tech`, bucket `gocontroll-firmware`)
  en *Images* (images en tools voor klanten, bucket `gocontroll-images`), plus de tweede Worker `gocontroll-images` op
  `images.gocontroll.tech` (map `images/`). Die geeft 503 tot de eigenaar de Access-app met one-time PIN heeft gemaakt
  en de AUD in `images/wrangler.toml` staat (`images/README.md` → *One-time setup*). Terug naar 0.3.1:
  `npx wrangler rollback 8ccd2c42-fe88-459b-8b10-d2b37238797d` (de buckets en hun inhoud blijven).

## Architectuur
- **Worker met static assets** (geen Pages), zelfde opzet als GOcontroll-Logistic: `run_worker_first = true`,
  `workers_dev = false`, `preview_urls = false`, custom domain `deploy.gocontroll.tools`. Worker-naam
  **`gocontroll-deploy-intranet`**, nooit `gocontroll-deploy`: dat is de publieke device-Worker van de Deployment Tool op
  `deploy.gocontroll.tech` (zelfde bucket).
- **Vóór alles** plain HTTP → HTTPS op elk pad (301 GET/HEAD, 308 anders, zelfde pad + query; `src/lib/https.ts`,
  kopie van die van GOcontroll-Configurator, houd ze in de pas; `localhost` nooit): Access doet dat alleen op de
  beschermde paden, niet op de `/pub`-bypass. `/pub/*`, pagina's, assets, API-antwoorden (ook weigeringen en fouten) en
  de redirect krijgen `SECURITY_HEADERS` (`src/lib/headers.ts`: CSP, nosniff, Referrer-Policy, `X-Frame-Options: DENY`,
  HSTS `max-age=31536000` zonder `includeSubDomains`); niet de 403 van de tokencheck (inline styles). Sinds 23-10
  (0.3.1), F4 van het externe securityonderzoek
  (`GOcontroll-Team/docs/security/external-security-assessment-configurator-2026-10-23.md`). Geen named exports van
  constanten in `src/index.ts` (workerd weigert ze): headers en redirect staan daarom in `src/lib/`.
- **Server**: TypeScript + Hono + zod (`src/`). **Browser**: plain ES-modules in `public/js/` met `// @ts-check` + JSDoc,
  geen framework, geen bundler. CSP verbiedt inline scripts én inline `style`-attributen.
- **Toegang**: Access-policy op Entra-groep `CF_Deploy` én in de Worker `DEPLOY_GROUPS`, **alleen op object-ID**
  (`extractGroupIds`), nooit op groepsnaam: `DEPLOY_GROUPS = "b5877d29-e509-40b2-9784-17e649996f1f"` (CF_Deploy).
  Lege config of mislukte groepsopvraging = niemand (fail closed). `src/access.ts` is identiek aan de kopie
  in Logistic — houd ze in de pas.
- **Kleine uploads, weinig Worker-CPU**: de browser leest `.srec`/`.bin` en comprimeert (`CompressionStream('deflate')`
  = zlib). De Worker inflate nooit, doet geen JS-lussen over de payload: SHA-256 en ECDSA via `crypto.subtle`, CRC alleen
  over de header, header + payload als één body naar R2, header van een opgeslagen binary via range-read (211 bytes).
  Het overzicht lijst de bucket één keer (niet per map). Uploads zijn multipart en vereisen een same-origin `Origin`.

## Formaten (niet onderhandelbaar)
- **`src/goco.ts` is de enige producent en lezer van GOCO** in deze repo: port van
  `GOcontroll-Deployment-Tool/tools/goco.py`; sleutelformaten (`src/keys.ts`) van `keys.py`; publiceren
  (`src/release.ts`, `src/bucket.ts`) volgt `r2.py publish()`. Normatief is de S1-kennisbank
  (`cloud-r2-distribution.md` §2/§2.1/§3/§4, `code-signing-local.md`); tabellen daaruit niet kopiëren, verwijzen.
- Verandert het formaat daar: `src/goco.ts` volgt, en `npm run fixtures:goco` maakt `test/fixtures/goco/fixtures.json`
  opnieuw met Python (`python -I`, de Deployment Tool ernaast). Die fixtures zijn de kruiscontrole met Python
  (unsigned byte-gelijk, Python-signed verifieert hier, TS-signed is door Python geverifieerd); niet met de hand wijzigen.
- `src/goco.ts` en `src/keys.ts` hebben **geen imports** en alleen erasable TypeScript: het fixture-script draait ze onder Node.
- S1 publiceren: binary eerst, dan manifest (etag-conditioneel, 409 bij race); onbekende manifestvelden blijven;
  `?v=` = eerste 16 hex van de payload-SHA-256; een bestaande map houdt de host die zijn manifest noemt (nooit twee
  hosts, §2.1); een Linux-map (`versions[]` of settings M1/L4/HMI1) = 422 (die neemt Linux-releases); map met sleutel =
  alleen gesigneerd met die sleutel.
- **Alleen de beveiligde map-delete** (`DELETE /api/folders/:appId`, `src/delete.ts`) verwijdert objecten uit
  `gocontroll-deploy`, en altijd na archiveren naar `STATE` `deleted/<APP_ID>/<ts>/<key>` (grootte gecontroleerd).
  Manifest eerst en alleen, dan de rest; max. 200 per call, hervatbaar via `deleting/<APP_ID>.json`; vereist exacte
  App ID, reden ≥ 10 tekens en bevestiging als er nog controllers op die App ID staan. **De sleutel blijft.**
  Publiceren verwijdert nooit: een overschreven binary gaat eerst naar `replaced/…`, het manifest van vóór een
  publish staat in de logregel (`previous_manifest`). Terugzetten: README → *Deleting a folder* (manifest als laatste).

## Module-firmware (`src/firmware.ts`, tab Firmware)
- Contract `GOcontroll-Architecture/cloudflare/firmware/spec.md` (≥ 1.2.0). Deploy is **tweede producent** naast de CI van
  de `Module-*`-repos (`.github/scripts/publish_firmware.py`, skill `module-firmware-deployment`) en schrijft wat dat script
  schrijft, in die volgorde: `modules/<hw_id>/<file>.srec`, `modules/<hw_id>/manifest.json`, `modules/manifest.json`
  (`JSON.stringify(…, 2)` zonder newline = `json.dumps(indent=2, ensure_ascii=False)`). `npm run fixtures:firmware` draait
  het echte script (boto3 gestubd, `python -I`); `test/firmware.test.ts` eist dezelfde bytes (op `updated` na). Fixtures
  niet met de hand wijzigen.
- Bewust anders dan het script: `releases` **aflopend op versie** (go-modules flasht `releases[0]`), `latest_firmware` = de
  hoogste; bestaande versie of andere bytes onder dezelfde naam = 409 tenzij `replace` (oud `.srec` eerst naar `STATE`
  `firmware-replaced/…`); manifests etag-conditioneel met retry; **alleen LF** (browser zet CRLF om, Worker weigert CR):
  een Windows-checkout met `core.autocrlf` heeft CRLF, git en de CI LF, dus anders klopt de SHA-256 niet met de CI.
- Bestandsnaam = alles: `20-10-1-6-2-0-3.srec` → `20100106`, `2.0.3`, HW `1.06` (`parseSrecName`, in `src/` én
  `public/js/release-helpers.js`, `test/pages.test.ts` houdt ze gelijk). Naam van een nieuwe hardware-ID: andere HW-versie van
  hetzelfde type → `MODULE_TYPE_NAMES` → door de collega ingetypt. Nooit iets onder `brcm/`.
- Releasedatum = datum van het `.srec`-bestand (`lastModified`), als `DD/MM/YY` in het manifest. Changelog voorgesteld door
  **`public/js/git.js`** (git lezen in de browser, alleen lezen: loose + packs met OFS/REF-delta, `packed-refs`,
  geannoteerde tags; geen SHA-256-repos, reftable, worktrees/submodules): annotatie van tag `v<versie>` zonder
  `RELEASE_DATE:`/`DEPLOY_FILES:`, anders de commits sinds de vorige versietag (max. 50). Fixture `test/fixtures/git/`
  komt van `npm run fixtures:git` (git CLI); niet met de hand wijzigen.
- Log: `publish-firmware` met `previous_module_manifest` en `previous_master_manifest` (terugzetten = die terugschrijven);
  `firmware-log/<hw_id>/<versie>.json` (+ custom metadata) = wie publiceerde uit welke repo/commit; zonder = de CI.

## Images voor klanten (`src/images.ts`, tab Images, `images/`)
- Formaat en bucketindeling: **`src/images-format.ts`** (geen imports; door beide Workers gebundeld). Contract
  `GOcontroll-Architecture/cloudflare/images/spec.md`. Deploy is de **enige schrijver** van releases en `manifest.json`;
  `images.gocontroll.tech` (Worker `gocontroll-images`, `images/`) is de enige lezer en schrijft alleen `downloads/`.
- Release = concept in `STATE` `images/releases/<kind>/<product>/<versie>.json`; bestanden staan al in de bucket, maar de
  download-Worker serveert alleen wat `manifest.json` noemt. Publiceren/terugtrekken = `manifest.json` etag-conditioneel
  herschrijven. In `manifest.json` nooit e-mailadressen of concepten (`catalogueEntry`). Alleen een concept verliest
  bestanden of wordt verwijderd (geen archief: images worden opnieuw gebouwd).
- Upload: R2-multipart, delen van precies `PART_SIZE` (32 MiB, laatste de rest), ruwe bytes via
  `PUT /api/images/uploads/<id>/parts/<n>` (`application/octet-stream`, same-origin, gestreamd naar R2; `src/index.ts`
  `PART_PATH`), daarna `complete`: grootte gecontroleerd en SHA-256 uit het opgeslagen object (`crypto.DigestStream`).
- Downloadlog: lege objecten `downloads/<yyyy>/<mm>/<iso>-<rand>.json` met custom metadata (`DownloadMeta`); Deploy leest
  alleen de listing van deze en vorige maand.
- `images/` heeft eigen `wrangler.toml`, tests (`npm run test:images`, deel van `npm test`) en deploy
  (`npm run deploy:images`). Bindt **alleen** `IMAGES_BUCKET`; JWT-check met `IMAGES_AUD` (leeg = 503 op alles), geen
  groepscheck (one-time PIN: elk geverifieerd e-mailadres). Access-app, one-time PIN en WAF-challenge zet de eigenaar in het
  dashboard (de wrangler-login heeft geen Access- of WAF-rechten).

## Applicaties
- Een applicatie = map: objecten onder `<APP_ID>/`, een sleutel, of settings (`folders/<APP_ID>.json`). Elk van de
  drie laat hem zien op Status en geeft hem een pagina.
- *New application* (`POST /api/folders`) maakt alleen settings (customer, controller, wie/wanneer); 409 als de App ID
  al bestaat. S1: met distributiehost (de eerste release neemt die). M1/L4/HMI1: Linux-App-ID
  (`^[a-z0-9][a-z0-9._-]*$`, max. 64, zoals `config.schema.json`), geen host; zo'n map is `kind: "linux"`.
- Controllertype: handmatig (`S1`/`M1`/`L4`/`HMI1`) → S1-manifest = `S1` → meest voorkomende
  `controller_series.controller_type` (zonder `Moduline `) van de controllers op die App ID; bij een Linux-manifest de
  S1-controllers niet meetellen (`gocontroll-application` heeft er één L4 en één S1) → `null`. `kind` blijft voor de
  logica (wat het manifest is).
- Settings-index staat in de custom metadata van `folders/*.json` (`index`); zonder die markering leest Deploy het object.

## Linux-applicaties (M1, L4, HMI1)
- Contract: `GOcontroll-Architecture/cloudflare/linux-application/spec.md`. Deploy is een **tweede producent** naast de
  CI van de skill `r2-application-deploy-setup` en schrijft wat `upload-r2.py` schrijft: `v<versie>/update.tar.gz`
  (`application/gzip`), `v<versie>/manifest.json` (zoals verstuurd), dan het root-manifest. Root-manifest exact als
  `upload-r2.py` (`src/godeploy.ts`): entry vervangen, sorteren op `semver_key` (release > pre-release), `latest_version`
  = de **hoogste** versie, onbekende velden blijven, `json.dumps(indent=2)` + `\n` met ASCII-escapes. Kruiscontrole:
  `npm run fixtures:linux` draait de echte `upload()` (boto3 gestubd, `python -I`); fixtures niet met de hand wijzigen.
- Packagedefinitie in `folders/<APP_ID>.json` `package` (`PUT …/package`): bestanden (naam in `files/`, absolute
  bestemming, octale mode, owner/group), post-install none/services (exact `post-install.sh.tmpl`)/script. De browser
  bouwt tarball + versiemanifest; de Worker controleert het versiemanifest, berekent SHA-256 (gestreamd) en grootte, en
  pakt **niet** uit (de per-file-SHA-256 komen van browser/CI; go-deploy controleert ze).
- Bestaande versie zonder replace = 409; replace archiveert eerst naar `replaced/<APP_ID>/v<versie>/<ts>/`. Root-manifest
  etag-conditioneel. S1 en Linux mengen nooit (422 beide kanten op). **Geen handtekening** (go-deploy kent er geen);
  de Keys-pagina blijft S1. Downloads van controllers lopen via de signed route van Moduline, niet via Deploy.
- Max. 100 MB per package (Cloudflare-edge ~100 MB per request; de Worker houdt het package één keer in geheugen).

## Sleutels
- Eén P-256-sleutel per App ID in `STATE` `keys/<APP_ID>.json`, privédeel verzegeld met AES-256-GCM onder
  `DEPLOY_SIGNING_KEYS_KEY` (Secrets Store, binding `SIGNING_KEYS_KEY`), AAD `deploy-key:<APP_ID>`. Vervangen →
  oude naar `keys-retired/`, nooit weg. De privésleutel verlaat de Worker alleen als back-up direct na *generate*.
- KEK kwijt = alle sleutels kwijt. **KEK roteren alleen met een her-verzegelpad** (oud en nieuw lezen, nieuw schrijven,
  bewijzen dat alles opent, dan pas de oude weg) — dat pad bestaat nog niet, dus niet roteren.
- Een onleesbare store of een sleutel die niet opent = 503, nooit "geen sleutel" (dat zou vervanging uitlokken).

## Opslag en databases
- **Geen eigen D1** (bij het bouwen op 21-10 zat het account aan de Free-plan-D1-limiet; R2 volstaat voor deze data,
  dus het blijft zo): app-state is JSON in R2 **`gocontroll-deploy-state`**
  (`STATE`, privé): `keys/`, `keys-retired/`, `folders/`, `log/`, `replaced/`, `deleted/`, `deleting/`, `downloads/`,
  `firmware-log/`, `firmware-replaced/`, `images/releases/`, `images/uploads/` (zie README → *Data*).
- **`gocontroll-firmware`** (`FIRMWARE_BUCKET`, publiek via `firmware.gocontroll.tech`/`.com`) en **`gocontroll-images`**
  (`IMAGES_BUCKET`, privé; alleen via `images.gocontroll.tech`): lezen en schrijven, zie de secties hierboven.
- **`gocontroll-business`** (eigenaar Hours) en **`gocontroll-db`** (eigenaar GOcontroll-Database): **alleen lezen**,
  `migrations_dir = "no-migrations-here"`. Uit `gocontroll-db` alleen `controllers` (client_id, project_id, app_id,
  app_version, app_uptodate, distribution_url, online, last_online, controller_series_id, `COUNT(*)`),
  `controller_series` (id, controller_type) en `project_provisioning`; nooit `controller_tunnels`, `app_settings` of een
  geheim. Queries gebruiken aliassen (`c.`, `s.`, `p.`); `test/readonly-db.test.ts` controleert elke tabel en kolom.
- `test/fixtures/business` en `test/fixtures/moduline` zijn vastgezette kopieën, alleen voor test- en lokale databases.

## Downloads
- Cloudflare GraphQL Analytics, alleen met de binding `CF_API_TOKEN` (store `DEPLOY_CF_API_TOKEN`: Zone Analytics Read +
  Zone Read op `gocontroll.com` en `gocontroll.tech`). **Staat nog niet in `wrangler.toml`**: een binding naar een
  ontbrekend secret breekt de deploy. Eerst maakt de gebruiker het secret, dan de binding (README → *Download counts*).
- Afgeronde dagen gaan naar `downloads/<dag>.json`: dagelijks via de cron (`17 2 * * *`, `scheduled()` →
  `collectMissingDays`) én bij het bekijken, max. 7 per run of request; vandaag altijd live. Zonder `CF_API_TOKEN` doet
  de cron niets. Tests mocken Cloudflare altijd.

## Werkregels
- UI-teksten en API-foutmeldingen Engels (Brits), datums `en-GB`. Code en commentaar Engels; deze werkregels Nederlands.
- Huisstijl: `GOcontroll-Architecture/styling/README.md`; mobile-first, touch targets ≥ 44px, 360px breed zonder
  horizontaal scrollen.
- Functionaliteit, README, dit bestand en de tests veranderen in dezelfde commit.
- `npm test` en `npm run typecheck` groen vóór commit en deploy (`predeploy` draait ze; er is geen migratiecheck, want
  geen eigen D1).
- Na deploy: `curl -sI https://deploy.gocontroll.tools/` → 302 naar `gocontroll.cloudflareaccess.com`;
  `curl -sI http://deploy.gocontroll.tools/pub/logo.svg` → 301 naar `https://`, en via https 200 met
  `content-security-policy` en `strict-transport-security`.
  Terug: `npx wrangler deployments list` → `npx wrangler rollback <versie-id>`.
- `images.gocontroll.tech` na deploy (`npm run deploy:images`): zonder AUD `curl -sI https://images.gocontroll.tech/` → 503;
  met Access-app → 302 naar `gocontroll.cloudflareaccess.com`.
- `npm install` vraagt `legacy-peer-deps` (staat in `.npmrc`).
