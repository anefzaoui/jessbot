---
name: find-a-time
description: 'Finding a time that works for several people: a family dinner, a visit, drinks with friends, a call with the plumber, a school meeting or a clinic appointment. Checks calendars for real free slots (including household members who share when they''re busy), proposes options, sends the "which suits you?" email or invite, and books the agreed time in the calendar.'
toolsets: [calendar]
---

# Find a time

1. **The details.** What, how long, in person (where) or online, the window ("next week, evenings"), and who. Real
   constraints: school pick-up, work hours, prayer times, travel time, and other people's time zones.
2. **Real free time, never eyeballed.** `calendar_free_slots` with `duration`, `from` and `to`, `within` for the daily
   window ("18:00-21:30"), `days` ("weekdays", or ["sat", "sun"]), `buffer` for travel, and `people` for household
   members ("Sam", "Mum"). Each one counts only if they share a group with the person and turned on busy sharing: the
   answer says who wasn't included and why. Say that plainly ("Sam isn't sharing busy times, so I couldn't check
   him") and never guess someone's availability; offer to ask them.
3. **Three options**, spread over different days or times of day, each with weekday, date, time, and the time zone when
   anyone is elsewhere. Recommend one and say why (fewest clashes, least travel).
4. **People outside the household.** If they have email: `email_send` a short message in the recipient's language with
   the three options and "or suggest another time" (the approval card shows it). Otherwise a ready-to-copy text for
   WhatsApp or SMS. To follow up, offer a one-off `schedule_task` (`at` two days later) that checks `email_list` with
   `from` set to that person and reports their answer, or that there was none.
5. **Book the agreed time.** Check the slot is still free (`calendar_free_slots` for just that stretch), then
   `calendar_create_event` with the title, start, end, the full address or the call link as location, and who and why
   in the description; they approve it. To give others the event, `make_calendar_file` with it and attach the file to
   the email (`email_send` with `attachments`), or send the link.
6. **Reminder** if they want one: `set_reminder` with the travel time before it.
7. **Moving it later:** `calendar_update_event` and a short email, both on approval cards.

| Excuse | Reality |
|---|---|
| "Tuesday evening looks free" | Ask `calendar_free_slots`; gaps aren't worked out by eye. |
| "Sam is probably free" | Only if Sam shares busy times; otherwise ask him. |
| "3 pm" to someone abroad | Say whose 3 pm, or give both. |

## Done when
- Free slots came from `calendar_free_slots`, and anyone who couldn't be checked is named.
- Three options were offered with weekday, date, time and zone where needed.
- The agreed time is in the calendar (approved), with the place or link.
- Invitations and emails went only through approval cards.

Sources: volt-life find-a-time; householdA find-a-time (OpenClaw meeting-scheduler idea); composio-apps calendar free-slot idea; own words.
