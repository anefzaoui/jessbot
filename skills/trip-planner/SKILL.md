---
name: trip-planner
description: 'Planning a trip or a day out: where to go, flights, trains or a road trip, places to stay, a day-by-day itinerary with times and costs, what to know before going (visas, money, SIM, plugs), and the bookings to make. Use for "plan our trip to…", "organise un voyage à…", "خطط لنا رحلة".'
toolsets: [web]
examples:
  positive:
    - "Plan a 5-day trip to Istanbul for the family in April"
    - "Organise-nous un voyage à Tozeur avec les enfants"
    - "خطط لنا رحلة إلى روما في الصيف"
  negative:
    - "Find the cheapest flight to Paris in October"
    - "I've booked everything, put the confirmations together"
---

# Trip planner

1. **The frame.** You need: from where, to where, dates (or how flexible), who's going (kids? mobility?), budget and the
   purpose (rest, sightseeing, family, work). `recall` their travel preferences, places they wished to visit and places
   already visited. Ask only for what you can't infer, in one `ask_user` with options, not a chain of questions.
2. **Check the dates.** Their calendar for clashes (if connected), public holidays at both ends with `get_holidays`
   (crowds, closures, price peaks), and the weather with `get_weather` (for months ahead, last year's weather for those
   days via `history`).
3. **Real options, not a single answer.** `open_search` opens results with the dates and people already filled in:
   flights with `site: "google_flights"` (`from`, `to`, `depart`, `return`, `adults`, `children` as ages); stays with
   `site: "booking"`, `"airbnb"` or `"google_hotels"` (`place`, `checkin`, `checkout`, `adults`, `rooms`). Trains: the
   operator's own site. Read the results with the browser. Flights or trains: 2–3 with times, stops and the total price
   including bags; if Google Flights says prices are currently low, typical or high, report it. Stays: 3 with price per
   night and in total, area, rating and cancellation terms. Put them in a compact table with where each price came from
   and "as of" today; recommend one and say why.
4. **The itinerary.** Day by day with rough times. Before promising a day, add up the travel time between stops and check
   it fits (with kids, fewer stops). Check opening hours and closing days of what matters, and add a budget line per day.
5. **Arriving late?** For a late arrival, check how to get from the station or airport at that hour, and what's open near
   the stay (24-hour shop, pharmacy), plus the nearest hospital.
6. **Before you go.** Entry rules and visas from the official government site (and passport validity), money (cards,
   cash, payment apps), SIM or eSIM, plug type, apps that don't work there, the local emergency number, dress rules for
   religious sites. Search in the local language too.
7. **Save it.** Anything longer than a day goes to the Library as a page or document (`library_create`), linked in the
   reply. If they keep lists, a packing list with `list_add` and `kind: "packing"`.
8. **Bookings.** Never pay or book on your own; offer to go through it together, and the approval card shows the exact
   amount. Offer calendar entries (`calendar_create_event`, or `make_calendar_file` when no calendar is connected) and
   reminders: check-in opening, passports, leaving for the airport. For a price that may drop, offer a quiet watch:
   `schedule_task` twice a day (`cron: "0 9,18 * * *"`) with `only_when: "the fare is under …"`, `watch_url` the results
   page and `until:` the travel date (flight-deals has the details).

| Excuse | Reality |
|---|---|
| "Flights from around €200" | Give the real fare you saw, with bags, and the date you saw it. |
| "It's only 20 minutes away" | Check the actual travel time for that day and hour. |
| "Visa rules are simple" | Read the official site; they change. |

## Done when
- Each price in the plan has its source and an "as of" date.
- Every day of the itinerary fits its travel times and opening hours.
- Entry rules, money and late-arrival practicalities are checked.
- Nothing is booked or paid without the approval card, and calendar, reminders and a price watch are offered.

Sources: Jessbot built-in; OpenClaw camino-journey, camino-safety-checker, flight-search, personal-travel and travel-practicalities skills (ideas, own words).
