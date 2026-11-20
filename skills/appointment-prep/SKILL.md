---
name: appointment-prep
description: 'Getting ready for an appointment or meeting: a doctor or dentist, a school meeting, the bank, a lawyer or notary, a contractor''s visit, a job interview or an office. A one-screen brief: what it''s about, what was said before, questions to ask, papers to bring, when to leave. Use for "prepare me for tomorrow''s appointment", "quelles questions poser au médecin ?", "حضرني لموعد الطبيب".'
toolsets: []
examples:
  positive:
    - "Prepare me for tomorrow's doctor appointment"
    - "Quelles questions poser au médecin demain ?"
    - "حضرني لموعد الطبيب غدوة"
  negative:
    - "Find a time for dinner with my brother next week"
    - "Turn my notes from the parent-teacher meeting into actions"
---

# Appointment prep

1. **Which appointment?** If they have a calendar: `calendar_events` with a `query` (the name, "doctor", "school") or
   the coming days; if two could match, ask which. Otherwise take it from them: who, when, where, what about.
2. **What happened before.** Look, don't ask:
   - email, if connected: `email_list` with `from` or `text` set to the person or organisation over the last 60–90
     days, then `email_read` the 3–5 that matter;
   - the Library, if they have it: `library_list` with the name or topic (test results, letters, quotes, a contract);
   - `recall` and `search_history` for what they told you;
   - a Project, if it belongs to one (`project_brief`).
3. **The brief, one screen:**
   - **Purpose:** why they're going, in one line.
   - **So far:** a short timeline, each point with its source ("email from Dr Ben Ali, 12 Mar").
   - **Open items:** questions still unanswered and promises made on both sides.
   - **Questions to ask:** tailored to the kind of appointment. A doctor: when it started, how often, what makes it
     better or worse; current medicines and doses; allergies; "what are the options, the risks, and what if we wait?";
     what happens next and when to come back. A school: specific examples, what the teacher sees, what helps at home.
     A bank, lawyer or contractor: the full cost in writing, the timeline, the alternatives, what happens if it goes
     wrong, and what they need from you.
   - **Bring:** ID, insurance or health card, referral, previous results or reports, a list of medicines, forms
     already filled, photos or measurements for a contractor, a pen.
   - **Getting there:** address, travel time (if you have the web: `open_search` with `site: "google_maps_directions"`,
     `origin`, `destination` and `mode`, at the time of day they'll travel), parking, the weather (`get_weather` with
     `day`), and a leave-by time.
   Mark what you inferred; write "nothing found" rather than padding a section.
4. **Keep it handy.** Short in chat; longer as a Library document (`library_create`, "Prep: Dr Ben Ali, 3 Oct"), or a
   printable page with `make_pdf` if they have office documents.
5. **Reminders** if they have schedules: `set_reminder` at the leave-by time, and one the evening before ("papers in
   the bag") when there are documents to bring.
6. **Afterwards:** "Tell me how it went": notes, decisions and follow-ups (the meeting-notes skill), and reminders for
   anything they must do.
7. **Every weekday, if they want it:** a `schedule_task` with `cron: "0 7 * * 1-5"` that prepares the day's
   appointments, with `only_when: "there is an appointment or meeting today"`.

Jess helps them prepare; she doesn't diagnose or give legal advice. Symptoms that sound urgent (chest pain, trouble
breathing, sudden weakness) mean urgent care now, not waiting for the appointment.

| Excuse | Reality |
|---|---|
| "They probably discussed it by email" | Look, and cite what you find, or say nothing was found. |
| "Just bring the usual papers" | Name each document. |
| "Leave about half an hour before" | Work it out from the route and the time of day. |

## Done when
- The right appointment is identified.
- The brief has purpose, what happened before with sources, questions, things to bring and a leave-by time.
- Inferences are marked and empty sections say "nothing found".
- A leave-by reminder is set or offered.

Sources: composio legal meeting-brief and meeting-insights (ideas); householdA meeting-prep (OpenClaw); volt-life appointment-prep; own words.
