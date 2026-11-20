---
name: daily-log
description: 'Keeping a simple personal log from quick messages: sleep, meals, water, weight, workouts, mood, screen time or any habit ("slept 1 to 8, meh", "ran 5k in 31 min", "2 coffees", "did my stretches"). Use when someone reports such data, or asks how their sleep, eating or habits have been going.'
toolsets: [library]
---

# Daily log

1. **Find their log.** One Markdown document per kind keeps tables clean: `library_list` with a query like
   "<Name> sleep log". If there's none, `library_create` it (`type: "md"`) with their target at the top (if they have
   one) and a heading plus table per kind, for example:
   - Sleep: `| Date | Bed | Wake | Hours | Quality 1–10 | Notes |`
   - Food: `| Day and meal | What | kcal (est.) | Protein g (est.) |`
   - Body: `| Date | Weight | Water (glasses) | Notes |`
   - Workouts: `| Date | Activity | Distance | Time | Effort 1–10 | Notes |`
   - Mood: `| Date | Mood 1–10 | Energy 1–10 | Notes |`
   - Habits: `| Date | <habit 1> | <habit 2> | … |` with ✓ or ✗
2. **Read the message loosely.** A bedtime after midnight belongs to the night before; work out the hours; turn words
   into scores ("meh" = 5, "great" = 9); "yesterday" becomes the date. Say in one line what you assumed, so they can
   correct it.
3. **Write the row with `library_append`**: `under_heading:` the kind (for example "Sleep"), `key:` the date as
   YYYY-MM-DD, and a row that starts with that key (`| 2026-09-26 | 00:40 | 07:50 | 7.2 | 5 | woke once |`). A second
   message for the same day replaces that day's row instead of adding another. Meals are one row each: the first cell
   and the key are the date and the meal ("2026-09-26 lunch").
4. **Food numbers are estimates.** Say so every time you give calories or protein, and total them against the goal they
   chose, not one you picked. If they don't want to track weight or body data, log only what they give and don't ask
   again.
5. **Confirm with one small insight**, not a lecture: "Logged. Third night under 7 hours this week."
6. **When they ask how it's going:** `library_read` the log, then averages, best and worst days, streaks, and links they
   themselves mentioned (late coffee, workout days). Say "may be linked", never make a medical claim, and give one tip
   at a time. A chart on request: an HTML page with `library_create` (`type: "html"`) drawn from the log's numbers.
7. **Goals.** If a matching goal exists, record it with `goal_progress`; if not, and they keep logging the same thing,
   offer `goal_suggest`. Nudges only when they ask: a daily `set_reminder` at the time they choose.

Logs are private: keep them in their own Library, and don't mention them in group chats unless they ask.

## Done when
- The entry sits in the right log, under the right heading, on the right date (replaced, not duplicated).
- Any assumption is stated in one line, and estimates are labelled as estimates.
- A one-line insight was given.
- No medical claim was made, and at most one tip.

Sources: OpenClaw personal-log, food-and-nutrition and habit-tracking skills (ideas, own words); household review drafts.
