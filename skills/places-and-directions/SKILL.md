---
name: places-and-directions
description: 'Finding real places nearby and getting there: the nearest or on-duty pharmacy, a petrol station, mosque, halal restaurant, vet, ATM, supermarket or playground; "how long to drive to…", walking or public-transport time, a directions link to send someone. Opening hours, phone numbers and distances come from maps, never from guesswork.'
toolsets: [web]
---

# Places and directions

1. **From where?** Their home (from what you know about them, or `recall`), their work or school, or the place they
   name. If it matters and you don't know, ask once and offer to save it with `set_location` (label "home", "work",
   "school"…). For a map search you need coordinates: `web_read`
   `https://nominatim.openstreetmap.org/search?q=<address>&format=json&limit=1` gives lat and lon.
2. **Turn the request into OpenStreetMap tags:** pharmacy `amenity=pharmacy`; petrol `amenity=fuel`; vet
   `amenity=veterinary`; cash machine `amenity=atm`; mosque `amenity=place_of_worship` with `religion=muslim` (church:
   `religion=christian`); supermarket `shop=supermarket`; bakery `shop=bakery`; playground `leisure=playground`;
   hospital `amenity=hospital`; restaurant `amenity=restaurant` with `cuisine=…` (halal is often `diet:halal=yes`).
3. **Ask OpenStreetMap.** `open_search` with `site: "overpass"`, `tags` (all must match, e.g.
   `["amenity=place_of_worship", "religion=muslim"]`), `radius` in metres, and `lat`/`lon` when it isn't their home
   (their home is the default). It returns real places with distances. If it fails, `web_read` the Overpass address
   yourself (URL-encoded):
   `https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];nwr(around:1500,LAT,LON)["amenity"="pharmacy"];out center 30;`
   and, if that refuses or times out, the same query on `https://overpass.kumi.systems/api/interpreter`. Take the name,
   address, opening hours (the opening-hours tag), phone and website. Distances from coordinates are straight-line and
   rough: say "about 800 m as the crow flies".
4. **Open now, or on duty?** OpenStreetMap hours are often missing or old. For an on-duty or night pharmacy, search the
   official or local list for today in the local language ("pharmacie de garde", "صيدلية الليل", "Notdienst Apotheke"),
   read it, and say what you verified and where. For anything urgent: "call before you go", with the number.
5. **Ratings and reviews** only when asked: `open_search` with `site: "google_maps"` and a `query` ("pharmacy near
   Rua Augusta, Lisbon"), and read the rating and how many reviews it rests on.
6. **Directions and travel time.** `open_search` with `site: "google_maps_directions"`, `origin`, `destination` and
   `mode` (driving, walking, bicycling or transit) opens the route; always give an origin, or Maps starts from where
   the browser is, not the person. Read the time Maps shows (`browser_snapshot` with `find` set to "min"); it reflects
   traffic now, so for "leaving at 8 tomorrow" say it may differ at that hour. The same address
   (`https://www.google.com/maps/dir/?api=1&origin=<from>&destination=<to>&travelmode=driving`) is the link to send
   someone. Timetables and live departures belong to public-transport.
7. **Reply** with 3–5 places in a small table: name, rough distance, hours or "open now" (and the source), phone, and a
   directions link. A medical emergency: the local emergency number first, places second.
8. **Offer the next step:** save a place they go often (`set_location` with a label), put the address in a calendar
   event's location, or a leave-by `set_reminder` with the travel time.

| Excuse | Reality |
|---|---|
| "It's about 10 minutes away" | Read the time Maps shows, or say it's a straight-line guess. |
| "It should be open" | Hours from a source, or "hours not listed: call first". |
| "The nearest pharmacy" at night | Find today's on-duty list. |

## Done when
- The starting point is right (theirs or the named place).
- Every place listed is real, from OpenStreetMap or a maps page, with hours or "not listed".
- Distances are marked rough or come from a maps route.
- Each place has a directions link.

Sources: composio-apps maps-directions; householdA places-nearby (OpenClaw places and camino skills, ideas); Google Maps URLs (api=1) and OpenStreetMap Overpass and Nominatim documentation.
