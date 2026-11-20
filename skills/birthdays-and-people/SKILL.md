---
name: birthdays-and-people
description: 'Keeping up with the people in their life: birthdays and anniversaries with a reminder in time to get a gift, "how old will Grandma be?", "c''est quand l''anniversaire de mamie ?", "امتى عيد ميلاد…؟", what someone likes, gifts already given, and nudges to call someone they haven''t spoken to in a while. Use when someone mentions a birthday, an anniversary or a family occasion.'
toolsets: [memory]
examples:
  positive:
    - "Maya's birthday is 14 February, remind me every year"
    - "C'est quand l'anniversaire de mamie ?"
    - "امتى عيد ميلاد أمي؟ فكرني قبل بأسبوع"
  negative:
    - "Find a gift for my mum's birthday under 100"
    - "Write a letter to my son for his 18th birthday"
---

# Birthdays and people

Facts about other people are theirs to share: keep them private unless the person clearly wants them shared, and
confirm before saving something about someone else that they didn't plainly ask you to keep.

1. **Get the date right.** Name and relation ("Maya (daughter)"), day, month, and the year if known. A date like 04/05
   is ambiguous (day-month or month-day): ask. A Hijri birthday moves about 11 days earlier each year in the Gregorian
   calendar: work out this year's date (a trusted converter, if you have the web), save that as a one-off date, and say
   it will need working out again, or offer a yearly check (below).
2. **Look before saving.** `recall` "birthday Maya" (and the anniversary): if it's already there, fix a wrong one with
   `remember` (`action: "update"` and its `memory_id`) instead of adding a second.
3. **Save it as a dated memory:** `remember` with `action: "add"`, `kind: "event"`, text like "Birthday: Maya
   (daughter), born 14 Feb 2016", `date: "2016-02-14"` (or `"02-14"` when the year is unknown), `yearly: true`,
   `importance: 2`. Dated memories come up by themselves as the day approaches. Share with the family group
   (`scope: "group:Family"`) only when they ask; it asks first.
4. **Reminders, for sure-fire timing** (if they have schedules): `list_alarms` first to avoid a duplicate, then
   `set_reminder` with `at` the next date at 09:00 and `repeat: "yearly"`, plus one a week before ("Maya's birthday in a
   week: gift?") also yearly. Keep the age out of the text; it changes every year. For a Hijri date, a yearly
   `schedule_task` a month ahead can work out that year's day and set the reminder.
5. **"What's coming up?"** `recall` "birthday anniversary", then work out days left and the age they turn from today's
   date; answer as a short list, soonest first. Unknown year: say the age is unknown rather than guessing.
6. **What they're like.** Short facts per person with `remember`, name plus relation in each: likes, sizes,
   allergies, children's names, how you met, gifts given ("Gift 2025 for Mum: silk scarf, loved it"). Before suggesting
   a gift, `recall` what was given before so it isn't repeated.
7. **Gift ideas** on request: their tastes from memory, a wish list if they keep lists (`list_show` with
   `kind: "wish"`), then ideas within a budget (and the gift-finder skill if you have it).
8. **Keeping in touch** if they want it: ask who and how often, then a gentle `set_reminder` with `repeat: "monthly"`
   ("Call Aunt Leila?"). No reminders about people they didn't ask for.
9. **A message for the day** in their voice and the other person's language; if they have email and want it sent,
   `email_send` shows the approval card, otherwise they copy it.

| Excuse | Reality |
|---|---|
| "04/05, so 4 May" | Ask: it could be 5 April. |
| "She'll turn 60" | Only if the birth year is known. |
| "I'll add another reminder" | `list_alarms` first: one per occasion. |

## Done when
- The date is unambiguous and saved as a yearly dated memory (or a one-off with a note for Hijri dates).
- No duplicate memory or reminder was created.
- Reminders for the day and a week before are set or offered.
- Facts about other people stay private unless they asked to share.

Sources: householdB birthdays (OpenClaw birthday-reminder); volt-life people-and-occasions (ideas, own words).
