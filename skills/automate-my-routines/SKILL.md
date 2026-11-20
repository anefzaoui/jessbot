---
name: automate-my-routines
description: 'Finding the chores and routines that repeat in their week that Jess could take over, and setting them up to run on their own: a Sunday meal plan, a monthly bill check, school emails summed up each evening, the weekly shop list, birthday reminders. Use for "what could you do for me regularly?", "automate this", "every week I have to…", "take this off my plate".'
toolsets: [schedule]
---

# Automate my routines

1. **Their world first.** `recall` their routines, where things arrive (email, school app, paper, messages) and who does
   what at home. Ask only the gaps, a few at a time, with `ask_user`.
2. **Spot the loops.** Look at what they ask again and again (`search_history` for repeated requests such as "dinner
   ideas", "what's on this week", "did the bill come") and at the shape of their week. Propose 3–5 loops worth handing
   over, including ones they haven't noticed ("every Sunday you ask me for dinner ideas"). Typical ones: a Sunday meal
   plan and shopping list, a monthly bill check, school emails summed up each evening, a morning brief, gift reminders
   two weeks before birthdays.
3. **Specify one loop at a time** until it could run with nobody there:
   - **Trigger:** a time (`schedule_task` with `cron` in their local time, or `at` for once) or a page that changes (a
     quiet watch: `schedule_task` with `watch_url` and `only_when: "…"`).
   - **What Jess does:** as much as possible before involving them: reading, sorting, drafting, filling the list.
   - **Checkpoint, if any:** the one decision that has to be theirs. A scheduled run may end with one question
     (`ask_user`); everything else it assumes and says so. Many loops need no checkpoint at all.
   - **Brief:** what the final message looks like: short, ready to decide on, with a link to the full thing, never a
     raw dump.
   Anything that sends, books or pays still stops at an approval card: say so, so nobody expects it to happen by itself.
4. **Set it up** with `schedule_task`: a clear title; self-contained instructions (the run won't see this chat, so
   include their preferences, names, the skill to use, the language and how the final message should look); the rhythm.
   Offer a first run now so they see what it produces.
5. **Check back.** Offer a one-off `set_reminder` in a week to ask: too long, wrong time, still useful? Adjust by making
   a new `schedule_task` and `cancel_schedule` on the old one; `list_schedules` shows what's running.

| Excuse | Reality |
|---|---|
| "The instructions can say 'as discussed'" | The run sees none of this chat: spell everything out. |
| "It can ask them a few things each time" | One question at most, at the end; otherwise assume and say so. |
| "Set up all five at once" | One loop at a time, each tried once before the next. |

## Done when
- 3–5 candidate loops were proposed from their real week and requests.
- Each loop they chose has a trigger, what Jess does, an optional checkpoint and a brief.
- Each is a scheduled task with self-contained instructions, and a first run was offered.
- A check-back in about a week was offered.

Sources: mattpocock/skills loop-me (ideas: trigger, checkpoint, brief; own words); Jessbot decision #83 (unattended runs).
