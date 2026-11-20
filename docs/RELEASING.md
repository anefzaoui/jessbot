# Releasing Jessbot

How a version is made, numbered and published, and how its notes reach the people who use it.

## Versions

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. While Jessbot is 0.x, a minor version (0.2.0) carries new
features and may change how things work (its notes say what to do); a patch (0.2.1) only fixes. Tags are `v<version>`.
The version lives in `package.json` (Admin → System shows it).

## Every change

Add a line under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md), in the section that fits: `Added`, `Changed`,
`Fixed`, `Removed`, `Security`. Security fixes stay as vague there as in the commit (SECURITY.md). For anything people
would notice, also add a plain line under `### Highlights`: what someone can now do, in words a family member would use,
no jargon, at most six for a release. Those lines become the in-app "What's new".

## Making a release

1. On an up-to-date `main` with a clean tree, see what it would do: `npm run release -- 0.2.0 --dry-run`.
2. Make the release commit: `npm run release -- 0.2.0`. It turns `[Unreleased]` into `[0.2.0] - <today>` (a new empty
   Unreleased opens above it), sets the version in `package.json` and `package-lock.json`, and commits
   `Release v0.2.0` with the notes in the message. It refuses a dirty tree, another branch (`--any-branch` to make the
   release on a branch and merge it by pull request), a version that isn't newer than the last tag, an existing tag,
   or an empty Unreleased.
3. Push the commit (or open its pull request and merge it).
4. When ready to publish, tag that commit: `git tag -a v0.2.0 -m "Jessbot v0.2.0"` and `git push origin v0.2.0` (or
   run step 2 with `--tag` to tag at once). Pushing the tag publishes:
   - the GitHub release with the version's notes from CHANGELOG.md (`.github/workflows/release.yml`; it fails, publishing
     nothing, when the tag doesn't match `package.json` or CHANGELOG.md has no dated section for it);
   - the container image `ghcr.io/<owner>/jessbot:<version>` for amd64 and arm64 (`.github/workflows/docker.yml`).

## What's new, in the app

When an install starts on a new version, each release in its CHANGELOG.md that is newer than the one it last saw becomes
a draft in Admin → System → What's new: the Highlights as its lines, the rest as the list it was made from (without
Highlights, a background model drafts a few lines from that list). The admin edits, publishes or discards it; everyone
sees a published note once, in their chat. A new install, or the first start of a version that has this, records its
version and shows nothing from before (`services/whats-new.js importChangelog`, `settings.whatsNew`).
