---
name: second-hand-search
description: 'Finding something used or pre-owned on local classifieds and marketplace sites (a bike, a cot, furniture, a phone, a car): a fair price against new, questions for the seller, scam warning signs, and a quiet watch for new listings. Use for "find me a second-hand…", "is this used listing a good deal?", "anything like this on the marketplace?".'
toolsets: [web]
---

# Second-hand search

1. **The item and the limits**: exact model or type, the condition they'd accept, maximum price, area and how far they'd
   travel, pickup or shipping. `recall` their town.
2. **New price first.** Today's price new (and refurbished) sets what a fair used price is; a used price close to new is
   rarely worth the risk.
3. **Search where people really sell**: the national classifieds and marketplace sites, local groups they can see,
   specialist forums. Use the local language and the words sellers use ("occasion", "مستعمل", "used", "like new").
   `web_search`, then `browser_open` the listings with filters for price, area and condition. A site that needs an
   account: they sign in themselves (`ask_user` with `show_screen: true`).
4. **A table of the best 3–8**: title, price, condition, age, place, date posted, link, and the share of the new price
   ("62% of new"). Old listings are often gone: show the date.
5. **Scam warning signs**, named per listing where they apply: a price far below the rest, pressure to pay a deposit or
   pay outside the platform, a courier or "I'm abroad" story, no meeting and no demo, a photo copied from elsewhere, a
   request for a code sent to their phone. Scam-check has the full method.
6. **Questions for the seller**, ready to copy: why they're selling, age and receipt, faults, whether it can be tested,
   and for phones and laptops whether it's unlocked and signed out of the owner's account. For cars and other big items,
   an independent inspection.
7. **Meeting safely**: a public place in daylight, bring someone, test before paying, avoid carrying lots of cash, and a
   written receipt for expensive items.
8. **A watch for new listings** (offer): `schedule_task` once or twice a day (`cron: "0 9,18 * * *"`) with the search
   results address as `watch_url`, `only_when: "a new listing matches <item> under <price> within <area>"`, `until:` a
   date, and instructions that list the criteria and the scam signs. It stays silent until something matches.

| Excuse | Reality |
|---|---|
| "Half the new price, great deal" | Check condition, age and whether it's still listed. |
| "The seller seems nice" | Pay on the platform or in person after testing, never a deposit first. |
| "It's probably still available" | Show the posting date; ask the seller. |

## Done when
- A new price anchors every used price in the table.
- Each listing shows condition, place, date posted and any scam signs.
- Seller questions and meeting-safety tips were given.
- A quiet watch for new listings was offered.

Sources: OpenClaw marketplace and classifieds search skills (ideas, own words); volt-life review second-hand-search.
