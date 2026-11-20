// CHANGELOG.md (Keep a Changelog, semver) as data (#13): the release script stamps it, the server turns each release into a
// "What's new" draft, and the release workflow takes a release's notes from it. One parser for the three.
//
//   ## [Unreleased]
//   ### Highlights            ← plain lines for the people who use it (What's new shows these, at most 6)
//   - You can …
//   ### Added / Changed / Fixed / Security   ← the full list, for admins and the release page
//   ## [0.2.0] - 2026-12-01
const HEAD = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const SUB = /^### (.+?)\s*$/;
export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Compare two versions (semver, pre-releases before the release) → -1 | 0 | 1. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a)), pb = SEMVER.exec(String(b));
  if (!pa || !pb) throw new Error(`Not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

/** text → [{ version, date, body, sections: { Highlights: [lines], Added: [...] }, start, end }] in file order. */
export function parseChangelog(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let cur = null, section = null;
  lines.forEach((line, i) => {
    const h = HEAD.exec(line);
    if (h) {
      if (cur) cur.end = i;
      cur = { version: h[1], date: h[2] || null, start: i, end: lines.length, sections: {} };
      section = null;
      out.push(cur);
      return;
    }
    if (!cur) return;
    if (/^\[[^\]]+\]:\s/.test(line)) { cur.end = Math.min(cur.end, i); return; } // link references at the bottom
    const s = SUB.exec(line);
    if (s) { section = s[1]; cur.sections[section] ||= []; return; }
    const item = /^[-*] (.+)$/.exec(line);
    if (item && section) cur.sections[section].push(item[1].trim());
    else if (/^\s{2,}\S/.test(line) && section && cur.sections[section].length) {
      const list = cur.sections[section];
      list[list.length - 1] += ` ${line.trim()}`; // a wrapped bullet
    }
  });
  for (const r of out) r.body = lines.slice(r.start + 1, r.end).join('\n').trim();
  return out;
}

/** The released versions (not Unreleased), newest first. */
export const releases = text => parseChangelog(text).filter(r => SEMVER.test(r.version))
  .sort((a, b) => compareVersions(b.version, a.version));

/**
 * Stamp the Unreleased section as `version` (dated) and open a new empty Unreleased above it; update the compare links
 * when the file has them. → the new text. Throws when there is nothing unreleased to stamp, or the version exists.
 */
export function stampRelease(text, version, date, repoUrl = null) {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version}`);
  const all = parseChangelog(text);
  if (all.some(r => r.version === version)) throw new Error(`CHANGELOG.md already has ${version}.`);
  const unreleased = all.find(r => /^unreleased$/i.test(r.version));
  if (!unreleased || !unreleased.body.replace(/^###.*$/gm, '').trim()) throw new Error('CHANGELOG.md has nothing under [Unreleased] to release.');
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  lines.splice(unreleased.start, 1, '## [Unreleased]', '', `## [${version}] - ${date}`);
  let out = lines.join('\n');
  if (repoUrl) {
    const prev = releases(text)[0]?.version;
    out = out.replace(/^\[Unreleased\]:.*$/m, '').replace(/\n+$/, '\n');
    out += `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD\n`
      + `[${version}]: ${prev ? `${repoUrl}/compare/v${prev}...v${version}` : `${repoUrl}/releases/tag/v${version}`}\n`;
  }
  return out;
}
