# GOcontroll-Deploy — architectuur en werkregels

## Stand
- Live op `deploy.gocontroll.tools` sinds 2026-10-21 (eerste versie `211d969d-5468-45eb-b102-57746d737af5`). Access-app
  met `/pub`-bypass bestaat; de AUD staat in `POLICY_AUD`. `DEPLOY_GROUPS` en de hubtegel staan op het object-ID van
  `CF_Deploy` (`b5877d29-e509-40b2-9784-17e649996f1f`). Downloadtellingen wachten op `DEPLOY_CF_API_TOKEN`.

## Architectuur
- **Worker met static assets** (geen Pages), zelfde opzet als GOcontroll-Logistic: `run_worker_first = true`,
  `workers_dev = false`, `preview_urls = false`, custom domain `deploy.gocontroll.tools`. Worker-naam
  **`gocontroll-deploy-intranet`**, nooit `gocontroll-deploy`: dat is de publieke device-Worker van de Deployment Tool op
  `deploy.gocontroll.tech` (zelfde bucket).
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
- Publiceren: binary eerst, dan manifest (etag-conditioneel, 409 bij race); onbekende manifestvelden blijven;
  `?v=` = eerste 16 hex van de payload-SHA-256; een bestaande map houdt de host die zijn manifest noemt (nooit twee
  hosts, §2.1); Linux-manifest (`versions[]`) = 422, nooit in schrijven; map met sleutel = alleen gesigneerd met die sleutel.
- **Alleen de beveiligde map-delete** (`DELETE /api/folders/:appId`, `src/delete.ts`) verwijdert objecten uit
  `gocontroll-deploy`, en altijd na archiveren naar `STATE` `deleted/<APP_ID>/<ts>/<key>` (grootte gecontroleerd).
  Manifest eerst en alleen, dan de rest; max. 200 per call, hervatbaar via `deleting/<APP_ID>.json`; vereist exacte
  App ID, reden ≥ 10 tekens en bevestiging als er nog controllers op die App ID staan. **De sleutel blijft.**
  Publiceren verwijdert nooit: een overschreven binary gaat eerst naar `replaced/…`, het manifest van vóór een
  publish staat in de logregel (`previous_manifest`). Terugzetten: README → *Deleting a folder* (manifest als laatste).

## Applicaties
- Een applicatie = map: objecten onder `<APP_ID>/`, een sleutel, of settings (`folders/<APP_ID>.json`). Elk van de
  drie laat hem zien op Status en geeft hem een pagina.
- *New application* (`POST /api/folders`) maakt alleen settings (customer, controller `S1`, distributiehost);
  alleen S1, 409 als de App ID al bestaat. De eerste release neemt de host uit de settings.
- Controllertype: handmatig (`S1`/`M1`/`L4`/`HMI1`) → S1-manifest = `S1` → meest voorkomende
  `controller_series.controller_type` (zonder `Moduline `) van de controllers op die App ID; bij een Linux-manifest de
  S1-controllers niet meetellen (`gocontroll-application` heeft er één L4 en één S1) → `null`. `kind` blijft voor de
  logica (wat het manifest is).
- Settings-index staat in de custom metadata van `folders/*.json` (`index`); zonder die markering leest Deploy het object.

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
  (`STATE`, privé): `keys/`, `keys-retired/`, `folders/`, `log/`, `replaced/`, `deleted/`, `deleting/`, `downloads/`
  (zie README → *Data*).
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
- Na deploy: `curl -sI https://deploy.gocontroll.tools/` → 302 naar `gocontroll.cloudflareaccess.com`.
  Terug: `npx wrangler deployments list` → `npx wrangler rollback <versie-id>`.
- `npm install` vraagt `legacy-peer-deps` (staat in `.npmrc`).
