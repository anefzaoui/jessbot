---
name: get-to-know-me
description: 'Letting Jess learn someone''s preferences through a few quick tap-to-answer questions at a time: food and dislikes, daily routines, the people who matter, how they like replies. Use for "get to know me", "ask me some questions", "what don''t you know about me?", "learn my preferences", or a short daily question round they asked for.'
toolsets: [memory]
---

# Get to know me

1. **Start from what you know.** `recall` a few broad topics (food, routines, family, work, how they like replies) and
   note the gaps. Don't ask what memory already answers; go deeper where you know only a little.
2. **Three questions per round**, one topic each, in one `ask_user` call: `kind: "single"` with three plausible answers
   and room for their own. Quick to tap: "Weekday breakfast?" with "Coffee and nothing else", "A proper breakfast",
   "Whatever the kids leave". Mix light and useful topics:
   - food: dislikes, allergies, favourite dishes, cooking time on weekdays;
   - routines: wake time, busiest days, their day off;
   - people: who's who in their life, birthdays they care about;
   - Jess herself: reply length, voice notes or text, when check-ins suit them, which language for what.
3. **Save each answer** with `remember` as a full sentence with context ("Prefers short replies, with bullet points when
   there are steps"): `importance: 3` for allergies and health, `date` with `yearly: true` for birthdays. When an answer
   changes an existing memory, update it (`action: "update"` with its `memory_id`) instead of adding a contradiction.
4. **Sensitive topics** (health, money, faith, relationships) only when they bring them up or opt in. Always offer
   "rather not say", and respect it without comment.
5. **Reflect back** in one line what you learned ("Noted: no coriander, early riser, voice notes in the car"). A lasting
   rule about how Jess should behave ("always answer in French") is saved as `kind: "instruction"`; a rule for the whole
   household is the admin's to set, so suggest they ask.
6. **A daily round** if they like it: `schedule_task` in the evening with a `cron`, instructions "Use the get-to-know-me
   skill: ask one question" (a scheduled run may end with one question), and `until:` a week from now. Stop sooner if
   they skip twice.

## Done when
- Each round asked at most three questions, none that memory already answered.
- Every answer is saved as a clear memory, updated rather than duplicated.
- Sensitive topics were optional, with "rather not say" offered.
- They saw a one-line summary of what was learned.

Sources: OpenClaw get-to-know-you style preference interview (ideas, own words); volt-life review get-to-know-me.
