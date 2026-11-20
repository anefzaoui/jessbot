---
name: buying-guide
description: 'Deciding which product to buy when it matters: a washing machine, laptop, stroller, car seat, phone, mattress or air fryer. Maker specs checked at the source, what owners report at scale, what testers found, a drawback for every pick and today''s local prices. Use for "which X should I buy?", "is this model any good?", "best X under 500", "quel … acheter ?", "أي تلفون نشري؟".'
toolsets: [web]
examples:
  positive:
    - "Which washing machine should I buy for a family of five?"
    - "Quel aspirateur robot acheter pour moins de 300 euros ?"
    - "أي تلفون نشري بأقل من 1000 دينار؟"
  negative:
    - "Tell me when the price of this TV drops under 900"
    - "Find me a second-hand bike"
---

# Buying guide

Jess hasn't held any of these products: never write "we tested" or "in my experience".

1. **Criteria before products.** Ask the one or two things that change everything (budget and currency, size or space,
   must-haves, who will use it) and put the criteria in order. `recall` their country, usual shops and past purchases.
2. **Shortlist 3–5** from searches in the local language too ("best X 2026", "meilleur X", "أفضل X") and shops that
   deliver to them. `open_search` opens shop results in one step: `site: "amazon"`, `"jumia"`, `"noon"`, `"argos"` or
   `"google_shopping"` with the model as `query` and a `sort` such as "price_asc" or "rating" (the shop's `country`
   defaults to theirs); for another shop, `browser_open` its own search.
3. **Evidence in tiers, kept apart:**
   - **Facts:** specs from the maker's own page, dated. Flag numbers that differ between sources.
   - **Owners at scale:** shop reviews and owner forums (`web_read` reads Reddit threads): patterns with the sample size
     ("across about 1,400 reviews, the hinge is the common complaint"), splits reported honestly, never cherry-picked.
     Under about 30 reviews, say it's too few to judge; watch for fake-review signs (bursts of 5 stars, vague praise).
   - **Named testers:** independent test labs and consumer magazines; show where they disagree and why.
   Marketing pages and "top 10" lists full of affiliate links are leads only.
4. **Safety items** (car seats, cots, helmets, heaters, e-bikes): check recalls on the official regulator's site and the
   safety standard it must meet in their country.
5. **Compare** in a table by their criteria, with the price including delivery, the warranty and where to buy; a named
   drawback for every pick, and who each pick is *not* for. Choose best overall, best value and best budget, each with
   a reason.
6. **Today's local price and stock**, with the shop and the date checked. "Not found" beats a guess.
7. **Recommend in 3–5 lines**, plus a "how I judged" line naming the tiers used. With 3 or more options, save the
   comparison with `library_create`. Offer next steps: a quiet price watch (price-watch), a used one (second-hand-search),
   or ordering it together (shop-and-return), where paying always waits for their approval.

| Excuse | Reality |
|---|---|
| "Owners love it" (12 reviews) | Too few to judge: say so. |
| "The spec is about 8 kg" | Quote the maker's page, or "not found". |
| "It's the best, according to a top-10 list" | Lists with affiliate links are leads, not evidence. |
| "It's cheapest at around 900" | Name the shop, the price with delivery and the date. |

## Done when
- Criteria were agreed before products were chosen.
- Each pick has maker specs, owner patterns with sample size, and tester findings where they exist, kept separate.
- Every pick has a named drawback and a "not for" line.
- Prices are local, dated and include delivery; safety items were checked for recalls.

Sources: composio rampstack evidence-based-reviews (MIT; evidence tiers, own words); household review drafts (shopping-research recipes); OpenClaw product-compare skills (ideas, own words).
