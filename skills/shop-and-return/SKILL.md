---
name: shop-and-return
description: 'Buying, reordering or returning something in an online shop with Jess''s browser, and warranty claims: "order more dishwasher tablets", "buy this one", "return the blue jacket", "it broke after three months, can I claim the warranty?", "where''s my refund?". Checks the return window, fills the cart or the return form, and they approve the final step.'
toolsets: [web]
---

# Shop and return

1. **What and where.** Work out the item, the shop, and whether it's a reorder, a new purchase, a return, a warranty
   claim or "where's my order or refund?". `recall` their usual shop, sizes, brands and delivery address label (never
   card numbers or passwords).
2. **Open the shop's own page** with `browser_open`: order history for reorders, returns and status; the site's search
   for new items (`open_search` with `site: "amazon"`, `"jumia"`, `"noon"` or `"argos"` and a `query` opens a shop's
   results in one step). A sign-in screen: never type a password; use `ask_user` with `show_screen: true` so they sign
   in themselves, then carry on.
3. **Buying.**
   - Reorder: find it in order history, check it's the same product (name, size, pack count), and compare today's price
     with what they paid last time.
   - New item: compare 2–3 (price with delivery, rating, delivery date, seller, return policy). Take a
     `browser_screenshot` with the price visible and wait for their choice before adding to the cart.
   - Checkout up to the last step: read back the item, quantity, delivery address label, delivery date, payment method
     label ("Visa ending 42") and total. The final "Place order" click asks them automatically (`browser_click`); never
     look for a way around it. Card details and security codes are typed by them, never by Jess.
4. **Returns.** Find the order and read the shop's return policy: the window, condition rules (tags, packaging), who pays
   return shipping, restocking fees, how the refund is paid. Use the reason they gave, or ask once with sensible defaults
   (refund to the original payment, their usual drop-off). Fill the return form and stop before the final confirm with a
   summary: item, refund amount, drop-off place and deadline.
5. **Warranty or a faulty item.** Find the receipt or order (Library, `email_list`, `recall`) and the purchase date.
   Check the maker's warranty and the local consumer rules (a legal guarantee from the seller often applies on top;
   check the official consumer site for their country, in the local language). Draft the claim with the facts, dates,
   photos and what they want (repair, replacement, refund), and send it with `email_send` only through the approval card.
6. **Deadlines.** `set_reminder` for the last return day, the drop-off, and a check that the refund arrived (often 5–14
   days; the policy says). For "where's my order?", the parcel-tracking skill reads the carrier's tracking and gives the
   expected date.
7. **Afterwards**: one short summary (item, price, delivery or refund date). `remember` stable preferences (shop, size,
   brand), not the order details.

| Excuse | Reality |
|---|---|
| "It's the same product" | Check name, size and pack count against the last order. |
| "Returns are usually 30 days" | Read this shop's policy. |
| "The card is saved, I'll just confirm" | The final click is theirs, on the approval card. |

## Done when
- The right item (or order) was confirmed with them before anything went into the cart or a form.
- Checkout or the return stopped at the final step with a full read-back.
- Return windows and warranty rules come from the shop's, maker's or official pages.
- Deadlines have reminders; only stable preferences were remembered.

Sources: browser review shop-online and shop-and-return drafts (amazon-shopper flow, own words); OpenClaw returns-reverse-logistics (Apache-2.0; idea flipped to the customer side, own words).
