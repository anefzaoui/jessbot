# The web — how Jess reads and searches

Everything Jess sees of the web goes through her private browser (CloakBrowser, decisions #15, #43), with one exception:
an optional SearXNG search engine the admin runs (below, #138). This page covers what `web_read` and `web_search` do
since Phase 21 (decisions #135–#138), and the browser side added after (#164–#168: ready-made searches, learned site
recipes, uploads, screenshots, the autopilot's domain lock, trust warnings, ad blocking). Code: `src/browser/` (`read.js`,
`walls.js`, `site-readers/`, `news.js`, `searxng.js`, `profiles.js`, `links.js`, `recipes.js`, `trust.js`, `adblock.js`),
`src/lib/deeplinks.js`, tools in `src/agent/tools/web.js` and `browse.js`.

## Reading a page (`web_read`)
1. **Site readers** (`src/browser/site-readers/`, one file each, a small table in `index.js`). A reader that fails for any
   reason hands over to the generic reader; nothing is lost.
   | Address | What Jess gets |
   |---|---|
   | YouTube `watch`, `youtu.be`, `shorts`, `live`, `embed` | Title, channel, length, views, description and a **transcript** from the video's captions: the person's language first, captions written by people over automatic ones; the transcript is made by `lib/captions.js` (shared with uploaded .srt/.vtt files: rolling automatic lines kept once) in ~30 s paragraphs stamped `[m:ss]`. No captions → said plainly. YouTube's caption files now need a token only its player makes: when the plain fetch is empty, the page's "Show transcript" panel is opened and its token fetches the chosen track; last resort, the panel's own lines. Media is never downloaded. |
   | X / Twitter status links | The post from FxTwitter's public API (`api.fxtwitter.com`, fetched through the browser): author, date, counts, text with real links, photos/videos (with alt text), polls, community notes, X articles and the quoted post. The address stays `x.com`. Replies are not available: said so. |
   | Reddit threads (`reddit.com/r/…/comments/…`, `redd.it`) | The thread's own `.json`, fetched from inside the thread page (same browser session): the post, then the top 20 comments by score (text cut at 600 characters) with their two best replies; moderator and removed comments left out. Read-only. Reddit often challenges automated visitors: the ladder below then says BLOCKED honestly. |
2. **What the answer is** (any address): a **PDF** (by Content-Type or its first bytes) is read with the same extraction
   as uploads (reading order, right-to-left lines), up to 25 MB, as text with `--- page N ---` markers; title, author and
   dates come from the PDF's info; a PDF without a text layer is called scanned, never guessed at. The bytes come from
   inside the page (the PDF viewer's own address, same origin, same network guard). `save: true` also keeps the PDF in the
   person's Library ("Downloaded from <host>"), so `pdf_form_fields` / `pdf_fill_form` work on forms found online.
   **Feeds** (RSS, Atom, RDF, JSON Feed) show their newest 50 items as `- [date] [title](link) — summary` (≤ 200
   characters), newest first; an **OPML** list shows its feeds by folder. Other JSON and text come back as they are.
   A link that downloads a file (instead of showing a page) is sent to `browser_open`, whose downloads reach the Library.
3. **The generic reader** (Readability → markdown, hidden text left out, #118) for everything else.

### The escalation ladder (`walls.js`, #136)
One wall detector for `web_read` and the interactive browser: the title, the first ~1,500 characters of visible text and
the page's frames. Text-only signals count only on a short page (a challenge page is short; an article about Cloudflare
is not a wall). 200-status challenge pages are caught too (Reddit's "Prove your humanity", Cloudflare's "Just a
moment…"); a 403/429 answer is a block; a long 503 is an error page, not a wall.
1. An incognito tab. A check that **solves itself** (Cloudflare's "Just a moment…", DDoS-Guard, Vercel, Reddit's script
   check) gets up to **12 s**; a full-page **consent screen** (Google/YouTube/Yahoo) is declined. When the check passes,
   whatever stands now is read — a PDF behind Cloudflare is read as a PDF.
2. Still walled: **one retry with the person's own browser cookies** (read-only: nothing is written back) and images on,
   like a normal browser.
3. Still walled: `BLOCKED: <host> answered with <wall> …` — shown as a result, never as page content, telling Jess to use
   `browser_open` (where the person can take over the tab) or another source. The host then **rests for 30 minutes**:
   another read in that time answers BLOCKED at once, saying until when.

Pages are cached for 15 minutes under a normal form of their address (no `www.`, tracking parameters, `#fragment`,
trailing slash or AMP wrapper), so `start=` continues without reloading.

## Searching (`web_search`, #137)
- **Engines:** SearXNG first when configured and healthy, then the admin's list (DuckDuckGo → Brave → Bing by default,
  #16); an engine the person names comes first ("search Google" → Google, then Startpage's Google results, #65). An engine
  that shows a captcha wall rests for 3 hours; SearXNG rests 5 minutes after a failure.
- **`freshness: day | week | month | year`** goes to each engine its own way: DuckDuckGo `df=d|w|m|y`, Brave `tf=pd|pw|pm|py`,
  Bing `filters=ex1:"ez1|ez2|ez3"` (a year is a custom `ez5_<from>_<to>` day range), Google `tbs=qdr:d|w|m|y`, Startpage
  `with_date=d|w|m|y`, SearXNG `time_range=day|week|month|year`, Google News `when:1d|7d|30d|1y`.
- **`kind: "news"`** searches Google News (its RSS search, fetched through the browser) in the person's edition: the
  `language` they write in and the country of their primary place (`browser/news.js`; unknown pairs fall back to the
  language's main edition, then US English — the Feed uses the same editions, see FEED.md). Each item is dated and
  names its outlet.
- **`kind: "reference"`** searches Wikipedia in the person's language (English when there's nothing), dated by last edit.
  Wikipedia is also the **last resort** when every engine failed — said as such — instead of "No results".
- **`check: true`** asks the first two healthy engines and merges their results by normal address: pages both found come
  first, tagged `[found by 2 engines]`, and the result says how many different sites (registrable domains) they come from.
- Searches are cached for 10 minutes (same words, kind, freshness, language, country).

## SearXNG (optional, #138)
SearXNG is a self-hosted metasearch engine (AGPL-3.0): it asks many engines at once and answers JSON. The owner approved
it as an exception to "the browser is the only path to the internet" (#15/#23), like mail and calendar servers (#77):
Jessbot reaches the admin's own instance **directly** (Node `fetch`, `format=json`), and the instance makes the requests to
the search engines. Result pages are still read through the browser.
- **Admin → Browser → SearXNG address** (e.g. `http://127.0.0.1:8888`). A new address is tested with a real query before
  it is saved; errors are explained ("add json to search.formats", "connection refused — is it running?"). Empty = off.
  Stored in the `browser` settings (`searxngUrl`).
- **Local install** (this computer, bound to 127.0.0.1, never committed — `tools/` is gitignored):
  ```
  npm run searxng:install                 # Python 3.10+ needed; downloads the pinned commit, makes tools/searxng/venv
  npm run searxng:start -- --background   # log tools/searxng/searxng.log, pid tools/searxng/searxng.pid
  node scripts/searxng.js status | stop    # stop uses the saved pid, never a name
  ```
  The script downloads GitHub's archive of a **pinned commit** (`PINNED` in `scripts/searxng.js`), installs SearXNG's
  own requirements (and `tzdata`) into a virtual environment and writes `tools/searxng/settings.yml`: `use_default_settings`,
  bound to 127.0.0.1 on a free port (8888 when free), JSON on, limiter off (the only client is this computer), no image
  proxy, no Valkey, and a secret key generated on the spot. An existing `settings.yml` is kept (`--reset` rewrites it). It
  runs under granian, SearXNG's production server.
- **Windows** runs it natively (verified on Windows 11 with Python 3.13). Two things differ from Linux: four Linux service
  templates whose names contain `:` are skipped when unpacking (Windows can't store them; SearXNG doesn't need them), and
  a tiny `pwd` module shim (`tools/searxng/compat/pwd.py`) stands in for the Unix-only module SearXNG imports only to name
  the user in a Valkey error message.
- **Linux / macOS / WSL:** the same two commands. **Docker** instead: `docker run -d -p 127.0.0.1:8888:8080
  -v ./searxng:/etc/searxng searxng/searxng`, then in `./searxng/settings.yml` add `json` to `search.formats` and set
  `server.limiter: false`; put `http://127.0.0.1:8888` in Admin → Browser.
- The instance does not start with Jessbot: start it after a reboot (or run it as a service). When it is down, searches
  simply use the browser engines.

## Saved sign-ins (#136)
Each person's browser keeps its cookies and site storage between sessions (`data/browser-profiles/u<id>.json`, #56) —
including sign-ins they made during a hand-over. These files are **sealed** (AES-256-GCM with the install's key from
`.env`, `lib/secrets.js sealData`); an older plaintext file is sealed the first time it is read, and a file that can't be
unsealed (another key) starts that browser fresh. The search engines' cookie jar (`search.json`) is sealed the same way.
`GET /api/v1/me/browser/sites` lists the sites a person is signed in to (registrable domains with sign-in-looking cookies,
not analytics or bot-check passes) and `DELETE /api/v1/me/browser/sites/:site` forgets one — from their live browser
first, then from the file. The "Signed-in sites" screen comes in Phase 25.

## Ready-made searches (`open_search`, #164)
`src/lib/deeplinks.js` builds results addresses from plain fields — pure code, unit-tested — and `open_search` opens one in
the chat's browser tab like `browser_open`, returning the snapshot in **one step** (Google Flights Zürich → London: ~5 s,
one call, instead of 18 steps / 64 s through the form). Inputs are checked first: dates as YYYY-MM-DD and not before the
person's today (their home's time zone), return on or after departure, checkout after checkin, children as ages 0–17
(under 2 = infant; an infant needs an adult), ISO currencies, airport codes. Each site gets its own encoding: Skyscanner
`YYMMDD` dates and `childrenv2=7|4`, Booking's repeated `age=`, Kayak's `children-7-1L`, Ryanair's adults 16+/teens
12–15/children 2–11/infants, Amazon's price filter in cents. What a link can't carry (travellers on Google Flights, dates
on Google Hotels, sort on Noon) comes back as a note — "set it on the page" — never silently dropped.

| Area | Sites (`site`) |
|---|---|
| Flights | `google_flights` (q-link; takes city names too), `skyscanner`, `kayak`, `ryanair` (flight select), `ryanair_fare_finder` (cheapest in a window, `ANY` destination) |
| Stays | `airbnb`, `booking`, `google_hotels` |
| Places | `google_maps`, `google_maps_directions` (Google's documented `api=1` URLs), `overpass` (OpenStreetMap: real places near a point — the person's home by default — listed nearest first with distances worked out in code) |
| Shopping | `amazon` (the country's own site: much of North and West Africa → amazon.fr), `noon` (UAE, Saudi, Egypt), `jumia` (its African sites), `argos`, `google_shopping` |
| Jobs · events | `linkedin_jobs`, `indeed` (the country's site), `eventbrite`, `meetup` |
| Parcels | `parcel` (carrier from the number's shape, else 17track), `track17`, `parcelsapp`, `ups`, `fedex`, `dhl`, `usps`, `laposte`, `aramex` |
| Scholarly | `google_scholar`, `pubmed`, `arxiv`, `semantic_scholar` and `crossref` (their data APIs, read like `web_read`) |

Shops default to the person's country (`shopsFor`: Senegal → jumia.sn, amazon.fr), and the result names the other
shops that serve it. Data recipes (Overpass, Semantic Scholar, Crossref) are read through the browser, fenced like
`web_read`; Overpass tries three public instances in turn (the main one answered this network 406; VK's is left out on
purpose — the query carries the home's coordinates).

**`npm run links:check [-- site …]`** opens one sample search per site in the same browser and records the verdict in
`<data>/deeplinks-state.json` (never git): **ok**, **broken** (an error status, the home page, an empty page, another site,
no results) or **blocked** (a bot wall, or a whole site that refuses this browser — its home page fails too: the recipe
may be fine). Only *broken* switches a recipe off: `open_search` then opens the site's own search page and tells Jess to
use its form; a later *ok* switches it back on. It reads the database without migrating (safe with Jessbot running).
First run here (2026-09-26): 27 of 34 ok; blocked: Skyscanner (PerimeterX), Google Shopping (bot check), Semantic Scholar
(429), the Overpass instances (406 / no answer), and Amazon (amazon.fr's soft block, now a wall rule in `walls.js`), Jumia
(410 for every page) and USPS (blank pages), which refuse this network as a whole.

## Learned site recipes (#165)
When Jess types into a site's own form and lands on a results address with parameters (by hand or with the autopilot),
the address's **shape** is kept in `site_recipes` (migration 040): host, path with slots and parameter names with slots —
`{query}` for what she typed, `{date}`, `{number}`, `{value}` — **never the values** (the shape is shared by the
household; what one person searched for is not). Session and tracking parameters (`sid`, `token`, `*session*`, `utm_*`,
`gclid`, `fbclid`, Booking's `aid`/`label`…) and opaque state blobs (Google Flights' `tfs=`) are dropped; an address where
what she typed doesn't appear is not a search address and isn't kept; a capitalised path segment she didn't type counts
as a value. Opening that site later (`browser_open`) adds "Known results URL shape on booking.com (… worked 4×):
https://www.booking.com/searchresults.html?ss={query}&checkin={date}…". Opening an address of that shape counts as a
success (it kept its parameters) or a failure (an error, or it went to the home page); a bot wall counts as neither;
**two failures in a row delete the recipe**.

## More browser tools (#166)
- **`browser_upload({ ref, library_id, site })`** attaches one of the person's **own** Library files to a file field (a
  real `<input type=file>`, one inside the ref, or the file chooser a styled "Upload" button opens). Risk *external*: it
  asks like sending an email (only the person's own "Always allow" skips that, never after the task read outside
  content), and the card names the file and the site ("Reaches: the website jobs.example.com", can't be undone). The
  run refuses someone else's file (no card that would name it) and refuses when the open page is no longer on the site
  the person approved. The autopilot still never sees file fields — uploads are the main loop's, with this approval.
- **`web_screenshot`**: `full_page` (the whole length; lazy images loaded by scrolling first; cut at 15,000 px, and said
  so), `mobile` (390×844 at 2×, touch, the page's phone layout) and `save_pdf` (the page printed to an A4 PDF with
  `services/print.js`'s options and font wait, kept in the Library as "Downloaded from <host>").
- **The autopilot's domain lock**: it records the site (registrable domain) it starts on; landing on another site stops it
  — "blocked: it left google.com for skyscanner.net…" — unless the goal named that site (its domain, or its name as a word)
  or it is a sign-in or payment hand-off (Google/Microsoft/Apple sign-in, Facebook's login pages, PayPal, Stripe, Adyen,
  Klarna, 3-D Secure providers, ClicToPay…: `HANDOFFS` in `agent/autopilot.js`); then it goes on and says where it went.
- **Snapshots shrink by priority**: a page over the 14k budget first loses its link targets, then keeps every line with a
  ref, every heading and their ancestors while each run of plain text shrinks to its first line and "… N more lines of
  text" (then to the marker alone); only then is the end cut, at a line. `browser_read` gives the text.

## Domain trust warnings (#167)
`src/browser/trust.js` (tldts), warn-only — nothing is ever blocked: look-alike letters (punycode; mixed alphabets like
`раураl.com`; a skeleton that spells a brand), a bare IP address, a brand's name on someone else's domain
(`paypal.com.secure-login.xyz`, `dhl-delivery-fee.com`) or swapped characters (`paypa1.com`), a password asked over http,
and a redirect chain through other sites (the main-frame navigations of the last action). Brands = a built-in list with
each brand's own other domains + the person's email domain, their mail/calendar connection domains and the sites they're
signed in to. On a sign-in or password page Jess gets `CAUTION: …` right under the LOGIN/SIGN-IN line; the hand-over
viewer's data (`GET /api/v1/threads/:id/browser`) always carries `site` and `warnings`.

## Ad and tracker blocking (#168, off by default)
Admin → Browser → "Block ads and trackers". Ghostery's engine (`@ghostery/adblocker`, MPL-2.0) with EasyList, EasyPrivacy
and uBlock Origin's lists, matched **inside the existing request guard**, after the network check (never the library's
own in-page blocking, which would install a second interception beside the SSRF guard). Pages Jess opens herself are
never blocked; ad frames, scripts and trackers are (matched scripts may be replaced by the lists' harmless stand-ins).
The lists are fetched through the browser itself and kept compiled in `<data>/adblock/engine.bin` for a week; pages
don't wait for them. A site that asks for the blocker to be turned off gets it switched off for 30 days (Jess is told to
reopen the page). Measured here (two runs each, averaged): lemonde.fr first load 1.75 → 1.43 s and network quiet after
16.8 → 2.6 s; allrecipes.com 1.43 → 1.01 s, quiet 16.4 → 2.4 s, 305 → 44 requests; theguardian.com 1.58 → 1.45 s,
quiet 2.6 → 2.6 s (already quiet). "16 s" means never quiet within the 15 s wait: trackers keep polling. Pages opened
only to be read (and every interactive session) ask for **reduced motion**; screenshots and prints keep the page's normal
look.

## OpenWeb (evaluated, not adopted)
A trial against `@openweb-org/openweb` on the same read-only tasks ended **no-go**: docs/OPENWEB-EVALUATION.md.
