---
name: story-game
description: 'Playing an interactive story game or role-play with Jess as the game master: a choose-your-path adventure for kids, or a fantasy, mystery or sci-fi campaign for adults, with choices, dice rolls and a saved game to continue later. Use for "let''s play a game", "be the dungeon master", "an adventure where I''m a pirate", "continue our adventure".'
toolsets: [library]
---

# Story game

Jess runs the world; the players make the choices. Every choice matters, failure moves the story forward, and the game
can be picked up next week exactly where it stopped.

1. **Continue or start?** For "continue", find the save with `library_list` (query "Campaign"), `library_read` it and
   recap the story so far in three lines, then go on from the last scene.
2. **Session zero** (new game): one `ask_user` round of up to four questions: the setting (pirates, space, a magic
   school, a detective city…), who they play (name, what they're good at), the tone, and how long a session should be.
   - **Kids** (or when a child is playing, or you're unsure): cosy or adventurous only; no gore, no romance, no real
     violence against people; problems solved by cleverness, kindness and teamwork; nothing scary near bedtime.
   - **Adults:** also ask which themes are off-limits, and respect it for the whole campaign.
   Original worlds and characters only (no licensed ones). Kids' names and favourite things can come from memory
   (`recall`) if the parent has shared them.
3. **Character.** Three or four simple stats (for example Brave, Clever, Quick, Kind, from 1 to 3), a couple of items,
   and one thing their character wants.
4. **The save file.** `library_create` a markdown document "Campaign - <name>" with sections: World, Character (stats,
   items, status), People met, Threat (a clock of 4 to 6 steps for the looming danger), and Journal.
5. **Each turn:**
   - what happens because of their last action (consequences first);
   - a short scene using two senses (what they see and hear, smell or feel);
   - something changes (a door opens, a friend arrives, the storm gets closer);
   - "What do you do?" with 2 or 3 options plus "or something else". For young children, you can offer the options as
     buttons with `ask_user`.
   Keep scenes short (a few sentences for kids). Fail forward: a failed roll makes things harder or funnier, never ends
   the game.
6. **Dice.** When the outcome is uncertain, roll with `pick_random` (`mode: "dice"`, `dice: "d6"`, or `"d20"` for older
   players; add the stat as a bonus: `dice: "d6+2"`). Say the roll and what it means. Never make up a roll. Kids may
   also roll a real die and tell you the number.
7. **Saving.** About every three turns, and at the end of the session, update the save: add a journal line with
   `library_append` (under the Journal heading) and change stats, items or the threat clock with `library_edit`.
8. **Ending a session.** A small cliffhanger or a cosy stopping point, a one-line recap, and "say 'continue our
   adventure' next time". When a campaign ends, offer a storybook of it with `make_pdf` (if they have office documents)
   or a read-aloud with `make_audio`.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "I'll just decide it succeeds" | Uncertain? Roll with pick_random and honour it. |
| "They'll remember where we were" | Update the save file every few turns. |
| "A darker twist would be dramatic" | Kids: never. Adults: only within the themes they allowed. |
| "Let me describe everything" | Short scenes; the players' choices drive the story. |

## Done when
- Setting, character and limits were agreed (kids-safe by default).
- Every uncertain outcome used a real roll from pick_random or the player's own die.
- The save file holds the world, character, people, threat and an up-to-date journal.
- The session ended with a recap and a way to continue.

Sources: volt householdB story-game draft (agent-rpg mechanics); volt-life story-adventure (yumfu mechanics only, no licensed worlds); rewritten for Jessbot.
