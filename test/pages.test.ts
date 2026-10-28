// The pure helpers of the Firmware and Images pages (public/js/release-helpers.js).

import { describe, expect, it } from 'vitest';
import { changelogFromTag, compareVersions, guessPlatform, guessRole, parseSrecName as pageParse, previousTag, toLf } from '../public/js/release-helpers.js';
import { parseSrecName as workerParse } from '../src/firmware';

describe('firmware page', () => {
  it('reads a file name exactly as the Worker does', () => {
    for (const name of ['20-10-1-6-2-0-3.srec', '20-10-3-3-1-1-0.srec', '20-30-4-2-0-2-0.srec', 'Module-Multibus.srec', '20-10-1-6-2-0.srec']) {
      expect(pageParse(name)).toEqual(workerParse(name));
    }
  });

  it('turns CRLF and lone CR into LF', () => {
    expect(toLf('S0\r\nS1\rS9\n')).toBe('S0\nS1\nS9\n');
  });

  it('takes the changelog out of a tag annotation of the deployment skill', () => {
    expect(changelogFromTag('RELEASE_DATE: 27/04/26\nDEPLOY_FILES: 20-20-2-7-2-3-1.srec\n\nImprovement on supply rail precharge mechanism\n'))
      .toBe('Improvement on supply rail precharge mechanism');
  });

  it('finds the previous version tag', () => {
    const tag = (name: string) => ({ name, commit: name, annotated: true, message: null, date: null });
    const tags = [tag('v2.0.0'), tag('v2.0.10'), tag('v2.0.9'), tag('v2.1.0'), tag('release/x'), tag('v2.0.3-rc1')];
    expect(previousTag(tags, '2.1.0')?.name).toBe('v2.0.10');
    expect(previousTag(tags, '2.0.0')).toBeNull();
    expect(compareVersions('2.0.10', '2.0.9')).toBe(1);
  });
});

describe('images page', () => {
  it('guesses what a file is and what it runs on', () => {
    expect(guessRole('rootfs13_headless.ext4.zst', 'image')).toBe('rootfs');
    expect(guessRole('barebox-gocontroll-mini-111.img', 'image')).toBe('bootloader');
    expect(guessRole('flash_mini_111.ps1', 'tool')).toBe('script');
    expect(guessRole('imx-usb-loader.exe', 'tool')).toBe('tool');
    expect(guessRole('README.pdf', 'tool')).toBe('docs');
    expect(guessPlatform('flash_mini_111.ps1')).toBe('windows');
    expect(guessPlatform('flash_mini_111.sh')).toBe('linux');
    expect(guessPlatform('rootfs.ext4')).toBe('any');
  });
});
