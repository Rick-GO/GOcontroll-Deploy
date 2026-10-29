// @ts-check
// The pure helpers of the Firmware and Images pages (firmware.js, images.js): no DOM, so the
// Worker's test runtime can run them (test/pages.test.ts).

/** @typedef {{ file: string, hwId: string, typeId: string, version: string, hardwareVersion: string }} SrecName */
/** @typedef {{ name: string, commit: string, annotated: boolean, message: string | null, date: string | null }} Tag */

/** Same as the Worker: four hardware parts of one or two digits, three firmware parts. */
const SREC_NAME = /^(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.srec$/;

/** The hardware ID and firmware version in an .srec name, as src/firmware.ts reads them. @param {string} file @returns {SrecName | null} */
export function parseSrecName(file) {
  const m = SREC_NAME.exec(file);
  if (!m) return null;
  const hwId = m.slice(1, 5).map((p) => p.padStart(2, '0')).join('');
  return { file, hwId, typeId: hwId.slice(0, 6), version: m.slice(5, 8).join('.'), hardwareVersion: `1.${hwId.slice(6)}` };
}

/** @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** CRLF and lone CR to LF. @param {string} text */
export const toLf = (text) => text.replace(/\r\n?/g, '\n');

/** A local date as YYYY-MM-DD (the release date field). @param {number} ms */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A changelog the way the CI reads it from a tag annotation (and src/firmware.ts stores it): every
 * line without trailing white space, no blank lines, trimmed. @param {string} text
 */
export function normaliseChangelog(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).join('\n').trim();
}

/**
 * The changelog in a tag annotation as the CI reads it (publish-firmware.yml): every line but the
 * RELEASE_DATE: and DEPLOY_FILES: ones, without blank lines. @param {string} message
 */
export function changelogFromTag(message) {
  return normaliseChangelog(message.split(/\r?\n/).filter((l) => !/^(RELEASE_DATE|DEPLOY_FILES):/.test(l)).join('\n'));
}

/** The RELEASE_DATE: of a tag annotation (DD/MM/YY) as YYYY-MM-DD, or null. @param {string} message */
export function releaseDateFromTag(message) {
  const m = /^RELEASE_DATE:\s*(\d{2})\/(\d{2})\/(\d{2})\s*$/m.exec(message);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

/** The DEPLOY_FILES: of a tag annotation, sorted, or null. @param {string} message */
function deployFilesFromTag(message) {
  const m = /^DEPLOY_FILES:\s*(.*)$/m.exec(message);
  return m ? m[1].split(',').map((f) => f.trim()).filter(Boolean).sort() : null;
}

/** YYYY-MM-DD → DD/MM/YY. @param {string} iso */
export const manifestDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;

/**
 * The annotation of tag v<version> for a publish, in the format the CI reads
 * (module-firmware-deployment): with it, the CI run the tag starts writes what Deploy wrote.
 * @param {string} released  YYYY-MM-DD @param {string[]} files @param {string} changelog
 */
export function tagAnnotation(released, files, changelog) {
  return `RELEASE_DATE: ${manifestDate(released)}\nDEPLOY_FILES: ${[...files].sort().join(',')}\n\n${normaliseChangelog(changelog)}\n`;
}

/**
 * Whether an existing tag annotation makes the CI write the same as this publish: same date, same
 * files, same changelog. @param {string} message @param {string} released @param {string[]} files @param {string} changelog
 */
export function annotationMatches(message, released, files, changelog) {
  return releaseDateFromTag(message) === released
    && JSON.stringify(deployFilesFromTag(message)) === JSON.stringify([...files].sort())
    && changelogFromTag(message) === normaliseChangelog(changelog);
}

/** The https URL of a GitHub repository from its remote URL (https or ssh), or null. @param {string | null} url */
export function githubUrl(url) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** owner/name of a GitHub repository from its remote URL, or null. @param {string | null} url */
export function githubSlug(url) {
  const link = githubUrl(url);
  return link ? link.slice('https://github.com/'.length) : null;
}

/**
 * @typedef {{ branch: string, head: { sha: string, date: string | null, subject: string } | null,
 *   state: 'up-to-date' | 'github-newer' | 'local-newer' | 'diverged' | 'not-on-github' | 'no-branch',
 *   githubNewer: number | null, localNewer: number | null }} GitHubSync  GitHub's answer (src/github.ts)
 * @typedef {{ source: 'github' | 'fetch', branch: string | null, head: GitHubSync['head'],
 *   state: 'up-to-date' | 'github-newer' | 'local-newer' | 'diverged' | 'no-branch' | 'unknown',
 *   githubNewer: number | null, localNewer: number | null, pushed: boolean | null, reason: string | null }} Sync
 *   source: GitHub itself, or the clone's origin/<branch> as of its last fetch (GitHub could not be asked: reason)
 */

/**
 * Whether the chosen clone's HEAD is the newest commit of its branch. GitHub's answer when Deploy
 * could ask; when GitHub does not know HEAD at all, the clone's own history decides: HEAD reaching
 * GitHub's newest commit means only HEAD moved on, otherwise both did. Without GitHub, from
 * origin/<branch> as of the last fetch (pushed: HEAD is on it; trackingNewer: it has commits HEAD
 * lacks). `pushed` in the result is whether HEAD is on the branch, the best this knows.
 * @param {{ github: GitHubSync | null, headReachesGithub: boolean | null, branch: string | null,
 *   pushed: boolean | null, trackingNewer: boolean | null, reason: string | null }} x
 * @returns {Sync}
 */
export function syncState({ github, headReachesGithub, branch, pushed, trackingNewer, reason }) {
  if (github) {
    const base = { source: /** @type {const} */ ('github'), branch: github.branch, head: github.head, githubNewer: github.githubNewer, localNewer: github.localNewer, reason: null };
    if (github.state !== 'not-on-github') {
      return { ...base, state: github.state, pushed: github.state === 'up-to-date' || github.state === 'github-newer' };
    }
    if (headReachesGithub === null) {
      return { ...base, state: 'unknown', pushed: false, reason: `HEAD is not on GitHub, and whether ${github.branch} on GitHub has newer commits too could not be told` };
    }
    return { ...base, state: headReachesGithub ? 'local-newer' : 'diverged', githubNewer: headReachesGithub ? 0 : null, pushed: false };
  }
  const base = { source: /** @type {const} */ ('fetch'), branch, head: null, githubNewer: null, localNewer: null, pushed, reason };
  if (!branch || pushed === null || (pushed && trackingNewer === null)) return { ...base, state: 'unknown' };
  if (pushed) return { ...base, state: trackingNewer ? 'github-newer' : 'up-to-date' };
  return { ...base, state: trackingNewer ? 'diverged' : 'local-newer' };
}

/**
 * What the safety net (the repository's own publish-firmware.yml, which a tag push starts) would do
 * differently, as the deployment agent checks it before a publish.
 * @param {{ workflow: string | null, script: string | null, scriptPath: string | null, names: string[] }} repo
 *   workflow: .github/workflows/publish-firmware.yml; script: the script its run: line names; names:
 *   the module names on firmware.gocontroll.tech of the files to publish
 * @returns {string[]}  one sentence per finding; none when the safety net agrees
 */
export function safetyNetFindings({ workflow, script, scriptPath, names }) {
  if (workflow === null) return ['This repository has no .github/workflows/publish-firmware.yml: pushing the tag publishes nothing, so there is no safety net (that is fine).'];
  const out = [];
  const moduleName = /^\s*MODULE_NAME:\s*"?([^"\n]*?)"?\s*$/m.exec(workflow)?.[1] ?? null;
  for (const name of new Set(names.filter(Boolean))) {
    if (moduleName !== null && moduleName !== name) {
      out.push(`The workflow's MODULE_NAME is "${moduleName}", the manifests say "${name}": for a hardware version that is new on firmware.gocontroll.tech, the CI would use its own.`);
    }
  }
  for (const secret of ['FIRM_R2_ACCESS_KEY_ID', 'FIRM_R2_SECRET_ACCESS_KEY', 'CF_ACCOUNT_ID']) {
    if (!workflow.includes(`secrets.${secret}`)) out.push(`The workflow does not use the secret ${secret}: its run would fail.`);
  }
  if (!scriptPath) out.push('The workflow runs no publish_firmware.py.');
  else if (script === null) out.push(`The workflow runs ${scriptPath}, which is not in the repository: its run would fail.`);
  else if (!/_ver\(sw_ver\)\s*>\s*_ver\(/.test(script)) out.push(`${scriptPath} sets latest_firmware also for an older version: push tags of the same module in version order, lowest first.`);
  return out;
}

/** The highest v<x.y.z> tag below `version`. @param {Tag[]} tags @param {string} version */
export function previousTag(tags, version) {
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t.name) && compareVersions(t.name.slice(1), version) < 0)
    .sort((a, b) => compareVersions(b.name.slice(1), a.name.slice(1)))[0] ?? null;
}

// ── Images ──

/**
 * What a file of an image is: copies of FILE_ROLE_LABELS and PLATFORM_LABELS in src/images-format.ts
 * (the source; test/pages.test.ts fails when they drift apart), in the order of the role choice.
 * @type {Readonly<Record<string, string>>}
 */
export const IMAGE_ROLE_LABELS = Object.freeze({
  package: 'Complete image', rootfs: 'Root file system', kernel: 'Kernel', bootloader: 'Bootloader', devicetree: 'Device tree',
  script: 'Flash script', docs: 'Documentation', other: 'Other',
});
/** @type {Readonly<Record<string, string>>} */
export const IMAGE_PLATFORM_LABELS = Object.freeze({ any: 'Any', windows: 'Windows', linux: 'Linux', macos: 'macOS' });

/** A guess of a file's role from its name: a zip is the complete image for UUU. @param {string} name */
export function guessRole(name) {
  const n = name.toLowerCase();
  if (/\.zip$/.test(n)) return 'package';
  if (/\.(ps1|sh|bat|cmd)$/.test(n)) return 'script';
  if (/rootfs|\.ext4|\.wic|\.img\.(zst|gz|xz)$/.test(n)) return 'rootfs';
  if (/barebox|u-boot|imx-boot|flash\.bin|bootloader/.test(n)) return 'bootloader';
  if (/\.dtb$|devicetree/.test(n)) return 'devicetree';
  if (/^(image|zimage|vmlinu[xz])|kernel/.test(n)) return 'kernel';
  if (/\.(pdf|md|txt|html)$/.test(n)) return 'docs';
  return 'other';
}

/** The platform a file runs on, from its name. @param {string} name */
export function guessPlatform(name) {
  const n = name.toLowerCase();
  if (/\.(exe|msi|ps1|bat|cmd)$/.test(n) || n.includes('win')) return 'windows';
  if (/\.(dmg|pkg)$/.test(n) || n.includes('mac')) return 'macos';
  if (/\.(sh|appimage|deb)$/.test(n) || n.includes('linux')) return 'linux';
  return 'any';
}
