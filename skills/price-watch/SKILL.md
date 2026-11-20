---
name: price-watch
description: 'Watching the price of something they want and speaking up only when it drops: "tell me when X is under 300", "watch this for a deal", "surveille le prix", "نبهني كي ينقص السوم", "is this a good price right now?", "where is it cheapest today?". Compares shops now, and sets a quiet watch that stays silent until the target is reached.'
toolsets: [web, schedule]
examples:
  positive:
    - "Tell me when this phone is under 300 euros"
    - "Surveille le prix de cette télé et préviens-moi"
    - "نبهني كي ينقص سوم هالآلة"
  negative:
    - "Which fridge is the best for our kitchen?"
    - "Where's my parcel?"
---

# Price watch

1. **Pin the exact item**: model number, size, colour or variant, new or refurbished, and the country. A different
   variant is a different price.
2. **Compare now.** `web_search` the exact model (in the local language too) and `web_read` 3–5 shops, or `open_search`
   shop results (`site: "amazon"`, `"jumia"`, `"noon"`, `"argos"` or `"google_shopping"`, the model as `query`,
   `sort: "price_asc"`); `browser_open` when the price only appears with the page's scripts. Table: shop, price with
   delivery, stock, seller (flag marketplace sellers, used and refurbished), link, date checked. A price far below the
   rest: say so and use scam-check. A price history on the shop or a tracker site tells whether now is a good moment.
3. **Agree a target**: a price, or "the lowest in 3 months", and an end date. Coupons only from the shop's own page;
   codes from coupon sites are never stated as fact.
4. **Set the quiet watch**, one `schedule_task` per item:
   - title "Price watch: <item>";
   - `watch_url`: the product page (an unchanged page costs nothing);
   - `only_when: "the price is at or below <target>, or more than 5% below the last price seen"`;
   - `until:` the end date they chose;
   - a `cron` of once or twice a day, such as `0 9 * * *`;
   - self-contained instructions: the exact item and variant, the URLs, which price to read (the page's own price for
     that variant, not "from" prices or other sellers), the target, and "never buy; report shop, price, link and date".
   Tell them it stays silent until the condition is met.
5. **When it fires**, they get the shop, price, link and how much it dropped. Buying goes through shop-and-return, with
   their approval; this skill never buys.
6. **Tidy up.** Bought, no longer wanted, or past the end date: `cancel_schedule` (`list_schedules` finds it).
7. **Blocked pages.** A result starting BLOCKED: try another shop; don't keep retrying the same one.

| Excuse | Reality |
|---|---|
| "It's around 350 everywhere" | Name each shop, price with delivery and date. |
| "Close enough, it's the 256 GB one" | Same variant or it's not the same price. |
| "I'll check every hour to be safe" | Once or twice a day is enough; watches run at most every 2 hours. |

## Done when
- The exact variant, target and end date are agreed.
- Today's prices are in a dated table with delivery included.
- One quiet watch per item is set with `watch_url`, a condition and an end date.
- Nothing was bought, and finished watches were cancelled.

Sources: household review drafts (price-watch); OpenClaw ecommerce-price-monitor and price-tracker skills (ideas, own words).
