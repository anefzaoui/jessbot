---
name: home-search
description: 'Looking for a home to rent or buy: turning their wishes (areas, budget, rooms, must-haves) into searches on the property sites, a shortlist of real listings with price per m², a look at the neighbourhood and commute, the true cost of buying, questions for viewings, and a quiet watch for new listings. Spots rental and sale scams. Use for "find me a flat", "houses for sale in…".'
toolsets: [web]
---

# Home search

1. **The wish list.** Rent or buy; several areas; budget and currency; bedrooms, type and size; must-haves (lift,
   parking, garden, near a school); move-in date; where they commute to. `recall` what's known; ask the rest in one
   `ask_user`; `remember` the criteria.
2. **Search the sites people really use there** (search in the local language: "appartement à louer", "شقة للكراء",
   "à vendre"). Do one search through a site's form with `browser_open`, then reuse its results address, editing the
   area, price or rooms, for the other searches. `browser_read` the results.
3. **Shortlist 5–8 real listings,** each with: price, size, price per m² (your arithmetic, marked as such), rooms,
   floor, condition, charges and fees, date listed, and the link. Flag the same flat on several sites, and listings
   months old.
4. **Scam signs,** flagged plainly: far below similar listings; an owner "abroad" who can't show it; a deposit or fee
   before any viewing; money by transfer service or crypto; pressure to decide today; photos that appear elsewhere.
   Never send money before a viewing and a contract; scam-check helps with a doubtful message.
5. **The area.** Schools, shops, pharmacy and transport nearby (`open_search` with `site: "overpass"`, `tags` such as
   `["amenity=pharmacy"]` and the listing's `lat` and `lon`; the places-and-directions skill has more); the commute with
   `site: "google_maps_directions"` (`origin`, `destination`, `mode`) read for rush hour; recent prices of similar homes
   where the site shows them.
6. **Buying: the real cost.** Price plus notary or registration fees, taxes, agency fees and the loan's total interest,
   from official rates and a bank's figures. A big purchase deserves decision-stress-test; the contract and the survey
   are for a notary or lawyer and a surveyor.
7. **Save the comparison:** `make_spreadsheet` if they have office documents (price per m² and totals as formulas),
   or a `library_create` page if they have the Library; otherwise a table in chat.
8. **Viewings.** A checklist: damp and mould, water pressure, windows, noise at different hours, heating and cooling,
   internet, what stays (kitchen, AC units), charges and what they cover, the deposit and notice period, who repairs
   what. Contacting an agent or booking a viewing (email or a site's form) goes through the approval card.
9. **New listings, quietly:** `schedule_task` daily (`cron: "0 9 * * *"`) with `watch_url` the results address,
   `only_when: "a new listing matches: 2 bedrooms, Alfama or Belem, under 1500 EUR a month"`, and `until:` the
   move-in date.

| Excuse | Reality |
|---|---|
| "About 2,000 a m²" | Work it out per listing and mark it as your arithmetic. |
| "The owner is abroad, just pay the deposit" | A classic scam: no money before a viewing and a contract. |
| "Close to everything" | Check the commute at rush hour and what's actually nearby. |

## Done when
- The shortlist holds real listings with links, price per m² and fees.
- Scam signs are flagged and no money moved.
- The area and commute were checked for the top picks.
- A watch for new listings is set or offered.

Sources: householdA home-search (OpenClaw realestate search recipe, generalised); volt-life home-buying-research; own words.
