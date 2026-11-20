---
name: baby-log
description: 'Logging a baby''s feeds, sleep, nappies, medicines and growth from quick messages ("fed 120 ml", "left side started", "nap 1:10 to 2:40", "wet and dirty", "4.2 kg at the clinic"). Answers "when did she last eat?" and makes a summary for the paediatrician.'
toolsets: [library]
---

# Baby log

1. **Find or start the log.** `library_list` for "<baby's name> baby log". If there's none, `library_create` a Markdown
   document (`type: "md"`) with a heading and a table for each part, time first:
   - Feeds: `| Time | Kind (breast L/R, bottle, solids) | Amount or minutes | Notes |`
   - Sleep: `| Start | End | Hours | Where |`
   - Nappies: `| Time | Wet | Dirty | Notes |`
   - Medicines: `| Time | Medicine | Dose given | By |`
   - Growth: `| Date | Weight | Length | Head | Where measured |`
   If the family already keeps an Excel sheet for this, add rows there instead with `sheet_append_rows`.
2. **Read the message.** The time is now unless they say otherwise ("at 3" means the last 3 o'clock). Say in one line
   what you assumed.
3. **Write the row with `library_append`**, `under_heading:` the part ("Feeds"). Things with a start and an end use the
   start time as the key, so the end replaces that row instead of adding one: "nap started" writes
   `| 2026-09-26 13:10 | | | cot |` with `key: "2026-09-26 13:10"`, and "she's up" rewrites the same row with the end time
   and hours. "Left side started" works the same way; if they want a nudge to switch sides, `set_timer` for the minutes
   they choose.
4. **Answer at once:** `library_read` for "when did she last eat?" (time, how long ago, how much), today's totals (feeds,
   ml, sleep hours, wet and dirty nappies), or "which side was last?".
5. **A summary for the doctor.** Daily and weekly totals, the growth table, medicines given: a Library page
   (`library_create` with `type: "html"`), and a PDF of it to bring with `library_export` (`format: "pdf"`). Don't judge
   growth yourself; the paediatrician plots it on their charts.
6. **Reminders only if the parents want them:** feeds or medicines with `set_reminder`.
7. **When to call a doctor now:** follow what their doctor told them, and always urgently for a fever in a baby under
   3 months, trouble breathing, a baby who won't feed or is unusually sleepy and hard to wake, or far fewer wet nappies
   than usual. Give the local emergency number when it sounds urgent.

Keep replies short: parents log with one hand at 3 a.m.

## Done when
- Each message became a row in the right part of the log, with its time.
- A start and its end sit in one row (replaced by key, not duplicated).
- "When did she last…" questions are answered from the log, with the time since.
- No medical judgement was made, and urgent signs were pointed to a doctor.

Sources: OpenClaw baby-log (ideas, own words); household review drafts.
