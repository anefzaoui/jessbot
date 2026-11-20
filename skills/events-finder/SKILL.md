---
name: events-finder
description: 'Finding things to do that fit them: concerts, exhibitions, workshops, festivals, meetups, talks, markets, matches or family outings this weekend, on a given date, near home or where they''re travelling. Use for "what''s on this weekend?", "anything fun for the kids on Saturday?", "concerts in Lisbon in October". Adds registration links, calendar entries and reminders.'
toolsets: [web]
---

# Events finder

1. **Who and what.** Where (home, or the city they'll be in), when, who's going (children's ages), interests, budget
   and how far they'll travel. `recall` first; ask once for what's missing and `remember` lasting tastes.
2. **Search wide, in the local languages.** `web_search` with `freshness: "week"` or "month": "<topic> <city> this
   weekend", "sortir ce week-end <ville>", "فعاليات <city>". `open_search` with `site: "eventbrite"` or
   `"meetup"`, a `query` and the `city` (and `country` when travelling). Also the city's or tourism office's agenda,
   cultural centres, museums, venues and ticket sellers.
3. **Check each one** with `web_read`: date, time, venue and address, price, ages it suits, how to register or buy,
   and whether it's sold out. Drop past, unconfirmed and duplicate listings. Outdoors: `get_weather` for that day;
   `get_holidays` for closures and crowds.
4. **Offer 3–6,** grouped by day, each with one line on why it fits them, the price and the link.
5. **When they pick one:**
   - the registration or ticket link, or go through it together in the browser; submitting or paying goes through the
     approval card;
   - a calendar entry (`calendar_create_event` if they have a calendar, approved; otherwise `make_calendar_file`);
   - reminders if they have schedules: `set_reminder` the day before, and a leave-by one with the travel time.
6. **A weekly digest, if they want it:** `schedule_task` on Thursdays at 18:00 (`cron: "0 18 * * 4"`), "family-friendly
   events this weekend in <city> for kids aged 6 and 9, under 30 EUR each; skip ones already suggested". It runs on its
   own and reports.

| Excuse | Reality |
|---|---|
| "There's a festival on" | Only with a date, place and source you read. |
| "Suitable for kids" | Say the age the organiser gives, or "not stated". |
| "Free entry" | Check for booking fees or registration. |

## Done when
- Every event was confirmed on its own page: date, time, place, price.
- Past, sold-out and duplicate events are gone.
- Each suggestion says why it fits them.
- Sign-ups and payments went through the approval card; calendar and reminders were offered.

Sources: householdA events-finder (OpenClaw whats-on idea); own words.
