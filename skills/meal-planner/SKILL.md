---
name: meal-planner
description: 'Planning the week''s meals and dinners for the household and turning them into a shopping list: diets and allergies, what the kids will eat, budget, busy nights, Ramadan iftar and suhoor, and "what can I cook with what''s in the fridge?". Use for "plan our meals this week", "dinner ideas for the week", "qu''est-ce qu''on mange cette semaine ?", "برنامج أكل للأسبوع".'
toolsets: [library]
examples:
  positive:
    - "Plan our dinners for this week"
    - "Qu'est-ce qu'on mange cette semaine ? Fais un menu"
    - "حضر لنا برنامج أكل للأسبوع في رمضان"
  negative:
    - "Save grandma's couscous recipe in our cookbook"
    - "Put the shopping list in the supermarket basket"
---

# Meal planner

1. **Know the household once.** `recall` first; ask only the gaps in one `ask_user`, and `remember` the answers: who
   eats (adults, children and their ages), allergies (`importance: 3`), diets and religious rules (halal, no pork or
   alcohol, fasting days, vegetarian), dislikes, weekday cooking time, equipment, budget, favourite cuisines.
2. **This week's shape.** Busy nights ("Coming up", or `calendar_events` if connected), guests, leftovers they want,
   food in the fridge that must be used, and the weather (`get_weather`: lighter meals in a hot week).
3. **Plan the meals.**
   - No repeats from the last two weeks (`library_list` "Meal plan" and read the latest ones).
   - Quick dishes on busy nights, a slower one at the weekend; cook once, eat twice (tonight's roast chicken becomes
     tomorrow's wraps); reuse ingredients across the week so less goes to waste.
   - Loose balance each day (vegetables, protein, grains); no calorie counting unless they ask.
   - Family favourites from their cookbook (`library_list` "Family cookbook") mixed with a new idea or two.
4. **Ramadan** (when it's Ramadan or they ask; `get_holidays` has the dates): an iftar that starts light (dates, water,
   soup) before the main dish, and a suhoor that lasts (slow carbohydrates, protein, water-rich food, not too salty).
   Plan around iftar time, with dishes prepared ahead for tired afternoons.
5. **Write it down** with `library_create` (`type: "md"`): a week grid (day by meal), and each new recipe in full
   (ingredients with quantities for their household, steps, time). Never a recipe with made-up steps or quantities.
6. **The shopping list.** Merge the ingredients, subtract what they have, round to real pack sizes, and add them with
   `list_add` to their shopping list if you have lists (otherwise a checklist at the end of the plan). Offer grocery-order
   to fill the supermarket basket.
7. **Fridge mode** ("what can I make with eggs, spinach and rice?"): three recipes using mostly what they have, with
   steps, and what's missing for each.
8. **After the week** (offer): what was a hit or a miss; `remember` the hits and the dishes never to suggest again.

Allergies are never "probably fine": leave out any dish or ingredient you can't confirm is safe.

## Done when
- The plan respects every allergy, diet and religious rule on record.
- The week fits their busy nights, with no repeats from the last two weeks.
- The plan and full recipes are saved in the Library.
- The merged shopping list is on their list (or in the plan), in real pack sizes.

Sources: OpenClaw meal-planner and weekly-meal-prep skills (ideas, own words); volt-life review meal-planner.
