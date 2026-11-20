---
name: idea-shaper
description: 'Turning a rough idea into a one-page plan: a side business, a club or event concept, a family project, an invention or app idea, a surprise for someone ("I want to do something special for mum''s 60th"). Use for "is this idea any good?", "help me shape this", "I have an idea but…", or when someone wants something but can''t yet say who it''s for or what success looks like.'
toolsets: [library]
---

# Idea shaper

Two halves: first find out what they actually want, then make the idea sharp enough to try. Skip the first half when
the goal is already clear.

## 1. Figure out what they want (only if it's vague)

1. **Write your one-line reading** of what they want and how sure you are (a rough percentage). Below about 70%, name
   what's missing: for whom, why now, what success looks like, the limit (money, time).
2. **One question at a time**, each an `ask_user` single choice with your best guess marked recommended plus two or
   three real alternatives. Now and then guess in a direction you expect them to correct, so they don't just agree to
   be polite.
3. **Listen for "should" answers** ("the sensible option", "what people usually do"). Ask: "If you didn't have to
   justify it to anyone, what would you pick?"
4. **Restate it** when you could predict their next answers: Outcome · For whom · Why now · Success looks like · The
   limit · Not doing. "Not doing" is never empty.
5. **Get a real yes** (a yes/no card). "Sounds good" or "whatever you think" is not a yes: offer two concrete versions
   instead. After about five questions without progress, say so and ask what is behind the idea.

## 2. Shape the idea

1. **Restate it as a question:** "How might we … for … without …?" (for example: "How might we give mum a 60th she
   remembers, for the whole family, without a big venue bill?").
2. **Sharpen once.** At most three questions in one `ask_user` round: who it is for, what success looks like, the real
   limits, what has been tried. Skip what the conversation already answered.
3. **Spread out: 5 to 8 variations**, each labelled with the angle that produced it and one line on why it exists:
   - Opposite (do the reverse of the obvious),
   - Remove a limit (what if money or time weren't the issue?),
   - Different audience,
   - Combine two ideas,
   - Ten times simpler,
   - An expert's view (a chef, a teacher, an event planner),
   - Borrow from elsewhere (how another field solves it).
   Say kindly and specifically which ones look weak.
4. **Narrow to 2 or 3 directions** after they react, and test each:
   - Value: a real need or a nice-to-have? What do people do today instead?
   - Effort: the hardest part, and a first version doable within days.
   - What makes it different from what exists.
   - Hidden assumptions, split into must be true / should be true / might be true, each with a cheap way to check it
     (a question to a friend, a price lookup, a small trial).
   - Pre-mortem: "A year on, it flopped. Why?"
   If they have the web, check the facts an assumption rests on (prices, rules, whether it already exists).
5. **Write the one-pager** with `library_create` (markdown): Problem · Recommended direction (two or three short
   paragraphs) · Assumptions to test (a checkbox and how, each) · First small version · Not doing (and why) · Open
   questions. Write it in their language.
6. **Next step.** Offer a goal (`goal_suggest`, if they have goals), a Project for something bigger, or a reminder to
   test the first assumption. Save lasting preferences with `remember` only after their yes.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "They'll tell me if it's wrong" | People rationalise the wrong plan. Ask until the goal is plain. |
| "All the variations are good" | Say which are weak and why; kind and specific beats flattering. |
| "Not doing is obvious" | Unwritten, it creeps back in. Write it down. |
| "The idea is fine as it is" | Name its riskiest assumption and a cheap test anyway. |

## Done when
- The goal is restated (outcome, for whom, success, limit, not doing) and they said yes to it.
- Several labelled variations were offered and narrowed to one recommended direction.
- The one-pager is saved with assumptions to test, a first small version and a "Not doing" list.
- A concrete next step was offered.

Sources: addyosmani/agent-skills (interview-me, idea-refine and its frameworks), adapted and rewritten for Jessbot; see NOTICE.md.
