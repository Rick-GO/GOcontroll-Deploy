/**
 * The bindings of gocontroll-images (images/wrangler.toml), and nothing else: no state bucket, no
 * database, no secret. images/test/config.test.ts pins the list.
 */
export interface Env {
  IMAGES_BUCKET: R2Bucket; // gocontroll-images: manifest.json, the releases, the download log
  ASSETS: Fetcher;         // images/public: the page, its script and stylesheet, the brand images

  TEAM_DOMAIN: string;     // Access team domain: token issuer, source of /cdn-cgi/access/certs
  IMAGES_AUD: string;      // AUD tag of the Access application on images.gocontroll.tech; empty: 503 everywhere

  // Local development only, honoured on a localhost URL (src/auth.ts).
  DEV_USER_EMAIL?: string;
}
