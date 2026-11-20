---
name: calm-and-breathe
description: 'When someone feels anxious, stressed, panicky, low or can''t sleep: "I can''t calm down", "my heart is racing", "I feel awful today", "help me sleep". A short guided breathing or grounding exercise, a gentle mood check-in with tiny doable steps, and local crisis help if things are serious.'
toolsets: []
---

# Calm and breathe

1. **Start with one warm line, then offer a choice** (`ask_user`, single choice): breathe together, ground myself, just
   talk, or wind down for sleep. If their words suggest they might hurt themselves or aren't safe, go to step 7 first.
2. **Guide one exercise at their pace**, a short line per step, waiting for them between rounds:
   - *Longer out-breath*: in through the nose for 4, out slowly for 6 to 8; about ten rounds. The fastest way to settle.
   - *Box breathing*: in 4, hold 4, out 4, hold 4; four rounds.
   - *5-4-3-2-1 grounding*: name 5 things you see, 4 you can touch, 3 you hear, 2 you smell, 1 you taste.
   - *For sleep*: 4-7-8 breathing (in 4, hold 7, out 8) or a slow body scan from the feet up, tensing and letting go.
   If they'd like to listen instead of read, answer with `reply_by_voice`.
3. **Check in afterwards,** only if they want: how it feels now from 1 to 10, compared with before. Whatever the number,
   it's fine; offer another round or a different exercise.
4. **On a low day, keep it tiny.** Once a day at most, a gentle check-in, and one to three small steps (5 to 15 minutes)
   that match their energy: a glass of water, a few minutes outside, a message to one person, a shower. Notice small wins
   out loud.
5. **Only if they ask:** practice reminders two or three times a week with `set_reminder`, or a private log (what set it
   off, 1 to 10, what helped) kept with the daily-log skill, and a look at patterns (sleep, time outside, people) later.
6. **Know the limits.** This is support, not therapy: no diagnosis. If low mood or anxiety has lasted two weeks or more,
   or gets in the way of daily life, gently suggest talking to a doctor or counsellor, and offer to find one nearby.
7. **If they might be in danger:** say you're glad they told you, and that they deserve help right now. Find the crisis
   line and emergency number for *their* country with `web_search` (official sources, the local language too; never
   assume a US number), give them clearly, and encourage them to call or to reach someone nearby they trust. Without web
   access, urge them to call their local emergency number now. With their OK, `remember` the verified numbers for next
   time. Stay with them in the chat.

Short sentences, a calm tone, no lists of advice while they're struggling.

## Done when
- They chose what they needed and were guided through one exercise at their pace.
- How they feel now was checked, if they wanted.
- Any sign of danger was met with their local crisis and emergency numbers, not US defaults.
- Reminders or a log were set only if they asked.

Sources: OpenClaw calm-and-breathe, anxiety-relief and mood-support skills (ideas, own words); household review drafts.
