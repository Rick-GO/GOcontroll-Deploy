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
- **0.4.1 (2026-10-28, versie `acbf96ba-4f0f-4689-b06d-74f4f4059b20`)**: de tab Firmware volgt de regels van agent 08 (zie
  *Module-firmware*); terug naar 0.4.0: `npx wrangler rollback 4876a23e-944b-4f73-b497-d978d321036b` (staat weer vervangen
  van een `.srec` toe en publiceert de werkkopie).
- **0.5.0 (2026-10-28, versie `6370d878-a30f-4723-bff0-937a55fabafe`)**: tag en GitHub Release vanuit de tab Firmware
  (`src/github.ts`); `DEPLOY_GITHUB_TOKEN` door de gebruiker gezet op 28-10 (fine-grained, **geldig tot 29-10-2027**: tijdig
  vernieuwen), dezelfde dag gecontroleerd: leest alle 11 `Module-*`-repo's, niets daarbuiten; schrijven blijkt bij de eerste
  tag. 0.5.1 (versie `e582f30e-2524-4ea3-9859-92736792a705`): `GET /api/firmware/github?repo=` (alleen lezen) en de pagina
  toont per repo of tag + release lukt; terug naar 0.5.0: `npx wrangler rollback 6370d878-a30f-4723-bff0-937a55fabafe`. Terug naar 0.4.1:
  `npx wrangler rollback acbf96ba-4f0f-4689-b06d-74f4f4059b20`.
- **0.6.0 (2026-10-28, versie `86d281d3-446d-4fd5-a2e0-ac7199b6a11e`; `gocontroll-images` versie `5cb45e29-0cc4-455f-a27e-8c757f1cad92`; besluit gebruiker: optie B)**: `images.gocontroll.tech` zonder Cloudflare Access en zonder one-time PIN:
  de klant vult zijn e-mailadres in (Turnstile), krijgt een link per mail (60 min geldig) en heeft daarna 7 dagen toegang op
  dat apparaat (ondertekende cookie, `IMAGES_SESSION_KEY`). De mail verstuurt deze Worker via het RPC-entrypoint `ImagesMail`
  (`src/images-mail.ts`, Graph met `MS365_CLIENT_SECRET`), zodat het mailsecret niet in de publieke Worker staat. Images-tab:
  tellingen per release en per maand (`src/images-stats.ts`, afgeronde maanden zonder adressen in `STATE` `images/stats/`) en
  *Copy link* per bestand (`/download/<path>`). **Open sinds 28-10** (`gocontroll-images` versie `340e55ee-9f89-4059-9d7c-da0925762cf8`; de widget verscheen pas vanaf `f6c26608`: een element met id `turnstile` is `window.turnstile` en werd voor de API aangezien):
  Turnstile-widget *GOcontroll Downloads* door de gebruiker gemaakt, sitekey `0x4AAAAAAFqCLsOdYdzKqlhv` in `TURNSTILE_SITE_KEY`,
  secret in `IMAGES_TURNSTILE_SECRET` (gecontroleerd: siteverify accepteert hem; een fout secret geeft 503, niet 403); nog geen
  echte link gemaild en geopend. Terug: eerst `gocontroll-images` naar `9a2c1639`
  (`-c images/wrangler.toml`), dan deze Worker naar 0.5.1 (`e582f30e-2524-4ea3-9859-92736792a705`).
- **0.6.1 (2026-10-29, versie `ebd51294-6086-4a8e-8587-a702b9a945b6`, wens gebruiker)**: bij elke keuze van een repo-map op de tab Firmware vraagt de pagina GitHub of
  HEAD de nieuwste commit van zijn branch is (`GET /api/firmware/github` met `commit` en `branch`, `checkGitHub` →
  `compareWithGitHub`, alleen lezen) en meldt het boven de bestanden: GitHub nieuwer (eerst pullen), HEAD niet gepusht, beide,
  of branch niet op GitHub; zonder GitHub uit `origin/<branch>` van de laatste fetch. Waarschuwing, geen blokkade. Terug naar
  0.6.0: `npx wrangler rollback 86d281d3-446d-4fd5-a2e0-ac7199b6a11e` (geen data of bindingen gewijzigd).
- **0.7.0 (2026-10-29, versie `d9953f95-a736-40d8-9f1b-51c0526ddc8a`, wens gebruiker)**: tabs **Applications** (was Status), **Firmware**, **Images**, **Key generator** (was
  Keys), in die volgorde (`public/js/routes.js`); oude hash-routes sturen door (`#/`, `#/status` → `#/applications`,
  `#/folders/<id>` → `#/applications/<id>`, `#/keys` → `#/key-generator`). **Deploy bewaart geen private key meer**: de Key
  generator maakt het paar in de browser, de medewerker bewaart de private key (1Password, `.cred`), Deploy alleen de public key
  per applicatie; signen gebeurt in de browser, de Worker controleert de handtekening (zie *Sleutels*). Het venster met het paar
  sluit ook met ×/Escape (eerst bevestigen zolang de private key niet gedownload of als bewaard aangevinkt is). Terug naar 0.6.1:
  `npx wrangler rollback ebd51294-6086-4a8e-8587-a702b9a945b6` (geen binding of bestaand object gewijzigd; 0.6.1 kan niet signen
  met een in 0.7.0 gekoppelde public key: 503 voor die map, zie README → *Rolling back*).
- **0.8.0 (2026-10-29, versie `fbebca17-acaf-4803-bc48-5f68a395d1bc`; `gocontroll-images` versie
  `dc1efb7b-089c-4d09-98db-514aa0609766`; wens gebruiker)**: alleen nog **controller-images** op images.gocontroll.tech. Het releasesoort `tool`
  is weg (geen `kind`, niets onder `tools/`, `manifest.json` format 2, STATE `images/releases/<product>/<versie>.json`, routes
  `/api/images/releases/:product/:version`), de bestandsrol `tool` ook; nieuw is de rol **`package`** (*Complete image*: een zip
  met alles wat UUU nodig heeft, de volledige image plus een script voor alleen de kernel). Contract images-spec 2.0.0. Die dag
  stond er in `gocontroll-images` en STATE `images/` geen release, concept, upload of `manifest.json` (gecontroleerd). Terug:
  eerst `npx wrangler rollback 340e55ee-9f89-4059-9d7c-da0925762cf8 -c images/wrangler.toml`, dan
  `npx wrangler rollback d9953f95-a736-40d8-9f1b-51c0526ddc8a` (0.7.0); releases van 0.8.0 ziet 0.7.0 niet (format 1 vraagt
  `kind`), dus die eerst terugtrekken en verwijderen.
- **0.9.0 (2026-10-29, versie `5f6aa698-1fce-4102-96f5-b0026dcbaa78`; `gocontroll-images` versie
  `8d01606e-e198-4153-a180-e51a070f9e05`; wens gebruiker: "te veel dubbele informatie")**: een release = **één controller** (L4/M1/HMI1) + versie,
  met datum en notes. Formulier *New release*: controller, releasedatum (standaard vandaag), versie, notes; **geen product- en
  geen titelveld**: product (`moduline-l4`) en naam (*Moduline L4*) volgen uit de controller (`CONTROLLER_PRODUCTS`,
  `controllerTitle`). Portaal: per controller één kaart, per release alleen versie en datum ("For the L4" en de productnaam
  weg). `manifest.json` **format 3** (zonder `product`, `title`, `controllers`), routes `/api/images/releases/:controller/:version`;
  STATE-keys, bucketpaden, downloadlog en tellingen ongewijzigd. Images-spec 3.0.0. Terug: eerst
  `npx wrangler rollback dc1efb7b-089c-4d09-98db-514aa0609766 -c images/wrangler.toml`, dan
  `npx wrangler rollback fbebca17-acaf-4803-bc48-5f68a395d1bc` (0.8.0), na het verwijderen van releases van 0.9.0 en van
  `manifest.json` (README → *Rolling back*).
- **0.9.1 (2026-10-29, versie `b903561d-cc62-4181-8225-069824314a63`; wens gebruiker)**: (1) een S1-applicatie gaat naar een andere
  distributiehost met *Change…* naast *Distribution host* op zijn pagina (`PUT /api/folders/:appId/distribution`,
  `src/distribution.ts`: §2.1 stap 2, elke URL in het manifest; `0x35` en `.cred` blijven bij de Deployment Tool); (2) Applications
  toont niet meer de public key zelf, alleen Yes/No/n/a (de key staat op de applicatiepagina). Geen binding of data gewijzigd.
  Terug naar 0.9.0: `npx wrangler rollback 5f6aa698-1fce-4102-96f5-b0026dcbaa78`; een verplaatst manifest blijft op zijn nieuwe host
  (eerst terugzetten met *Change…*, of `previous_manifest` uit de logregel `distribution`).
- **0.10.0 (2026-10-29, versie `9bdee976-0e87-48cd-9ffb-7096c8d3096d`; `gocontroll-images` versie
  `74d51437-8b5e-45b7-a184-e9626ab475e3`; wens gebruiker)**: een **type** per release (vrije tekst, optioneel,
  bijv. `1.07 - AV123`: hardwareversie × adapterboard van de HMI1). Elk type is een eigen systeem met een eigen *Latest*.
  Formulier: controller, releasedatum, type, versie, notes; het type hoort bij de identiteit en is niet via *Edit…* te wijzigen.
  Identiteit = controller + type + versie; map = `productOf(controller, type)` (`moduline-hmi1-107-av123`), ook de sleutel in
  de API (`/api/images/releases/:product/:version`); `manifest.json` **format 4**. Zelfde slug, andere tekst = 409. Releases
  zonder type houden map en sleutel. Gedeployd met het manifest nog in format 3 (vier releases zonder type). Terug: eerst
  `npx wrangler rollback 8d01606e-e198-4153-a180-e51a070f9e05 -c images/wrangler.toml`, dan
  `npx wrangler rollback b903561d-cc62-4181-8225-069824314a63` (0.9.1), na het verwijderen van releases met een type en van
  `manifest.json` (README → *Rolling back*).
- **0.11.0 (2026-10-29, gecommit, nog niet gedeployd; wens gebruiker: "vaste opslagmap per release; type en versie worden
  labels; geen bestanden verplaatsen")**: elke release heeft een eigen **sleutel** `<product>/<id>` = zijn **map**
  `images/<sleutel>/`, vast bij het aanmaken (nieuw: `<product van de controller>/<12 hex>`; van vóór 0.11.0: de map die hij had,
  bijv. `moduline-hmi1/AV101_6.12.87`). Routes `/api/images/releases/:product/:id`, STATE `images/releases/<sleutel>.json`, auditlog
  `image-<product>` met versie `<id>`, downloadlog en tellingen per sleutel. *Edit…* wijzigt datum, notes, **type en versie**, ook
  gepubliceerd (manifest mee, map en bestanden blijven); controller + type + versie uniek (409). `manifest.json` **format 5** (per
  release `folder`). Niets verplaatst, geen migratie. Deploy: `npm run deploy`, dan `npm run deploy:images`. Terug: eerst
  `npx wrangler rollback 74d51437-8b5e-45b7-a184-e9626ab475e3 -c images/wrangler.toml`, dan
  `npx wrangler rollback 9bdee976-0e87-48cd-9ffb-7096c8d3096d` (0.10.0); daarvoor in 0.11.0 nieuwe releases verwijderen, labels van
  oudere terugzetten naar hun map (type leeg, versie = laatste deel van de map) en `manifest.json` verwijderen (README → *Rolling
  back*).

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
- `src/goco.ts` en `src/keys.ts` hebben **geen imports** en alleen erasable TypeScript, `public/js/signing.js` geen imports en
  geen DOM: het fixture-script draait ze onder Node (de kruiscontrole signt zoals de browser: scope uit `goco.ts`, handtekening uit
  `signing.js`).
- S1 publiceren: binary eerst, dan manifest (etag-conditioneel, 409 bij race); onbekende manifestvelden blijven;
  `?v=` = eerste 16 hex van de payload-SHA-256; een bestaande map houdt de host die zijn manifest noemt (nooit twee
  hosts, §2.1); van host wisselen alleen voor het hele manifest tegelijk (`src/distribution.ts`, etag-conditioneel, vorige manifest
  in de logregel `distribution`); een Linux-map (`versions[]` of settings M1/L4/HMI1) = 422 (die neemt Linux-releases); map met public key =
  alleen gesigneerd met de private key daarvan: in de browser gesigneerd, door de Worker gecontroleerd (zie *Sleutels*).
- **Alleen de beveiligde map-delete** (`DELETE /api/folders/:appId`, `src/delete.ts`) verwijdert objecten uit
  `gocontroll-deploy`, en altijd na archiveren naar `STATE` `deleted/<APP_ID>/<ts>/<key>` (grootte gecontroleerd).
  Manifest eerst en alleen, dan de rest; max. 200 per call, hervatbaar via `deleting/<APP_ID>.json`; vereist exacte
  App ID, reden ≥ 10 tekens en bevestiging als er nog controllers op die App ID staan. **De public key blijft.**
  Publiceren verwijdert nooit: een overschreven binary gaat eerst naar `replaced/…`, het manifest van vóór een
  publish staat in de logregel (`previous_manifest`). Terugzetten: README → *Deleting a folder* (manifest als laatste).

## Module-firmware (`src/firmware.ts`, tab Firmware)
- Vervangt agent 08 (*Moduline Module Firmware Deployer*, `18-Agents/08 - …`, sinds 28-10 buiten gebruik) en volgt diens
  regels. Contract `GOcontroll-Architecture/cloudflare/firmware/spec.md` (≥ 1.4.0). Deploy is sinds 29-10 de **enige producent**: de CI van
  de `Module-*`-repos (`.github/workflows/publish-firmware.yml`, `.github/scripts/publish_firmware.py`, skill
  `module-firmware-deployment`) is die dag verwijderd (wens gebruiker). Deploy schrijft wat dat script schreef, in die
  volgorde: `modules/<hw_id>/<file>.srec`, `modules/<hw_id>/manifest.json`, `modules/manifest.json`
  (`JSON.stringify(…, 2)` zonder newline = `json.dumps(indent=2, ensure_ascii=False)`). `test/firmware.test.ts` eist
  dezelfde bytes als het echte script (op `updated` na), tegen `test/fixtures/firmware/ci-manifests.json`. Fixtures niet
  met de hand wijzigen; `npm run fixtures:firmware` (boto3 gestubd, `python -I`) draait alleen met het script terug op
  zijn pad uit de historie (`Module-4-20mA` commit `61fa466`).
- Bewust anders dan het script (regels van agent 08): `releases` **aflopend op versie** (go-modules flasht `releases[0]`);
  **`latest_firmware` nooit omlaag**; **een gepubliceerde `.srec` verandert nooit** (andere bytes onder dezelfde naam = altijd
  409, correctie = nieuw versienummer); bestaande versie = 409 tenzij `replace` (alleen de manifest-entry opnieuw, zelfde
  bestand); manifests etag-conditioneel met retry; `dry_run` = alles controleren, niets schrijven (de pagina toont dat altijd
  eerst); changelog genormaliseerd zoals de CI hem uit een tag las (`normaliseChangelog`).
- **Het bestand zoals git het heeft**: vanuit een repo stuurt de pagina de blob op HEAD (`git.js` `fileAt`), nooit de
  werkkopie (Windows + `core.autocrlf` = CRLF, andere SHA-256 dan in git); niet gecommit of afwijkend van de commit = niet
  te publiceren. Losse bestanden: CRLF → LF. Worker weigert CR.
- **Is HEAD de nieuwste commit?** Bij elke mapkeuze vergelijkt de Worker HEAD met de branch op GitHub (`compareWithGitHub`:
  `branches/<branch>`, dan `compare/<HEAD>...<branch-head>`; `ahead` = GitHub nieuwer); detached HEAD = default branch.
  Kent GitHub HEAD niet (404: ongepushte commits), dan beslist de pagina met zijn eigen historie (`reaches`) of GitHub óók
  verder is. Zonder token of leesrecht: `origin/<branch>` van de laatste fetch, en dat staat erbij. `syncState`
  (`public/js/release-helpers.js`) maakt er één toestand van; `pushed` volgt daarna GitHub, dus ook *Then set tag…* in de
  review. Alleen waarschuwen, niet blokkeren (keuze 29-10).
- Bestandsnaam = alles: `20-10-1-6-2-0-3.srec` → `20100106`, `2.0.3`, HW `1.06` (`parseSrecName`, in `src/` én
  `public/js/release-helpers.js`, `test/pages.test.ts` houdt ze gelijk). Naam van een nieuwe hardware-ID: andere HW-versie van
  hetzelfde type → `MODULE_TYPE_NAMES` → door de collega ingetypt. Nooit iets onder `brcm/`.
- Releasedatum = `RELEASE_DATE` van tag `v<versie>` als die bestaat, anders de datum van het `.srec`-bestand
  (`lastModified`); `DD/MM/YY` in het manifest. Changelog: tekst van die tag, anders ingetypt (één regel Engels) met de
  commits sinds de vorige versietag ernaast. **`public/js/git.js`** (alleen lezen: loose + packs met OFS/REF-delta,
  `packed-refs`, geannoteerde tags, bestanden van een commit, origin-URL en tracking branch; geen SHA-256-repos, reftable,
  worktrees/submodules). Fixture `test/fixtures/git/` komt van `npm run fixtures:git` (git CLI); niet met de hand wijzigen.
- **Geen vangnet meer** (29-10, wens gebruiker; de keuze van 21-07 vervalt): geen `Module-*`-repo heeft nog
  `publish-firmware.yml`, een tag pushen publiceert niets. `safetyNetFindings` (workflow ontbreekt, `MODULE_NAME` ≠
  manifestnaam, secrets, script ontbreekt of mist de versiecheck) en *geen tag voor een oudere versie* in `src/github.ts`
  staan er nog, maar slaan alleen aan als een repo de workflow terugkrijgt.
- **Tag en GitHub Release** (`src/github.ts`, `POST /api/firmware/releases`, wens gebruiker 28-10): na publiceren zet Deploy
  per versie (aangevinkt in de review) zelf tag `v<versie>` en maakt de release met de `.srec` als asset. Tekst uit de
  gepubliceerde manifests (niet uit de browser); bestanden op die commit op GitHub moeten de gepubliceerde SHA-256 hebben
  (= gepusht); **geen tag voor een oudere versie als de repo de workflow heeft** (die zet hem bovenaan → controllers terug);
  **altijd een annotated tag via `git/tags` + `git/refs`**, nooit de lightweight tag van de release-API (geen annotatie
  om datum en changelog uit te lezen); bestaande tag met andere tekst alleen vervangen na bevestiging. Token `DEPLOY_GITHUB_TOKEN`
  (binding `GITHUB_TOKEN`, fine-grained, Contents read/write op `Module-*`; `not-set` = uit, dan commando's zoals in 0.4.1),
  repos beperkt door `GITHUB_REPOS`. Tests mocken GitHub altijd (`test/github.test.ts`).
- Log: `publish-firmware` met `previous_module_manifest` en `previous_master_manifest` (terugzetten = die terugschrijven);
  `firmware-log/<hw_id>/<versie>.json` (+ custom metadata) = wie publiceerde uit welke repo/commit; zonder = de CI (tot 29-10).

## Images voor klanten (`src/images.ts`, tab Images, `images/`)
- Formaat en bucketindeling: **`src/images-format.ts`** (geen imports; door beide Workers gebundeld). Contract
  `GOcontroll-Architecture/cloudflare/images/spec.md` (≥ 5.0.0). Deploy is de **enige schrijver** van releases en
  `manifest.json`; `images.gocontroll.tech` (Worker `gocontroll-images`, `images/`) is de enige lezer en schrijft alleen
  `downloads/` en `access-mails/` (het uurplafond van 5 links per adres, sleutel = HMAC van het adres, lifecycle 1 dag).
- **Alleen controller-images** (sinds 0.8.0, wens gebruiker): een release heeft geen soort, alles staat onder `images/`.
- **Eén controller per release** (sinds 0.9.0), **optioneel één type** (sinds 0.10.0), **eigen map** (sinds 0.11.0, wens
  gebruiker): controller, type en versie zijn **labels**, samen uniek per controller (`checkLabels`, 409); type en versie te
  wijzigen, de controller niet. De identiteit is de **sleutel** `<product>/<id>` (`ReleaseRef`) = de map `images/<sleutel>/`, vast
  bij het aanmaken: nieuw `CONTROLLER_PRODUCTS[controller]/<12 hex>` (`newId`), van vóór 0.11.0 de map die het record had (de
  STATE-key; manifest format 4 en ouder: `legacyFolder`). Nooit iets verplaatsen: bestand = `<map>/<naam>`. De naam voor klanten =
  `controllerTitle` op de kaart (*Moduline HMI1*), het type naast de versie, `releaseName` op de downloadpagina (*Moduline HMI1 ·
  1.07 - AV123*). Type = vrije tekst (`normaliseType`: max. 40 printbare ASCII-tekens, met een letter of cijfer); een type dat
  een bestaand type van de controller anders gespeld is (zelfde `typeSlug`) = 409. Elk type is een eigen systeem: per controller +
  type de nieuwste open en *Latest* (`latestPerType`). Een record zonder type (0.9.x) heeft geen
  type; een record van 0.8.0 (`product`, `title`, `controllers`) leest als de controller van zijn product (`asRelease`/`asUpload`)
  en wordt bij de volgende wijziging in de nieuwe vorm geschreven; geen datamigratie.
- Bestandsrollen `FILE_ROLES`, waarvan **`package`** = *Complete image* (zip met alles
  wat UUU nodig heeft: de volledige image en een script voor alleen de kernel; `.zip` raadt de pagina als `package`). Een rol
  die het contract niet kent (bijv. `tool` van vóór 0.8.0) leest als `other`. Labels: bron `src/images-format.ts`, kopieën in
  `public/js/release-helpers.js` (`test/pages.test.ts`) en `images/public/format.js` (`images/test/page.test.ts`).
- `manifest.json` is **format 5** (`CATALOGUE_FORMAT`; per release `folder`). Een nieuwer format: de download-site toont niets
  (`parseCatalogue`) en Deploy schrijft er nooit overheen (409); een ouder format wordt gelezen (format 4 en ouder: map
  `legacyFolder`; format 3: geen type; format 2: de controller van zijn `product`) en bij de volgende publicatie, wijziging van
  een gepubliceerde release of terugtrekking format 5. Een map moet bij de controller horen en uniek zijn; een bestand moet erin
  staan. Downloadlog: `product`/`version` = de twee delen van de map (de sleutel), niet de labels.
- Release = concept in `STATE` `images/releases/<sleutel>.json` (auditlog App ID `image-<product>`, versie `<id>`, met de labels); bestanden staan al in de bucket, maar de
  download-Worker serveert alleen wat `manifest.json` noemt. Publiceren/terugtrekken = `manifest.json` etag-conditioneel
  herschrijven. In `manifest.json` nooit e-mailadressen of concepten (`catalogueEntry`). Alleen een concept verliest
  bestanden of wordt verwijderd (geen archief: images worden opnieuw gebouwd).
- Upload: R2-multipart, delen van precies `PART_SIZE` (32 MiB, laatste de rest), ruwe bytes via
  `PUT /api/images/uploads/<id>/parts/<n>` (`application/octet-stream`, same-origin, gestreamd naar R2; `src/index.ts`
  `PART_PATH`), daarna `complete`: grootte gecontroleerd en SHA-256 uit het opgeslagen object (`crypto.DigestStream`).
- Downloadlog: lege objecten `downloads/<yyyy>/<mm>/<iso>-<rand>.json` met custom metadata (`DownloadMeta`); Deploy leest
  alleen de listing van deze en vorige maand.
- Downloadtellingen (`src/images-stats.ts`): per afgeronde maand één keer opgeteld uit het log naar `STATE`
  `images/stats/<yyyy-mm>.json` (**zonder e-mailadressen**, alleen het aantal verschillende), door de cron en bij bekijken
  (max. 6 per run, een uur na het einde van de maand); de lopende maand (en vorige maand in zijn eerste uur) live. Zo blijven
  de totalen na de 13 maanden van het log.
- **Inloggen op images.gocontroll.tech** (sinds 0.6.0, geen Access): `POST /api/access` (same origin, rate limit per IP
  `RL_ACCESS`, geldig adres, Turnstile actie `access` op de eigen hostname, max. `LINKS_PER_HOUR` per adres) → link
  `l.<payload>.<hmac>` (60 min) → `GET /access` zet cookie `__Host-images-session` `s.<payload>.<hmac>` (7 dagen). Soort zit in de
  handtekening (link ≠ cookie); `next` alleen `/` of `/download/<release-bestand>` (`safeNext`). Niets server-side: nieuwe
  `IMAGES_SESSION_KEY` = iedereen opnieuw. Sleutel onleesbaar = 503, nooit "uitgelogd".
- **`ImagesMail`** (`src/images-mail.ts`, `export { ImagesMail }` in `src/index.ts`): mailt één vaste tekst, alleen naar het
  ene adres en alleen met een link `<IMAGES_URL>/access?t=<LINK_TOKEN_RE>`; al het andere geweigerd vóór Microsoft. Antwoordt
  `{ ok }`, gooit niet; log noemt alleen het domein van het adres. `src/mail/graph.ts` is een kopie van die van de
  Configurator: houd ze in de pas. Deploy deze Worker vóór `gocontroll-images` (die bindt het entrypoint).
- `images/` heeft eigen `wrangler.toml`, tests (`npm run test:images`, deel van `npm test`) en deploy
  (`npm run deploy:images`). Bindt `IMAGES_BUCKET`, `MAIL` (`ImagesMail`), `RL_ACCESS` en de store-secrets
  `IMAGES_SESSION_KEY` en `IMAGES_TURNSTILE_SECRET` (`not-set` = geen links); **nooit** een Microsoft 365-secret, `STATE` of een
  D1 (`images/test/config.test.ts`). `TURNSTILE_SITE_KEY` leeg = 503 op alles. De Turnstile-widget maakt de eigenaar in het
  dashboard (de wrangler-login heeft geen Turnstile-rechten); Access, one-time PIN en een WAF-regel zijn niet meer nodig.

## Applicaties
- Een applicatie = map: objecten onder `<APP_ID>/`, een public key, of settings (`folders/<APP_ID>.json`). Elk van de
  drie laat hem zien op Applications en geeft hem een pagina (`#/applications/<APP_ID>`).
- *New application* (`POST /api/folders`) maakt alleen settings (customer, controller, wie/wanneer); 409 als de App ID
  al bestaat. S1: met distributiehost (de eerste release neemt die). M1/L4/HMI1: Linux-App-ID
  (`^[a-z0-9][a-z0-9._-]*$`, max. 64, zoals `config.schema.json`), geen host; zo'n map is `kind: "linux"`.
- Controllertype: handmatig (`S1`/`M1`/`L4`/`HMI1`) → S1-manifest = `S1` → meest voorkomende
  `controller_series.controller_type` (zonder `Moduline `) van de controllers op die App ID; bij een Linux-manifest de
  S1-controllers niet meetellen (`gocontroll-application` heeft er één L4 en één S1) → `null`. `kind` blijft voor de
  logica (wat het manifest is).
- Settings-index staat in de custom metadata van `folders/*.json` (`index`); zonder die markering leest Deploy het object.
- Applications toont per applicatie alleen óf er een public key is (sinds 0.9.1, wens gebruiker: niet de key zelf); de key staat
  op de applicatiepagina (kopiëren, `.pub`). `/api/overview` geeft `publicKey` nog wel: de Key generator kiest daarmee de
  applicaties zonder key.
- Distributiehost (S1): *Change…* op de applicatiepagina zet elke URL van het manifest op een andere host uit
  `DISTRIBUTION_URLS` (beide hosts = dezelfde bucket); een map zonder releases krijgt alleen de host in zijn settings.

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
  signen blijft S1 (een public key mag wel aan een Linux-applicatie hangen, als opslag voor provisioning; `/api/sign/scope`
  weigert hem). Downloads van controllers lopen via de signed route van Moduline, niet via Deploy.
- Max. 100 MB per package (Cloudflare-edge ~100 MB per request; de Worker houdt het package één keer in geheugen).

## Sleutels
- **Deploy bewaart geen private key** (sinds 0.7.0, wens gebruiker). De Key generator maakt een P-256-paar in de browser
  (`public/js/signing.js`, WebCrypto) en toont het één keer; downloads = de bestanden van `s1_ble.py keygen --out`:
  `<APP_ID>-signing-key.pem` (PKCS#8) en `.pub` (130 hex + newline); base64 = `FW_PRIVATE_KEY_B64`. Formaten van `keys.py`,
  geen eigen formaat. Python leest het paar terug (`browser_key_pair_read_by_python` in de GOCO-fixtures).
- **Public key per applicatie** in `STATE` `keys/<APP_ID>.json` (`source: "attached"`, verder niets), via
  `PUT /api/folders/:appId/key` (punt op P-256 gecontroleerd; vervangen = App ID typen, oude naar `keys-retired/`, nooit weg).
  Ook voor een Linux-applicatie (provisioning). `POST …/key` (generate/import) = 410, body ongelezen.
- **Signen**: de pagina vraagt de private key (plakken of `.pem`/base64/`.cred`), controleert lokaal dat hij bij de public key
  hoort (`signerFor`), vraagt de scope (`POST /api/sign/scope`, `goco.ts` `signedScope`) en signt scope + payload; alleen de
  64-byte `signature` gaat mee met de upload. De Worker bouwt de scope opnieuw uit wat binnenkwam en weigert (422 `signature`)
  tenzij hij verifieert tegen de public key, vóór er iets geschreven wordt. `src/goco.ts` blijft de enige producent van de
  container. Een verzoek met `privateKey` = 400, ongelezen, niet opgeslagen, niet gelogd (tests in `test/sign.test.ts`).
- **Sleutels van vóór 0.7.0** (in de Worker gegenereerd of geïmporteerd): privédeel verzegeld (AES-256-GCM onder
  `DEPLOY_SIGNING_KEYS_KEY`, binding `SIGNING_KEYS_KEY`, AAD `deploy-key:<APP_ID>`). **Niet verwijderen, niet wijzigen**, binding
  blijft; niets opent ze nog (`sealScalar`/`unsealScalar` in `src/keys.ts` beschrijven alleen het formaat). Hun public key telt als
  de public key van de applicatie; signen vraagt ook daar de private key. Geen export toevoegen zonder besluit van de gebruiker
  (eenmalig naar 1Password, of laten staan als terugval). Stand 29-10: één zo'n sleutel, `gocontroll-application` (gegenereerd
  29-10 06:51 UTC door de gebruiker, nooit mee gesigneerd; de releases 0.0.1–0.0.6 van die map zijn met een **andere** sleutel
  gesigneerd, `044887C66EF0…`, van vóór Deploy).
- KEK roteren alleen met een her-verzegelpad (bestaat niet): dus niet roteren. Een onleesbare KEK is alleen nog zichtbaar in
  `/api/health` (`signingKeys`).

## Opslag en databases
- **Geen eigen D1** (bij het bouwen op 21-10 zat het account aan de Free-plan-D1-limiet; R2 volstaat voor deze data,
  dus het blijft zo): app-state is JSON in R2 **`gocontroll-deploy-state`**
  (`STATE`, privé): `keys/` (public keys; van vóór 0.7.0 ook verzegelde private keys), `keys-retired/`, `folders/`, `log/`, `replaced/`, `deleted/`, `deleting/`, `downloads/`,
  `firmware-log/`, `images/releases/`, `images/uploads/` (zie README → *Data*).
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
- `images.gocontroll.tech` na deploy (`npm run deploy:images`, altijd ná `npm run deploy`): zonder sitekey
  `curl -sI https://images.gocontroll.tech/` → 503; met sitekey → 303 naar `/sign-in`, en `/sign-in` → 200 met een CSP die
  `challenges.cloudflare.com` toestaat.
- `npm install` vraagt `legacy-peer-deps` (staat in `.npmrc`).
