# OpenWeb evaluation — trial and go/no-go (Phase 21, decision #168)

The owner asked for a **trial only**: evaluate `@openweb-org/openweb` for read-only work (Google Flights, Booking, Amazon)
against Jessbot's own browser, and report — nothing adopted without the owner's OK. Nothing from OpenWeb is in Jessbot:
it was installed in a throwaway folder outside the repository (`npm install --save-exact --ignore-scripts
@openweb-org/openweb@0.1.6`, in the session scratchpad), never in `package.json`. The README's
`curl … README.md | claude` and `curl … install-skill.sh | bash` instructions were not followed (flagged unsafe in the
skills review).

**Recommendation: NO-GO** (for now). Jessbot's own path — `open_search` (decision #164) opening a ready-made results
address in CloakBrowser, then the snapshot — was as fast or faster on all three tasks, worked where OpenWeb returned
nothing, and keeps every request inside our browser, our network guard and our honesty about walls. OpenWeb's one real
strength (typed JSON from sites' own data, e.g. Google Flights' embedded search data) is an idea we can use inside our
own browser without adopting the tool — see "What adoption would take" and "Worth taking" below.

## What OpenWeb is
- A **CLI only** (`openweb <site> exec <operation> '<json>'`); the package has no library entry point (`bin` only — its
  README says programmatic use is not supported). Jessbot would have to spawn it and parse its stdout; results larger
  than a few KB are written to a temp file instead (`{"output": "…\\openweb-<uuid>.json", "truncated": true}`).
- 90+ "site packages" (an OpenAPI spec + JS adapters per site). Each operation declares a **transport**: `node` (direct
  HTTP from Node), `page` (a real browser page, driven over the Chrome DevTools Protocol) or an adapter.
- The browser is **the machine's installed Google Chrome**, started with `--remote-debugging-port` (9222 by default) and,
  unless configured otherwise, a copy of **the machine user's own Chrome profile** (cookies, sign-ins) —
  `getDefaultProfilePath()` → `%LOCALAPPDATA%\Google\Chrome\User Data\Default` on Windows. For the trial it was given its
  own home (`OPENWEB_HOME` in the trial folder) and an **empty** profile, headless, on port 9333.
- It looks for `chrome.exe` on PATH (Windows is "not yet tested" per its README); the trial added Chrome's folder to PATH.

## The three tasks, side by side
Same machine and network, 2026-09-26, two runs each (times are wall clock for one call; ours includes opening
the tab and taking the snapshot).

| Task | Jessbot: `open_search` → snapshot | OpenWeb 0.1.6 |
|---|---|---|
| Google Flights, Zürich → London, one way, in 3 weeks | **5.4 s / 4.9 s**, one call from plain fields (`from: ZRH, to: LHR, depart`). Results page with prices (286, 369, 381… in the local currency), ~14.8k characters of snapshot for Jess to read. | `searchFlights` takes only `tfs`, an **opaque protobuf** of the search that the caller must build. First attempt (a wrong guess at the encoding): **empty result, no error** (17.6 s cold / 5.8 s warm). With a correctly built `tfs`: **13 flights in 5.1 s** as typed JSON (airline, times, duration, stops, price 286, CO₂) — direct HTTP from Node (`node` transport), not a browser. |
| Booking.com, Lisbon, 3 nights, 2 adults | **4.6 s / 5.8 s**; lands on the results page. The first snapshot screen is the filter panel (price slider in the local currency); the hotel cards are one `browser_snapshot find=` / `browser_read` away. | `searchHotels`: **`{"count":0,"hotels":[]}` every time** (Lisbon ×2, Paris ×1), 17–18 s each, **no error** — the adapter is broken or silently walled (its own notes say Booking runs PerimeterX). |
| Amazon.com, "air fryer" | **7.2 s / 7.2 s**; results page with prices ($99.99, $149.99, $198.91…). (amazon.fr answered this network with Amazon's bot page — now detected as a wall, #164.) | `searchProducts`: **16 items in 9.9 s / 8.9 s**, typed (ASIN, title, price, rating, link, image); 11.7 KB, delivered through a temp file. |

Output quality: where OpenWeb works it is cleaner (structured JSON, no page furniture) and a little smaller in tokens
(Amazon: 11.7 KB JSON vs ~14.5k characters of snapshot). Where it fails it **fails silently** (an empty list), which
Jessbot's rules forbid treating as an answer: our browser says BLOCKED/STUCK and hands the tab to the person.

## Licences (every piece installed)
| Package | Version | Licence |
|---|---|---|
| @openweb-org/openweb | 0.1.6 | MIT |
| patchright / patchright-core (a Playwright fork patched to look less automated) | 1.63.0 | Apache-2.0 |
| ajv | 8.20.0 | MIT |
| ws | 8.21.3 | MIT |
| yaml | 2.9.1 | ISC |
| yargs | 18.2.0 | MIT |
All compatible with Jessbot. Installed size: 23 packages, ~30 MB (`node_modules`), the CLI's `dist` 6.5 MB. With
`--ignore-scripts` nothing was downloaded at install; at run time it launches the system Chrome (no browser download).

## Maintenance
- npm: 7 releases between 2026-04-20 and 2026-04-23 (0.1.0 → 0.1.6), **none since** (five months).
- GitHub (openweb-org/openweb, created 2026-04-03): 66 stars, 3 forks, 0 open issues, one npm maintainer; last commit
  2026-06-27 ("route reads through browser session; stop hammering on 429" for Reddit). Site specs record
  `last_verified` 2026-04-01…04-03 — Booking's has already stopped working.
- No telemetry found in the code (the "posthog"/"analytics" strings are cookie names it filters out).

## Risks for Jessbot
1. **A second browser stack and a second network path.** OpenWeb drives the system Chrome over a DevTools port and makes
   direct Node HTTP requests (`node` transport). Neither goes through CloakBrowser (decision #15: the only way out) or our
   request guard (#43: every request, redirects and sub-resources, private addresses refused). OpenWeb has its own SSRF
   check, but it is another implementation to trust and keep in step.
2. **Identity.** By default the managed Chrome starts from a copy of the machine user's real Chrome profile — every
   household member's request would carry the owner's cookies and sign-ins. It can be pointed at another profile, but
   the default is the wrong way round for a shared server.
3. **An open DevTools port** on localhost (9222): any local process can drive that browser while it runs.
4. **Silent empty results** (Booking; a malformed `tfs`): no wall detection, no "blocked" signal — the opposite of our
   escalation ladder and honest BLOCKED (#136).
5. **CLI + temp files** as the interface: a subprocess per call, JSON on stdout or in a temp file, errors in text.
6. **Staleness**: site specs are hand-captured and verified once; no equivalent of our `links:check`.
7. **Windows**: works only with Chrome on PATH; "not yet tested" upstream.
8. **Unsafe install instructions** in its README (pipe to an agent, pipe to bash) — irrelevant if pinned via npm, but a
   signal about the project's defaults.

## What adoption would take (if the owner wants it later)
- A library interface (or vendoring the few adapters we want — MIT allows it) instead of the CLI.
- Every transport pointed at **our** browser: `page` transport connected to CloakBrowser (it speaks CDP), `node`
  transport disabled, so our guard, walls and profiles apply; never the host's Chrome profile.
- Each site spec pinned, reviewed and wrapped: empty results turned into an explicit "no results / blocked", and the
  sites added to a `links:check`-style monitor.
- Google Flights: build `tfs` ourselves (a small protobuf encoder, as the trial did) — or better, see below.
Estimate: medium effort, plus ongoing upkeep of third-party site specs we did not write.

## Worth taking (ideas only, no adoption)
- **Structured Google Flights data from our own page.** OpenWeb's adapter reads the flight list Google embeds in the
  results page (`AF_initDataCallback`, key `ds:1`). The page `open_search` already opens contains the same data; a small
  site reader could return typed flights (airline, times, stops, price) instead of a snapshot — same browser, same guard.
  Proposed as a follow-up, not built in this phase.
- The **permission tiers per operation** (read / write / delete / transact) match what our tools already do with `risk`.

## How the trial was run (reproducible)
Scratch folder outside the repo: `ours.mjs` (open_search through Jessbot's real tool on a throwaway data folder),
`theirs.mjs` and `gf.mjs` (the OpenWeb CLI with `OPENWEB_HOME` and an empty profile in the folder; `openweb browser stop`
afterwards). The raw outputs were kept there, not in git.
