---
name: life-planner
description: 'Setting direction for the months or years ahead: what they want life to look like, a few goals for this year and quarter, this month''s top three and what to stop doing. Use for "help me plan my year", new-year or birthday planning, "I feel stuck in life", "where am I going?", a mid-year reset or "what do I want from the next five years?".'
toolsets: [library]
---

# Life planner

1. **Scope and depth.** A year, the next 3 months, or the next few years? Offer a deeper warm-up to those who want it:
   "If nothing changes, where is your life heading in 3 years? Is that where you want to be?", "Which of your goals are
   really yours, and which did you inherit?" Skip it when they want to get practical.
2. **Where they want to be, area by area**, in their words: health, family and relationships, work or study, money,
   home, faith or meaning, learning, fun. Two or three lines each; skip the areas they don't care about. `recall` what
   you already know so they don't repeat themselves.
3. **Choose few.** 2–3 goals for the year (or quarter), each with a result they can see ("run 5 km without stopping by
   March", not "get fit"). Too many goals is the most common reason plans fail: say so if they list eight, and help
   them park the rest.
4. **Break each goal down**: this quarter's milestone, this month's top three actions, this week's first step. Test each
   weekly task with one question: does it serve a top-three goal?
5. **The not-to-do list.** What they'll stop, hand over or say no to, to make room. Often the most useful page of all.
6. **Save the plan** with `library_create` (`type: "md"`): the picture per area, the goals with milestones, this month,
   this week, the not-to-do list, and a "Review on" date. Private to them.
7. **Make it live.** Offer `goal_suggest` with `confirmed: true` for each goal they want tracked (it goes on their Goals
   page), the weekly-review skill for the weekly rhythm, and a quarterly check (`schedule_task` with a `cron` such as
   `0 18 1 1,4,7,10 *`) that rereads the plan and asks one question: keep, change or drop?
8. **Kind realism.** Name trade-offs plainly (a new degree and a new baby in the same year), and never judge what they
   want from life.

| Excuse | Reality |
|---|---|
| "Every area needs a goal" | Two or three goals get done; eight get abandoned. |
| "Be healthier" is a goal | Only once it has a result they can see and a date. |
| "The plan is saved, job done" | Without a review date it's a wish list. |

## Done when
- The plan holds 2–3 goals with visible results, a quarter milestone, this month's top three and this week's step.
- There is a not-to-do list.
- The plan is saved in their Library with a review date.
- Tracking was offered (Goals page, weekly review, quarterly check), not imposed.

Sources: OpenClaw life-planning skills (vision to week breakdown, fix-life-in-1-day warm-up questions; ideas, own words); volt-life review life-planner.
