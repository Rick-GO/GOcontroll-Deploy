/** Bindings and vars from wrangler.toml, Secrets Store bindings, plus local-dev vars. */
export interface Env {
  DEPLOY_BUCKET: R2Bucket; // gocontroll-deploy: the S1 distribution bucket (read + publish)
  STATE: R2Bucket;         // gocontroll-deploy-state: keys, folder settings, audit log, download days
  BUSINESS_DB: D1Database; // gocontroll-business: customers, projects (read only)
  MODULINE_DB: D1Database; // gocontroll-db: controllers, project_provisioning (read only)
  FIRMWARE_BUCKET: R2Bucket; // gocontroll-firmware: module firmware (.srec) and manifests (src/firmware.ts)
  IMAGES_BUCKET: R2Bucket;   // gocontroll-images: Linux images and tools for customers (src/images.ts)
  ASSETS: Fetcher;

  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  DEPLOY_GROUPS: string;   // Entra group object IDs that may use Deploy; empty: nobody

  DISTRIBUTION_URLS: string; // allowed bases of manifest URLs; the first one for a new folder
  DOWNLOAD_HOSTS: string;    // hostnames counted as downloads
  FIRMWARE_URLS: string;     // hosts of the firmware bucket; the first one for links
  IMAGES_URL: string;        // the download site of the images bucket
  GITHUB_REPOS: string;      // the repositories Deploy may tag and release in (owner/name, a trailing * allowed)

  // Secrets Store (src/lib/secret.ts reads both forms; a plain string locally and in tests).
  SIGNING_KEYS_KEY?: SecretsStoreSecret | string; // store DEPLOY_SIGNING_KEYS_KEY: AES-256 KEK of the signing keys
  CF_API_TOKEN?: SecretsStoreSecret | string;     // store DEPLOY_CF_API_TOKEN: GraphQL Analytics (optional)
  GITHUB_TOKEN?: SecretsStoreSecret | string;     // store DEPLOY_GITHUB_TOKEN: tags and releases of the Module-* repos; not-set = off

  // Local development only, honoured on localhost (see auth.ts).
  DEV_USER_EMAIL?: string;
  DEV_USER_NAME?: string;
  DEV_USER_GROUPS?: string;
}

/** The signed-in colleague, resolved from the verified Access token. */
export interface User {
  email: string;          // lowercase; recorded as actor on every write
  name: string;           // display name without " | GOcontroll"
  groups: string[];       // object IDs and names, to look an ID up (/api/me)
  groupIds: string[];     // object IDs only: what access is decided on
}

export type AppEnv = { Bindings: Env; Variables: { user: User } };
