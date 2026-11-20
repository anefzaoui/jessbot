---
name: training-plan
description: 'A personal training plan for a running, cycling, swimming or strength goal, or just getting fitter: "plan for my first 10k", "get me to a half marathon", "a gym routine for 3 days a week". Use when someone wants a week-by-week plan around their schedule, or wants an existing plan adjusted.'
toolsets: [office]
---

# Training plan

1. **Their profile, once.** `recall` first: if you already know their history, don't ask again. Otherwise one `ask_user`
   round (up to 4 questions): the goal and its date; what they do now (sessions a week, longest session); recent times if
   any; free days and limits (an injury, heat, work shifts, fasting in Ramadan). `remember` the answers so the next plan
   starts from them. New to exercise, a health condition or an injury: suggest seeing a doctor before starting.
2. **Build it safely:**
   - phases: base, then build, then peak, then a 1–3 week taper before an event;
   - an easier recovery week every 3–4 weeks; weekly volume up by about 10% at most;
   - about 80% of the time at an easy, conversational effort; no two hard sessions of the same sport back to back;
   - 1–2 short strength sessions a week (runners and cyclists too);
   - effort by the talk test or a 1–10 scale, unless they know their heart-rate or pace zones.
3. **Save it as a spreadsheet** with `make_spreadsheet`, titled like "10k plan (Oct to Dec)":
   - sheet "Plan": Week, Dates, Phase, one column per day (Mon to Sun), Weekly total, Done;
   - sheet "How to": the effort levels, warm-up and cool-down, and for an event, race-day pacing and what to eat and drink.
   Summarise the first two weeks in chat so they can start today.
4. **Make it stick.** Offer `goal_suggest` ("Run 10k by 14 December", with `confirmed: true` once they say yes) so
   check-ins track it, and log workouts with the daily-log skill or `goal_progress`. If they want reminders, set them
   for their training days.
5. **Adjust after check-ins.** "Felt wrecked" or a niggle: ease off that week. A missed week or an injury: shift the plan
   back, never cram the missed sessions in. Update the sheet with `sheet_set_cells` rather than starting over.
6. **Mind the weather.** With `get_weather`, suggest early or late sessions in heat, and indoor options in storms.

Not medical advice: pain that is sharp, gets worse, or lasts beyond a few days means rest and see a professional.

## Done when
- The plan starts from their real current level and fits their free days.
- Volume grows by at most about 10% a week, with recovery weeks and a taper before an event.
- The plan is saved as a spreadsheet and the first two weeks are summarised in chat.
- A goal and check-ins (or reminders) are offered.

Sources: OpenClaw training-plan and fitness-plan skills (ideas, own words); household review drafts.
