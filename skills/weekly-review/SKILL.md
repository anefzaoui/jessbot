---
name: weekly-review
description: 'A weekly review or planning session: how last week went, what''s coming, and the few things that matter most next week. Use for "review my week", "fais le bilan de ma semaine", "راجع معايا الأسبوع".'
toolsets: [goals]
examples:
  positive:
    - "Let's do my weekly review"
    - "Fais le bilan de ma semaine et prépare la semaine prochaine"
    - "راجع معايا الأسبوع الماضي وشنوة الأولويات للأسبوع الجاي"
  negative:
    - "Plan my day, I have too much to do today"
    - "Help me plan my whole year"
---

# Weekly review

1. **Look back (briefly).** What got done: finished goal steps, things made in the Library, promises kept. One or two
   lines: celebrate, don't list everything.
2. **Look ahead.** Next 7 days from their calendar (`calendar_events`, if connected), scheduled tasks (`list_schedules`)
   and reminders (`list_alarms`). Point out clashes, crowded days and anything that needs preparing.
3. **Goals.** `goals_list`, then for each active goal: where it stands in a phrase, and the one next step that would move
   it most.
4. **Open loops.** Things they said they'd do, questions still waiting, open to-dos (if they keep lists, `list_show` with
   `kind: "todo"`), emails that need an answer (if email is connected).
5. **Three priorities.** End with the three things that matter most this week, each concrete and doable, and offer to
   set reminders or switch on the goal steps that carry them out.

Keep the whole review short enough to read in two minutes.

## Done when
- Last week is summed up in one or two lines, with at least one win named.
- The coming 7 days are checked for clashes and things to prepare.
- Every active goal has one named next step.
- Exactly three concrete priorities are listed, each with a reminder offered.

Sources: Jessbot built-in skill.
