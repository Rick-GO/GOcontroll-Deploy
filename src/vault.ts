// Using the signing keys: the key-encryption key from the Secrets Store (SIGNING_KEYS_KEY,
// store DEPLOY_SIGNING_KEYS_KEY), read at most once per request and only when a key is
// sealed or opened, and the signer of a folder's active key. A key that cannot be used now
// is a 503, never "no key": treating an unreadable store as a missing key would let a new
// key replace one that controllers in the field carry.

import type { Env } from './env';
import type { Signer } from './goco';
import { KeyUnavailableError, UnreadableKeyError, parsePublicKeyHex, sealScalar, signingKey, unsealScalar } from './keys';
import { HttpError } from './lib/http';
import { readSecret, type SecretSource } from './lib/secret';
import type { StoredKey, Versioned } from './state';

/** Seal and open keys with the KEK of `source`; a store that cannot be read becomes KeyUnavailableError. */
export function keyVault(source: SecretSource) {
  let kek: Promise<string | undefined> | undefined;
  const read = () => (kek ??= readSecret(source).catch((err) => {
    throw new KeyUnavailableError(`Secrets Store read failed: ${(err as Error)?.message || err}`);
  }));
  return {
    seal: async (scalar: Uint8Array, appId: string) => sealScalar(scalar, await read(), appId),
    unseal: async (sealed: string, appId: string) => unsealScalar(sealed, await read(), appId),
  };
}

/** The signer of a folder's active key, unsealed for this request only. */
export async function folderSigner(env: Env, appId: string, key: Versioned<StoredKey>): Promise<Signer> {
  try {
    const scalar = await keyVault(env.SIGNING_KEYS_KEY).unseal(key.value.sealed_private_key, appId);
    const publicKey = parsePublicKeyHex(key.value.public_key);
    return { privateKey: await signingKey({ scalar, publicKey }), publicKey };
  } catch (err) {
    throw keyFailure(err);
  }
}

/** KeyUnavailableError / UnreadableKeyError → 503 with a message a colleague can act on; anything else as is. */
export function keyFailure(err: unknown): unknown {
  if (err instanceof KeyUnavailableError) {
    console.error(`signing keys: ${err.message}`);
    return new HttpError(503, 'The signing keys cannot be used right now (the key-encryption key is not available). Try again later.');
  }
  if (err instanceof UnreadableKeyError) {
    console.error(`signing keys: ${err.message}`);
    return new HttpError(503, 'The signing key of this folder cannot be opened. Nothing was signed; ask IT to check DEPLOY_SIGNING_KEYS_KEY.');
  }
  return err;
}
