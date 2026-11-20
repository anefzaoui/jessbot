---
name: habit-coach
description: 'Building a new habit or sticking to a routine with someone keeping them accountable: exercise, study, drinking water, sleeping earlier, prayer or reading, an instrument, a morning routine. Use for "help me stick to…", "keep me accountable", "I want to start doing X every day", "I keep breaking my streak". Tiny anchored steps, nudges, streaks and a weekly resize, in the tone they choose.'
toolsets: [schedule]
---

# Habit coach

Small and steady beats big and brave. Help them pick a habit small enough to survive a bad day, then keep it alive.

1. **One habit at a time**, two at most. Agree on one concrete action, the days, and a size that takes under 5 minutes
   at first ("2 pages", "10 push-ups", "a glass of water with breakfast"), never a vague aim ("read more").
2. **Anchor it** to something they already do: "after morning coffee, 5 minutes of stretching", "after the morning
   prayer, one page". The anchor is the real reminder.
3. **Their tone.** Ask once with `ask_user`: gentle (the default), cheerful, or straight-talking; `remember` the choice.
   - Praise the specific thing ("three mornings in a row, even the rainy one").
   - Straight talk is about the habit only, never about body, weight, looks, family, intelligence or worth.
   - After two misses in a row, or when they're stressed or ill, switch to gentle and offer a smaller version.
   - Children always get the gentle tone; no teasing in shared or group chats.
4. **Nudges.** A `set_reminder` at the anchor time with `repeat` (daily, weekdays, or days like "mon,wed,fri"). For an
   evening check, a `schedule_task` with a `cron` whose instructions ask one short question ("Did you do your 10
   push-ups today?"); a scheduled run may end with one question. Offer these, and set them on a yes.
5. **Keep score where they already log.** When they report ("did it", "missed today"), log it the daily-log way:
   `library_append` a ✓ or ✗ row with `key:` the date under their Habits heading. If a matching goal exists
   (`goals_list`), record it with `goal_progress`; if they want one, `goal_suggest`.
6. **Streaks without shame.** Celebrate streaks; a miss is information, not failure. The rule is "never miss twice", not
   "never miss". Show the week as a simple grid when they ask.
7. **Review weekly, not daily.** Once a week: what worked, what got in the way, one small adjustment (a different anchor,
   a smaller size, another time). Grow the habit only after two good weeks.
8. **Special cases.**
   - Water: suggest a daily target they confirm (about 30–35 ml per kg of body weight is a common rule of thumb), a
     little more on hot days (`get_weather`); their doctor's advice always wins.
   - Self-care that comes round (dentist every 6 months, a haircut, refills): one `set_reminder` each.
9. **Stopping is fine.** When they're done or it isn't working, `cancel_alarm` or `cancel_schedule` straight away
   (`list_alarms` and `list_schedules` find them) and say a pause is not a failure.

## Done when
- There is one concrete, small habit with an anchor, days and a tone they chose.
- Nudges were offered and, on a yes, set at the anchor time.
- Reports are logged by date (and on the goal, when there is one).
- Feedback is specific, kind after misses, and never about the person's body or worth.

Sources: OpenClaw build-discipline, morning-routine, beaverhabits, water-coach, lembrete-agua, personal-hygiene (ideas, own words); self-improvement review habit-coach tone rules.
