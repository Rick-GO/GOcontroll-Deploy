// What an App ID and a version may look like, for the routes.
//
// An App ID names a bucket folder, goes into the container header (ASCII, at most 32
// characters, cloud-r2-distribution.md §4) and into the binary URL of the manifest. Folders
// already in the bucket are read whatever their name (a Linux App ID can be longer); what is
// written (a release, a key, a customer) must be a safe S1 App ID.

import { GocoError, formatVersion, parseVersion } from '../goco';
import { HttpError } from './http';

/** Letters, digits and . _ - + ~, starting with a letter or digit: safe in a key, a URL and a header. */
const S1_APP_ID = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,31}$/;
/** Any folder name the bucket can hold: printable ASCII, no slash, no surrounding space. */
const FOLDER = /^[\x21-\x2e\x30-\x7e](?:[\x20-\x2e\x30-\x7e]{0,198}[\x21-\x2e\x30-\x7e])?$/;

/** A route's :appId as a folder name to read; anything else is a 404. */
export function folderParam(value: string | undefined): string {
  const v = value ?? '';
  if (!FOLDER.test(v)) throw new HttpError(404, 'Not found.');
  return v;
}

/** An App ID something is written for. */
export function s1AppId(value: unknown, field = 'appId'): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new HttpError(400, 'Fill in the App ID.', field);
  if (!S1_APP_ID.test(v)) {
    throw new HttpError(400, 'An App ID is at most 32 characters: letters, digits and . _ - + ~, starting with a letter or digit.', field);
  }
  return v;
}

/** "major.minor.patch", each 0-255, normalised ("01.2.3" is 1.2.3). */
export function versionField(value: unknown, field = 'version'): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new HttpError(400, 'Fill in the version (major.minor.patch).', field);
  try {
    return formatVersion(parseVersion(v));
  } catch (err) {
    if (err instanceof GocoError) throw new HttpError(400, 'A version is major.minor.patch, each 0–255.', field);
    throw err;
  }
}
