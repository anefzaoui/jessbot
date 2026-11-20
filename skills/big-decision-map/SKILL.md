---
name: big-decision-map
description: 'A big, foggy undertaking that will take weeks and many sittings to settle (moving house or country, a renovation, a wedding, choosing a care home, starting a business, having a baby): keep a map of every open choice inside a Project and settle them one sitting at a time. Use for "where do I even start with…", "help me plan the whole move", "there''s so much to decide".'
toolsets: [projects]
---

# Big decision map

For things too big for one chat. The Project brief becomes the map: what is settled, what is open, what is still fog.
One decision per sitting keeps it moving without overwhelming anyone.

1. **Name the destination first.** Not "we moved", but the point where the way is clear: "a shortlist of two
   neighbourhoods and a budget we agree on", "venue and date booked, guest list capped". Ask in one or two `ask_user`
   rounds (only what you can't look up), then propose a Project with `project_propose`, that destination as its `about`
   (what done looks like). If a Project for it already exists, open it with `project_brief` instead.
2. **Breadth first.** Walk the whole space once and surface the open decisions: money, place, timing, people, paperwork,
   the kids, work. Don't solve anything yet. If it turns out everything is small and clear, say so and just help; no
   map needed.
3. **Write the map** with `project_update` (up to 8 rows per call):
   - `decision` rows: settled choices, one line each with the why;
   - `question` rows: choices that can be phrased sharply now, even if blocked. When one waits on another, write
     "after: …" in its text;
   - `note` rows starting "Not yet clear: …" for fog you can't phrase yet;
   - `constraint` rows starting "Out of scope: …" for what is ruled out;
   - `next` rows for the concrete next action.
4. **Each sitting, settle one question** (two if they have the energy). Take the first one that isn't blocked.
   - A question of fact (costs, rules, distances, school catchments, visa steps) is yours: research it with the
     browser if you have it, in the local language too, and save the findings with `project_save` so they stay.
   - A question of choice goes to them, in `ask_user` rounds with your recommendation marked.
5. **After each decision:** close its question row (`close` with its id), add the `decision` row, turn fog that is now
   clear into new question rows, and mark anything beyond the destination as out of scope. Tell them in two lines what
   changed on the map and what the next open question is.
6. **Read back before acting.** Before anything outward (booking a viewing, emailing an agent), list what has been
   decided and assumed and get a yes. Spending and sending go through the approval card.
7. **Plan, don't do, until the map is clear.** When every question on the way to the destination is closed, offer the
   next phase: a goal with steps, reminders for deadlines, bookings behind approval. Offer to mark the project done
   (`status`) when they reach the destination.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "Let's decide everything today" | One or two decisions per sitting stick; ten in a row get undone. |
| "I'll ask them what the rules are" | Facts are yours to look up. Their time is for choices. |
| "That's too vague to write down" | Write it as "Not yet clear: …". Fog on the map beats fog in heads. |
| "We decided that last time" | If it isn't a decision row, it isn't settled. Check the brief. |

## Done when
- The Project exists with the destination as its goal.
- The brief lists settled decisions, open questions (with "after:" links), fog and out-of-scope rows.
- This sitting closed at least one question and added its decision row.
- They know the next open question.

Sources: mattpocock/skills (wayfinder, with ideas from to-spec and to-tickets), adapted and rewritten for Jessbot; see NOTICE.md.
