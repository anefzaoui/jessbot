---
name: flight-deals
description: 'Hunting for cheap or well-timed flights: flexible dates, "the cheapest weekend in October", "anywhere under €100 from Paris", comparing fares across sites and judging connections; or keeping a quiet eye on a fare, or on a flight''s status (delay, gate, cancellation), and saying something only when it changes. For planning a whole trip, use trip-planner.'
toolsets: [web]
---

# Flight deals

1. **Frame the search.** You need:
   - from: their home airport (`recall`); a city means all its airports (London: LHR, LGW, STN, LTN, LCY; Paris:
     CDG, ORY; New York: JFK, EWR, LGA);
   - to, or "anywhere";
   - dates, or a window plus trip length ("a long weekend in October");
   - travellers (adults, each child's age, infants), cabin, bags, budget and currency.
   One `ask_user` for what you can't infer; assume the rest and say so.
2. **Open results in one step.** `open_search` with `site: "google_flights"`, `from`, `to`, `depart`, `return` (left out
   for one way), `adults`, `children` as ages (`[7, 4]`), `cabin`, `currency` and `nonstop: true` when they want direct
   flights only; then cross-check one more site (`site: "skyscanner"` or `"kayak"`) with the same fields. The result
   says what a link couldn't carry (travellers on Google Flights, the currency on Kayak): set it on the page. When a
   site's link stopped working, its own search page opens instead: hand the form to `browser_autopilot` with a complete
   goal ("…for 2 adults and a child of 7; stop when results are visible; do not select or book").
3. **"Anywhere cheap" and flexible dates.**
   - From an airport Ryanair serves, its fare finder: `open_search` with `site: "ryanair_fare_finder"`, `from`,
     `to: "ANY"` (or a code), `date_from` and `date_to` (the window), `nights_min` and `nights_max`, `day_of_week`,
     `max_price`, `currency`, `one_way` when it is.
   - The same by hand, when you need the departure and return hours too: `https://www.ryanair.com/gb/en/fare-finder?`
     with originIata, destinationIata (a code or ANY), isReturn, dateOut and dateIn (the search window, not the travel
     dates), nightsFrom and nightsTo (trip length), dayOfWeek (MONDAY to SUNDAY, empty for any), adults, teens,
     children, infants (Ryanair counts adults 16+, teens 12–15, children 2–11, infants under 2), outboundFromHour,
     outboundToHour, inboundFromHour, inboundToHour (HH:MM), priceValueTo (the budget), currency, and
     isExactDate=false. A weekend away: dayOfWeek FRIDAY, outbound 00:00–11:00, inbound 13:00–23:59, nights 1–2.
   - Elsewhere: Google Flights' date grid or price graph on the results page, Skyscanner's whole-month view, or ±3 days.
   - Check the airport is on the airline's network before promising a low-cost answer.
4. **Read the prices back.** `browser_snapshot` with `find` set to the currency sign. For each option: airline, times,
   stops, total duration, the total for all travellers, bags included or not, and change or refund rules. Add bag and
   seat fees to low-cost fares before comparing. If Google Flights says prices are currently low, typical or high,
   report it.
5. **Judge the connections:** nonstop is a plus; under 60 minutes international (45 domestic) is risky; a layover over
   4 hours is a minus; departures before 06:00 and red-eyes are minuses, more so with kids; flag separate tickets
   ("self-transfer") and airport changes. Going east across 3 or more time zones is harder: an afternoon or evening
   arrival before an important day helps.
6. **Three options:** cheapest, best, fastest, in a table with the total, the site and "seen at <time>; fares change".
   Recommend one and say why.
7. **A fare watch** when they want to wait: `schedule_task` titled like "Lisbon–Paris fare", `cron` at most twice a day,
   `only_when: "the total for 2 adults is under 900 EUR or 5% cheaper than last time"`, `watch_url` set to the results
   link, `until:` the last sensible booking day. The instructions must stand alone: route, dates, travellers, bags, the
   link, the price you saw and when, and to report the new total, the site and the link.
8. **Watching a booked flight** ("keep an eye on AF1234 tomorrow"): the date is the departure date. Find its status on
   the airline's own flight-status page (`web_search`), read it now and give a status card: flight, route, scheduled
   and estimated times, terminal and gate, status. Then `schedule_task` with `only_when: "a delay of 15 minutes or
   more, a gate or terminal change, a cancellation or diversion"`, `watch_url` the status page and `until:` the flight
   date. Watches check at most every 2 hours, so for the last hours before boarding the airline's app or texts are
   faster: say so.
9. **Booking** only when they ask: go through to the payment page together; the payment itself is theirs, on the
   approval card or typed by them on the page (`ask_user` with `show_screen`). Card details never go in the chat.
   After booking, offer trip-organizer (itinerary, calendar, check-in and passport reminders).

| Excuse | Reality |
|---|---|
| "Flights from around €90" | Give the real total you saw, with bags, and when. |
| "This one is cheapest" | Only after adding bags and seat fees to every option. |
| "A 50-minute connection is fine" | Risky internationally: say so, or find a safer one. |
| "I'll check every 10 minutes" | Watches run at most every 2 hours; say what's faster. |

## Done when
- The search used their real airports, dates and travellers (or said what was assumed).
- Three options are shown with totals including bags, the source site and when the price was seen.
- Connections are judged against the rubric.
- A watch, if set, has a clear condition, a link and an end date.
- Nothing was booked or paid without them and the approval card.

Sources: householdA flight-deals (OpenClaw flight-search, google-flights and Ryanair fare-finder skills; the fare-finder parameter recipe imported); volt-life flight-watch (ideas, own words).
