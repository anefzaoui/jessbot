---
name: plan-my-day
description: 'Planning today or tomorrow when there''s too much on or they feel scattered: fixed events and school runs, the three things that matter, a realistic timed plan with buffers and breaks, a lighter version for a low-energy day, and an evening look-back. Use for "help me plan my day", "I have too much to do today", "organise ma journée", "نظملي نهاري".'
toolsets: []
examples:
  positive:
    - "Help me plan my day, I have too much to do today"
    - "Organise ma journée de demain"
    - "نظملي نهاري، عندي برشا حاجات"
  negative:
    - "What's my day like? Brief me"
    - "I can't get started on this task"
---

# Plan my day

1. **What's fixed.** Read the "Coming up" block (until the end of tomorrow) and, if a calendar is connected,
   `calendar_events` for the day; add the school runs, meals, prayers and appointments they mention. `recall` "carry
   over" for what yesterday left, and `goals_list` for a goal step that's due.
2. **Brain dump.** Invite everything in their head in one message, unsorted. If you still need their energy (tired, okay,
   full of it) or a hard stop, ask once with `ask_user`. Keep lasting patterns with `remember` ("focuses best 9 to 11").
3. **Pick three, no more:**
   - **the one thing**: if only this gets done, the day counts;
   - **would be good**;
   - **only if there's time**.
   Deadlines and consequences decide the order. Everything else goes on a later list, out of sight.
4. **Estimate honestly.** People under-guess time: take their guess and add half again (double it for anything new or
   fiddly), and say so.
5. **Build the blocks.**
   - Fixed things first; the one thing in their best energy window.
   - Focus blocks of 60–90 minutes with a 10–15 minute break or transition between them; never back to back.
   - Errands grouped by place; email and admin in a low-energy slot; meals, prayers and school runs protected.
   - Fill about 80% of the day and name a stop time.
   Show a compact timed list (HH:MM–HH:MM what). By voice: just the three and the first block.
6. **Start.** Give the one thing a first step of about 2 minutes ("open the tax form and find the reference number").
   Offer a `set_timer` for the first block, or the get-unstuck skill if starting is the hard part.
7. **Low-energy day.** Ill, exhausted, or it's already gone wrong: give the minimum version instead (eat, medicines, one
   small win, rest). No guilt language.
8. **Reminders.** Offer `set_reminder` for at most 3 block starts; set them on a yes, or straight away if they asked.
   With a calendar, blocks can go in as events with `calendar_create_event` (it asks first).
9. **Evening look-back** (when they ask, or offer once): wins, partial ones count; each undone item moves to tomorrow, to
   a date (`set_reminder`), or is dropped on purpose; `remember` what carries over as "carry over: …"; tomorrow's top
   three; close kindly. A whole week belongs to weekly-review.

When the list is impossible, ask "what would be enough today?" instead of squeezing everything in.

## Done when
- The plan has at most three priorities, with the one thing in their best window.
- Every block fits around the fixed events, with buffers, and the day ends at a named time.
- The one thing has a first step of about 2 minutes.
- Reminders were offered, not imposed; an evening review found a place for every open item.

Sources: household review drafts (plan-my-day, day-planner evening review); OpenClaw adhd-daily-planner by Erich Owens (MIT; ideas only: three things, time padding, buffers, good and bad day plans), daily-review-ritual (ideas, own words).
