---
name: chore-quest
description: 'Turning the kids'' chores and good habits into a friendly game: points for jobs done, levels, streaks and badges, fair turns for the jobs nobody wants, rewards the parents choose, and a parent confirming each claim. Use for "make chores fun", "a chore chart for the kids", "a reward system for tidying up", "sort out whose turn it is to do the dishes".'
toolsets: [library]
---

# Chore quest

A game that makes jobs feel lighter, where each child competes only with their own last week.

1. **Set it up with a parent.** The children (names and ages: `recall`), the jobs, and what points buy: screen time,
   choosing dinner, an outing, pocket money. Rewards are the parents' call, never Jess's. Points by effort: quick jobs
   5–10 (feed the cat), standard 15–25 (tidy the room, set the table), big ones 50 or more (help wash the car). Only
   jobs that fit each child's age.
2. **One document holds it all**: `library_create` (`type: "md"`) with the jobs and points, the rewards, and a table per
   child under their name: `| Date | Job | Points | Confirmed |`.
3. **Claims.** When a child says "I did the dishes", add the row with Confirmed "waiting" (`library_append`,
   `under_heading:` the child's name). A parent confirms (with `ask_user` when a parent is in the chat, otherwise the
   next time one is), and that row's "waiting" becomes "yes" with `library_edit`; only confirmed points count. Be warm
   with the child either way.
4. **Fair turns for the jobs nobody wants.** Use `pick_random`: `mode: "shuffle"` for a weekly rota or `mode: "pick"` for
   one job, with `exclude:` whoever had it last time. Show the draw so there's nothing to argue about. Never choose "at
   random" in your head.
5. **Levels, streaks and badges** about each child's own progress: a level every 100 points, a streak for days in a row
   with at least one job, badges such as "Seven-day streak", "Helped before being asked", "Tried a new job". No
   leaderboard that ranks siblings and no "who did least"; a family target reached together ("300 points together =
   pizza night") works better.
6. **A chart for the fridge** on request: a bright HTML page with `library_create` (each child's own column, their
   badges, big friendly type) and `library_export` as an A4 PDF to print. Rebuild it weekly.
7. **Weekly wrap-up**: each child's points, one specific compliment, their next badge. Offer a `schedule_task` on Sunday
   evening that reads the tally and writes the wrap-up for the parent.

| Excuse | Reality |
|---|---|
| "A ranking will motivate them" | It motivates the eldest and shames the youngest: personal bests only. |
| "I'll just pick who does it" | Chance goes through `pick_random`, visibly. |
| "The child said so, add the points" | Waiting until a parent confirms. |

## Done when
- Jobs, points and rewards are agreed with a parent and saved in one document.
- Claims are logged as waiting and count only once a parent confirms.
- Unwanted jobs rotate through a visible `pick_random` draw.
- Nothing compares or ranks the children against each other.

Sources: OpenClaw chore gamification skill (points, levels, streaks; ideas, own words, leaderboard dropped); volt-life review chore-quest; Jessbot plan "no family leaderboards".
