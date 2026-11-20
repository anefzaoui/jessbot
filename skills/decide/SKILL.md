---
name: decide
description: 'Quick help choosing between two or three options ("A or B?", "which should I pick?", "should I go with…") when the stakes are everyday, or turning a fuzzy chore with no shape yet ("I should sort out the garage", "I need to deal with the car") into one concrete action for today. A small table and a verdict, not a long analysis.'
toolsets: []
---

# Decide

This is the light-weight tool. If the choice is expensive, hard to undo or has a contract behind it, switch to the
decision-stress-test skill instead and say why in one line.

## A. Choosing between options

1. **Get the options named.** Two or three, in their words. If they only have one ("should I buy this?"), the second
   option is "not now". If there are more than three, ask which three are really in the running.
2. **Look up facts yourself.** Prices, opening hours, the weather, what memory (`recall`) says about their taste. Ask
   them only for what is a matter of preference, in one `ask_user` round at most (up to 3 questions, your best guess
   marked recommended).
3. **Four lines per option**, kept short:
   - what it costs (money and time);
   - how hard it is to undo if it turns out wrong;
   - the sign after a week or a month that it is working;
   - the sign that it is not.
4. **The regret test.** "A year from now, which would you be sorrier not to have tried?" When an option is cheap to
   undo and has a clear stop sign, lean towards the one they would regret skipping.
5. **Answer.** A compact table, then one sentence: "I'd go with B, because…". Their choice is theirs; say so only if
   they seem to want permission.
6. **Close the loop.** Offer the first step (a booking behind the approval card, a list item, a reminder to check the
   stop sign on a date with `set_reminder` if they have reminders).

## B. Unsticking a shapeless task

Use this when the problem is not "which one" but "I don't know what doing it even means".

1. **What exists when it is done?** Ask for a noun: "a garage with a clear floor", "a booked car inspection", "a sent form". If
   they can't say, offer two or three concrete versions and let them pick.
2. **The slice that fits today.** Of that outcome, what part fits in the time they have today (15 minutes? an hour?).
3. **The first physical action.** A verb and an object, small enough to start in two minutes: "put three boxes by the
   door", "find the car's registration papers", "open the council website".
4. **Hand back a small card:**
   - Outcome: …
   - Today: …
   - Next action: …
   Offer a reminder for the next action. If they sound overwhelmed or low rather than unclear, be kind first and keep
   it to a single step; don't lecture.

Ask at most two or three questions in the whole exchange. This skill is for momentum.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "Both are fine, it depends" | They asked for help choosing. Pick one and say why. |
| "Let me list ten factors" | Four lines per option. More detail belongs to decision-stress-test. |
| "They should think about it more" | A reversible choice is better made now and checked later. |
| "Whatever you think" means go | It is a hand-over: give one clear pick and let them veto it. |

## Done when
- Each option has cost, undo cost, a working sign and a not-working sign (or the task has Outcome / Today / Next action).
- There is one clear recommendation in a single sentence.
- A concrete first step is offered.
- Binding legal or financial choices were pointed to decision-stress-test or a professional.

Sources: ComposioHQ awesome-claude-skills review (rockscy ship-decision, tapestry unblock-action ideas), rewritten for Jessbot.
