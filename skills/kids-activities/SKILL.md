---
name: kids-activities
description: 'Keeping the children''s clubs and activities straight: training and match fixtures, lessons and practice times, term dates, who drives, kit and snack days, fees due; from the club''s page, a letter or a photo into the calendar, with leave-by and kit reminders and a check for changes. Also finding a club, class or sport for a child.'
toolsets: [schedule]
---

# Kids' activities

1. **The setup.** One `ask_user` round: each child, their activities, the club, usual days and times, the place, the
   coach's contact, and who drives. `remember` each fact (private by default).
2. **Get the schedule.** The club's fixtures page (`web_read`, if you have the web), a PDF or letter (`library_read`),
   a photo of the noticeboard (`view_image`), or the club's emails (`email_list` with `from`, if connected).
3. **Pull out each session:** date, start time, meeting time (matches often want players there 30 minutes early),
   venue and address, home or away, kit colour, what to bring, cancelled dates and term breaks. Read back anything that
   was hard to make out.
4. **Into the calendar.** If they have a calendar, `calendar_events` first for duplicates, then
   `calendar_create_event` per match or one-off (approved), titled "Leo: football match (away)". For a whole term of
   weekly sessions, one `make_calendar_file` with every date (up to 200) is quicker to add, and can be passed to the
   other parent or the car-share families.
5. **Reminders:**
   - leave-by: start or meeting time minus the travel time (`open_search` with `site: "google_maps_directions"`, if you
     have the web) and parking;
   - kit and snacks the evening before, around 19:30 (`set_reminder`, `repeat` on the right days, e.g. "mon,wed");
   - fees and forms due, the day before.
6. **Who drives.** A fair order with `pick_random` (`mode: "shuffle"`), then a shared to-do list with assignees if they
   keep lists (`list_add` with `kind: "todo"`).
7. **Changes.** Offer a quiet watch on the fixtures page: `schedule_task` weekly (`cron: "0 18 * * 0"`) with `watch_url`
   the page, `only_when: "a date, time or venue changed, or a session was cancelled"`, and `until:` the end of the
   season.
8. **Finding an activity** for a child: what they enjoy, age, budget, days free, distance; search nearby clubs (in the
   local language), trial sessions and prices. Questions to ask the club: coaches' qualifications and safeguarding,
   group size, costs beyond the fee (kit, travel, competitions), and whether a trial is possible. One-off events belong
   to events-finder.

| Excuse | Reality |
|---|---|
| "Training is at 5" | Where, and what time must they leave? |
| "Same as last week" | Check the fixtures page; away games move. |
| "I'll remind them the morning of" | Kit needs the evening before. |

## Done when
- Each child's activities are saved with day, time and place.
- Sessions are in the calendar or one .ics file, without duplicates.
- Leave-by and kit reminders are set or offered.
- A watch for fixture changes is offered.

Sources: volt-life kids-activities (OpenClaw sports-fixtures and family-calendar ideas); own words.
