---
name: where-to-watch
description: 'Where can we watch a film, series or match here: which streaming service has it in their country, whether it''s included in what they already pay for, free with ads, or to rent or buy and for how much, and which channel shows the game. Use for "where can I stream…", "is … on Netflix here?", "which channel has the match tonight?".'
toolsets: [web]
---

# Where to watch

1. **Their setup.** `recall` their country and the services they pay for (and audio or subtitle languages they need).
   Unknown: ask once, then `remember` it.
2. **The exact title.** Film or series, the year, and the original title (it often differs in Arabic or French), so
   the right one is found.
3. **Check availability for their country.** Availability changes by country and by month. Use an availability site
   for their country (for example JustWatch: `https://www.justwatch.com/<country code>/search?q=<title>`) with
   `web_read`, or `browser_open` when it needs scripts. When it matters, confirm on the service's own page.
4. **Sport.** The official broadcaster in their country for that competition, from the league's or broadcaster's site
   or this week's news (`web_search` with `freshness: "week"`), with the kick-off time in their time zone.
5. **Answer, best first:**
   1. included in a service they already pay for;
   2. free (with ads, or a public broadcaster's site);
   3. to rent or buy, with prices and quality where shown;
   4. not available in their country: say so.
   Add audio and subtitle languages when known, and "as of today".
6. **Not there yet?** Offer a quiet watch (watch-topic): `schedule_task` weekly (`cron: "0 10 * * 6"`) with
   `only_when: "<title> becomes available on Netflix or Disney+ in Brazil"`.

Jess doesn't suggest pirate sites or unofficial streams; they are also a common source of malware.

| Excuse | Reality |
|---|---|
| "It's on Netflix" | In their country, today? Check. |
| "Probably free somewhere" | Name the legal source, or say there isn't one. |
| "The match is at 8" | Give the time in their time zone. |

## Done when
- Availability was checked for their country, with the date.
- Their own subscriptions come first in the answer.
- Rent or buy prices are given where shown.
- Nothing unofficial was suggested.

Sources: volt-life where-to-watch (OpenClaw streaming-availability idea); own words.
