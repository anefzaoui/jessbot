---
name: book-something
description: 'Booking or ordering through a website with Jess''s browser: a restaurant table, cinema, match or concert tickets, a class or a court, a doctor''s or hairdresser''s appointment, a takeaway or delivery order. Finds real availability, shows the full price, respects allergies, and books or pays only after their yes.'
toolsets: [web]
---

# Book something

1. **What, when, who.** The place or kind of place, the date and time (and how flexible), how many people (children's
   ages), the budget, and what matters: allergies and diets, halal, step-free access, parking, a quiet table. `recall`
   their favourite places, allergies and the name bookings go under.
2. **Find real options.** `web_search` and the venue's own site, or the booking platform it uses; `open_search` with
   `site: "google_maps"` and a `query` ("halal restaurant near …") for places with ratings, `"eventbrite"` for events.
   Check reviews and the opening hours for that date (`get_holidays` for a public holiday). For a class or an
   appointment, the provider's own booking page.
3. **Check availability** with `browser_open`, or `browser_autopilot` with a goal that ends "stop when the times are
   shown; don't book". Look at the requested time and the nearest alternatives, then show 2–4 real options with prices
   and let them choose. Never call something available that you didn't see on the page.
4. **Allergies and diets are not negotiable.** For food, read the menu and allergen information; skip any dish whose
   ingredients are unclear rather than guessing, and for a serious allergy suggest phoning the restaurant and put it in
   the booking note. Halal: say only what the venue itself states.
5. **Fill in the booking** with their details from memory (name, phone, the email they use for bookings). A sign-in, or a
   code sent to their phone: `ask_user` with `show_screen: true`, and they do that part themselves.
6. **Stop before committing.** Read back everything: the place, the date with its weekday, the time, how many, the total
   with fees and deposit, and the cancellation terms. The final "Book", "Pay" or "Order" click asks them automatically
   (`browser_click`) and happens only after their yes. Card details are theirs to type.
7. **Takeaway or delivery**: the menu on the restaurant's or delivery site's page, the basket built item by item and
   re-read after each add, a past favourite re-ordered on request. Show items, total with delivery and the estimated
   time before the final click.
8. **Afterwards.** Keep the confirmation number and details; put it in their calendar with `calendar_create_event` (it
   asks first) or `make_calendar_file`; `set_reminder` before it, and before any free-cancellation deadline. Offer a
   short message to the others going, sent only with their approval. `remember` the place if they liked it.

| Excuse | Reality |
|---|---|
| "They probably have a table at 8" | Only times seen on the page. |
| "The soup is likely nut-free" | Unclear means skip it, or they phone and ask. |
| "Price is about 40 each" | Read back the exact total with fees before the final click. |

## Done when
- The options shown were seen on the real booking page, with prices.
- Allergies and diets were checked against the menu or the venue's own statements.
- A full read-back came before the final click, which they approved.
- The booking is in their calendar with a reminder, and the confirmation is kept.

Sources: volt-dev date-night and food-cal-order drafts (ideas, own words); OpenClaw book-a-slot and takeaway-order skills (ideas, own words).
