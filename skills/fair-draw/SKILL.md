---
name: fair-draw
description: 'Anything that has to be fair and truly random: a raffle or giveaway winner, who picks the film or starts the game, names out of a hat, shuffling an order, splitting kids into teams or pairs, drawing a chore rota, dice for a board game, or a Secret Santa where each person privately learns only their own match. Use for "pick a winner", "draw names", "who goes first?".'
toolsets: []
---

# Fair draw

A draw is only fair if the rules are fixed before it and nobody (Jess included) picks by feel. `pick_random` does the
drawing; Jess never chooses "at random" herself.

1. **The list.** From the chat, an uploaded list (`library_read` of a spreadsheet or text file, if they have the
   Library), a shared list (`list_show`, if they have lists) or the family members. Remove duplicates and say the count
   ("23 entries").
2. **The rules, before drawing:** how many winners, runners-up and in what order, who is left out this time
   (`exclude`: last week's winner), extra chances (`weights`: someone bought three tickets), teams and how many, pairs,
   couples or siblings to keep apart (`avoid_pairs`), the dice ("2d6"). Read the rules back. Changing them after the draw
   means a new, announced draw.
3. **Draw.** `pick_random` with the right `mode`: pick, shuffle, teams, pairs, dice or secret_santa, plus the items and
   rules.
4. **Show the result with its draw id and time,** so anyone can check it was one draw and not the third try. For a
   raffle, list the runners-up in order in case a winner doesn't claim.
5. **Secret Santa.** `pick_random` with `mode: "secret_santa"`, `avoid_pairs` for couples, and a `note` with the
   budget and the swap date. People in the household each get their own match privately in their own chat; neither Jess
   nor the organiser learns anyone's match. Don't guess or reveal one later, even when asked "who has me?": the draw is
   private by design. Someone taking part without a Jessbot account: ask the organiser whether to leave them out or use
   `reveal: "organiser"`, which shows the organiser every match. If they keep lists, a wish list per person
   (`list_create` with `kind: "wish"` and `for`) helps the givers.
6. **Chore rotas.** Draw the starting order with `pick_random` (`mode: "shuffle"`), then rotate it fairly week by week;
   offer reminders (`set_reminder` with `repeat: "weekly"`) if they have schedules, or the what-if-page skill to try out
   the rules.
7. **Disputes.** A redraw only if everyone agreed beforehand when one would happen; give both draw ids.

## Done when
- The list and the rules were fixed and read back before the draw.
- The result came from `pick_random`, shown with its draw id and time.
- Secret Santa matches stayed private (or the organiser reveal was chosen knowingly).
- Nothing was drawn twice to get a "better" result.

Sources: composio raffle-winner-picker (Apache-2.0; ideas, own words); householdB draws and Secret Santa idea.
