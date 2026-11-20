---
name: gift-finder
description: 'Finding a present for someone: who they are, the budget, the occasion and when it must arrive, giving two or three thoughtful ideas with why each fits, including one experience. Use for "a gift for my mum''s birthday", "what should I get Maya?", "Eid presents for the kids", "a wedding gift under 200", "something for the teacher".'
toolsets: [web]
---

# Gift finder

1. **Who it's for.** `recall` what you know about them: age, interests, sizes, past gifts, and their wish list
   (`list_show` with `kind: "wish"`, if you have lists). Ask only what's missing, in one `ask_user`: budget, occasion,
   the date it must arrive, and anything they already have or wouldn't like.
2. **Think about the person, not the category.** One or two lines on what matters to them right now (a new hobby, a move,
   a baby, exams) lead to better ideas than "gifts for women over 40".
3. **Two or three picks**, each with:
   - why it fits this person, in one line;
   - the price and a real shop that delivers to them by the date (`web_search` and `web_read`, or `open_search` shop
     results such as `site: "jumia"` or `"amazon"` with a `query` and `price_max`; in the local language too);
   - a fallback if it's out of stock.
   At least one experience or non-object idea (a class, a day out, a shared meal, a subscription, a donation in their
   name) and, when it suits, something handmade or personal.
4. **Fit the occasion and culture**: halal or alcohol-free where it matters, modest where expected, toys safe for the
   age (no small parts under 3), and a value that won't embarrass the receiver.
5. **Keep the surprise.** Talk about it in private rather than a chat the receiver shares, and mark a bought item on a
   shared wish list with `list_check` so the receiver never sees who bought what.
6. **Next time.** For a birthday or anniversary not in memory yet, offer `remember` with `date:` and
   `yearly: true`, and a `set_reminder` about two weeks before, so there's time to order.
7. **Buying it** goes through shop-and-return, with their approval for any payment. Offer to write the card message,
   too.

## Done when
- The picks reflect what's known about the person, the budget and the occasion.
- Each pick has a reason, a price and a shop that can deliver in time.
- One experience or non-object idea is included.
- The surprise is protected, and a yearly reminder was offered for new dates.

Sources: OpenClaw gift-finder and gift-ideas skills (ideas, own words; merchant and affiliate parts dropped); volt-life review gift-finder.
