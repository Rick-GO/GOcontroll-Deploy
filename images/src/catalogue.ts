// The published catalogue: manifest.json of the bucket, read on every request that needs it (no
// cache), so a release the intranet withdraws stops being downloadable at once.

import { CATALOGUE_KEY, emptyCatalogue, parseCatalogue, type Catalogue } from '../../src/images-format';

/**
 * manifest.json as a Catalogue; no manifest yet = the empty catalogue (nothing published).
 * @throws when the manifest is not JSON (nothing is served then: the caller answers 503)
 */
export async function loadCatalogue(bucket: R2Bucket): Promise<Catalogue> {
  const object = await bucket.get(CATALOGUE_KEY);
  if (!object) return emptyCatalogue();
  return parseCatalogue(await object.text());
}
