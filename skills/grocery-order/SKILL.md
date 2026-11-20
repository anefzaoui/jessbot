---
name: grocery-order
description: 'Doing the online grocery shop on their supermarket''s website: from the shopping list to a checked basket and a delivery or pickup slot, comparing unit prices and choosing substitutes, stopping before payment. Use for "do the grocery order", "put the shopping list in the supermarket basket", "commande les courses", "اطلب القضية من السوبرماركت".'
toolsets: [web]
examples:
  positive:
    - "Do the grocery order on the supermarket site"
    - "Commande les courses de la semaine sur le site du supermarché"
    - "اطلب لي القضية من موقع السوبرماركت"
  negative:
    - "Plan our meals for the week"
    - "Return the jacket I ordered online"
---

# Grocery order

1. **The list and the shop.** `list_show` the shopping list if you have lists; otherwise the list they send. Confirm the
   supermarket's website and delivery or pickup. `recall` brand preferences, dietary rules (halal, allergies) and
   "never substitute" items.
2. **Sign-in.** `browser_open` the shop. If it asks them to sign in, they do it themselves: `ask_user` with
   `show_screen: true`. Never type a password.
3. **Regulars first.** Check "my usual items" or past orders: re-adding known products is faster and matches what the
   family likes.
4. **Item by item.** Search the site (`browser_autopilot` can search and add one item; always check what it did). Not
   found: try another word (brand, singular or plural, the local-language name). Choose by price per kilo or litre, not
   pack price; a deal or bundle only if the family will use it before it goes off. Set the quantity. For dietary rules,
   check the label or the product page for halal certification or allergens; don't guess.
5. **Check after every add.** Re-read the basket line (`browser_snapshot` with `find:` the product name) for the right
   product, size and quantity. Fix a wrong add straight away, not at the end.
6. **Substitutes.** Set "similar substitute" or "no substitute" per item as they prefer (fresh meat and baby food: no
   substitute unless they say otherwise).
7. **Basket review**: items, quantities, prices and the total; skipped items and why ("no 1 L lactose-free milk, took two
   of 500 ml"); any price surprise. On request, compare the basket's total with a second shop.
8. **Slot, then stop.** Choose the delivery or pickup slot they want, then stop at payment and say exactly what's left
   for them: paying on the page (the final click asks them) with card details they type themselves.
9. **Afterwards**: tick what was ordered with `list_check` (if you have lists) and `remember` new preferences ("the 5 kg
   rice", "brand A milk, not brand B").

| Excuse | Reality |
|---|---|
| "Added everything, looks fine" | Each line was re-read right after adding it. |
| "The 3-pack is cheaper" | Compare price per kilo or litre, and whether they'll use it. |
| "Probably halal" | Only if the label or the shop says so. |

## Done when
- Every list item is in the basket (checked after adding) or on the skipped list with a reason.
- Substitution choices are set per item.
- The basket review shows items, quantities, prices and total.
- It stopped at payment, with a slot chosen and the list ticked.

Sources: OpenClaw grocery-order, supermarket-shopper and shopping-list skills (ideas, own words); volt-life review grocery-order.
