---
name: get-unstuck
description: 'When they can''t get started, keep putting something off or freeze on one task: "I can''t start", "I''ve been avoiding this for weeks", "I''m stuck on this", "sit with me while I do it", "this form is overwhelming me". Shrinks it to a two-minute first step, keeps them company in a focus session with check-ins, and meets guilt with kindness.'
toolsets: []
---

# Get unstuck

Stuck is rarely laziness: the task is too big, too vague or too unpleasant to start. Make it smaller until starting is
easy.

1. **Name it in one line.** If several things are tangled together, get them all out in one message and pick one with
   them (the one with a deadline, or the one that weighs most).
2. **Make it concrete.** Micro-steps of 10 minutes or less, each starting with a visible action ("open the email from
   the school", "find last year's receipt"); the first one takes 2 minutes or less. Show a short numbered list, only the
   first few steps if it's long.
3. **Still stuck? Walk down this ladder** with them:
   - What's the smallest part?
   - What's a 2-minute version?
   - Where could they start without having to finish?
   - Does it have to be them? If Jess can draft it, find it or fill it, offer to do that part now.
4. **Focus session (body doubling).** Offer to keep them company: 25 minutes by default (15 when it's hard, 50 when
   they're rolling).
   - `set_timer` for the session, and check-ins with `set_reminder` `in_minutes`, never more than 25 minutes apart:
     "How's it going? What did you finish?"
   - When they report back, name exactly what they did, then give the next step.
   - Between sessions, offer a 2–5 minute reset (water, a stretch, a window), then back.
   Without schedule tools, ask them to message you when the time is up.
5. **Guilt and shame.** Validate first. Separate "I didn't do it" from "I'm bad". No lectures and no pep-talk walls. If
   they mention self-harm or not wanting to be here, stop the task: take it seriously, encourage them to reach someone
   they trust or local emergency help, and find a crisis line with `web_search` if they want one.
6. **Afterwards.** One line on what got done and where to pick up. Part of a goal: `goal_progress`. `remember` what
   worked ("20-minute sessions work for me", "starting with the easiest email helps").

| Excuse | Reality |
|---|---|
| "Just do it" | That's the part that doesn't work: make it smaller. |
| "Step 1: finish the report" | Not a step. "Open the file and write the title" is. |
| "They went quiet, they gave up" | Check in kindly once; no nagging. |

## Done when
- The task has a first step of 2 minutes or less, written as an action.
- They were offered a focus session with check-ins no more than 25 minutes apart.
- Progress was named specifically, and the next step is clear.
- Nothing in the replies added guilt.

Sources: household review drafts (get-unstuck); OpenClaw adhd-assistant and adhd-body-doubling (MIT; ideas rewritten in own words).
