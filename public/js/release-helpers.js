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
 * The changelog in a tag annotation as the module-firmware-deployment skill writes it: without
 * the RELEASE_DATE: and DEPLOY_FILES: lines. @param {string} message
 */
export function changelogFromTag(message) {
  return message.split('\n').filter((l) => !/^(RELEASE_DATE|DEPLOY_FILES):/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The highest v<x.y.z> tag below `version`. @param {Tag[]} tags @param {string} version */
export function previousTag(tags, version) {
  return tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t.name) && compareVersions(t.name.slice(1), version) < 0)
    .sort((a, b) => compareVersions(b.name.slice(1), a.name.slice(1)))[0] ?? null;
}

// ── Images ──

/** A guess of a file's role from its name. @param {string} name @param {'image' | 'tool'} kind */
export function guessRole(name, kind) {
  const n = name.toLowerCase();
  if (/\.(ps1|sh|bat|cmd)$/.test(n)) return 'script';
  if (/rootfs|\.ext4|\.wic|\.img\.(zst|gz|xz)$/.test(n)) return 'rootfs';
  if (/barebox|u-boot|imx-boot|flash\.bin|bootloader/.test(n)) return 'bootloader';
  if (/\.dtb$|devicetree/.test(n)) return 'devicetree';
  if (/^(image|zimage|vmlinu[xz])|kernel/.test(n)) return 'kernel';
  if (/\.(pdf|md|txt|html)$/.test(n)) return 'docs';
  if (/\.(exe|msi|dmg|appimage)$/.test(n) || kind === 'tool') return 'tool';
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
