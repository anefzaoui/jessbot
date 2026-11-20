---
name: public-transport
description: 'Buses, trams, metro and trains: the coming departures from their stop, "is my line running?", strikes and disruptions, journey planning with changes and platforms, the last train home, and ticket or pass prices, from the operator''s own website. Use for "when''s the train to…", "how do I get to the airport by bus?", "is the metro on strike tomorrow?".'
toolsets: [web]
---

# Public transport

1. **Their usual stops and lines.** `recall` their commute, stops and lines; when they mention new ones, `remember`
   them (a stop with `kind: "place"`, a commute with `kind: "schedule"`).
2. **Go to the source.** The operator's own journey planner, live departures or service-status page (city transport,
   national rail, regional buses). Search in the local language too ("horaires", "مواعيد القطار", "Fahrplan").
   Google Maps transit directions (`open_search` with `site: "google_maps_directions"` and `mode: "transit"`) are a
   cross-check, not the authority.
3. **Coming departures.** Open the live departures page with `browser_open`, type the stop with `browser_type` and
   `pick` the right suggestion, and read the times: HH:MM, platform or stand, and delays. Say whether a time is live
   (real-time) or only the timetable.
4. **Planning a journey.** From, to, and "leave at" or "arrive by". Give 2 options: departure and arrival, changes with
   walking time between them, total time, and the price if shown. For late trips, the last connection of the night.
   Check the day: public holidays (`get_holidays`) and Sundays often run a different timetable, and so does Ramadan in
   many places.
5. **Disruptions and strikes.** The operator's service-status or news page, plus `web_search` with `kind: "news"` and
   `freshness: "day"` ("grève", "إضراب", "strike" with the line). Give the source and the time you checked.
6. **Tickets and passes.** Fares, day or monthly passes, child and senior discounts, and where to buy (app, machine,
   on board, cash or card), from the operator's page. Jess doesn't buy; if they want to buy online together, the
   payment goes through the approval card.
7. **A heads-up for a regular trip** (offer it for a commute or a strike-prone line): `schedule_task` on their travel
   days before they leave, for example `cron` "30 6 * * 1-5", with `only_when: "a delay, cancellation or strike
   affects line 5 between 07:00 and 09:00"`. The instructions name the operator's status page, the line and the hours.
8. **Reply short:** "Next: 08:12 (platform 2, on time), then 08:27. Live times from <operator>, checked 07:55."

| Excuse | Reality |
|---|---|
| "Trains run every 15 minutes" | Read today's departures; holidays change them. |
| "The app says…" (third-party) | Check the operator's own page when it matters. |
| "No news means no strike" | Search news for today and read the operator's notice. |

## Done when
- Times come from the operator's page (or a named cross-check), marked live or timetable.
- Journeys show changes, walking, total time and the last connection when it matters.
- Disruptions were checked for the day of travel, with the source and time.
- Nothing was bought without them and the approval card.

Sources: volt-life public-transport (OpenClaw tfl and transit skills; ideas, own words).
