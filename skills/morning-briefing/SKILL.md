---
name: morning-briefing
description: 'A short "your day at a glance" brief: weather that changes plans, today''s events and reminders, emails that need them, birthdays coming up and one focus for the day. Use for "what''s my day like?", "brief me", "le point du matin", "شنوة عندي اليوم؟", setting up a daily morning brief, or when a scheduled "Morning brief" task runs.'
toolsets: []
examples:
  positive:
    - "Brief me: what's my day like?"
    - "Fais-moi le point du matin"
    - "شنوة عندي اليوم؟ عطيني ملخص الصباح"
  negative:
    - "Help me plan my day, I have too much to do"
    - "Let's review last week"
---

# Morning briefing

A brief is worth reading only if it is short, true and about their day. Never invent an item to fill a section.

1. **Today or tomorrow?** Late in the day (after about 18:00 their time, see "Right now"), brief tomorrow instead and
   say so in the first line.
2. **Setting it up** (when they ask for a daily brief). One `ask_user` round: the time (07:00 recommended), weekdays or
   every day, which sections (weather, calendar, email, goals, birthdays, news) and text or voice. Then `schedule_task`
   with the title "Morning brief", a `cron` such as `0 7 * * 1-5`, and self-contained instructions: "Use the
   morning-briefing skill. Sections: … . Language: … . Voice: yes/no." Tell them when the first one arrives. Without
   schedule tools, say they can simply ask "brief me" each morning.
3. **Gather.** A scheduled run has nobody watching: assume what you can and say what you assumed in one line; at most one
   question, at the very end, and only for a decision that is truly theirs.
   - Weather: `get_weather` (with `day: "tomorrow"` for an evening brief). Keep only what changes the day: rain at
     school-run time, heat, strong wind, a cold start.
   - Events: the "Coming up" block (until the end of tomorrow), plus `calendar_events` for the day if a calendar is
     connected. Flag clashes and tight gaps between places.
   - Reminders and alarms due today: `list_alarms`, if you have schedule tools.
   - Email, if connected: `email_list` with `unread: true` and `since:` yesterday's date. Keep at most 3 that need them (a
     person waiting for a reply, a deadline, a payment due, school), one sentence each. Never open promotions.
   - Goals: one next step from `goals_list`, if they have goals.
   - Birthdays and dates: `recall` "birthday" and dated memories in the next 7 days.
   - Holidays: `get_holidays` with `date:` today when a holiday changes school or opening hours.
   - News: only if they asked for it. Their own Feed first: `feed_stories` (2–3 items, each with its source and link);
     `web_search` with `kind: "news"` only for a topic their Feed doesn't cover. For anything contentious read two
     outlets with different leanings, report what happened as fact and what each side claims, and never adopt one
     outlet's framing.
4. **Write it for a phone.** Their name and one line about the day, then short sections in this order, each left out when
   empty: do early, fixed times (HH:MM what, where), needs you, nice to know. 12 lines or fewer, local times, their
   language. No filler ("Have a productive day!"); end with at most one useful offer (a reminder, a reply draft).
5. **A quiet day still gets two lines**: the weather and "nothing fixed today". They asked for a brief.
6. **Voice.** If they chose voice, call `reply_by_voice` and stay under about 250 words; write numbers and symbols the
   way they are said ("twenty-two degrees", not "22°C").

| Excuse | Reality |
|---|---|
| "The calendar is empty, I'll add some tips" | Two true lines beat ten padded ones. |
| "There's probably a meeting around 10" | Only what the calendar, reminders or mail say. |
| "I'll ask which sections they want" | Scheduled run: use the sections in the instructions and say what you assumed. |

## Done when
- Every line comes from a real source (weather, calendar, reminders, mail, memory).
- It fits on one phone screen, with empty sections left out.
- Whatever needs them today is near the top.
- A scheduled brief asked nothing it could reasonably assume.

Sources: household review drafts (morning-briefing, user-briefing); OpenClaw ai-daily-briefing, briefing, daily-brief-digest, morning-email-rollup (ideas, own words); briefing-room balance rule (own words).
