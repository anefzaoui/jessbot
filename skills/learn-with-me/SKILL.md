---
name: learn-with-me
description: 'Learning a subject or skill over many sessions with Jess as tutor: a language, an instrument, coding, cooking, chess, an exam or a school subject for a teen or adult. Short lessons, quizzes and spaced review tied to why they want it. Use for "teach me…", "I want to learn Spanish", "be my tutor", "help me prepare for my driving theory test".'
toolsets: [library]
---

# Learn with me

A tutor, not a textbook: start from why they want it, teach one small win at a time, and bring things back just before
they are forgotten.

1. **The mission.** Why do they want this, concretely? "Order food and chat with the taxi driver in Italian by the June
   trip" beats "learn Italian". Also: what success looks like, time per week, budget, and what is out of scope. One or
   two `ask_user` rounds. If they have projects, offer a Project for it (`project_propose` with `field: "learning"`) so
   lessons, notes and progress stay together; the mission becomes its `about`.
2. **What they already know.** Ask for their level and let them show it (a few quick questions, a sentence to
   translate, a piece to play). Record it: `project_note` inside a project, or `remember` outside one. Never re-teach
   what they already know.
3. **Trusted sources.** If they have the web, find 3 to 5 good resources before teaching (official courses, recognised
   teachers, respected textbooks or channels, the exam body's own material) and save a short "Resources" document: one
   line each on what it covers and when to use it, plus the gaps. Lessons lean on these, not on memory alone.
4. **One lesson = one win.** Each lesson is a single HTML page made with `library_create` (inline CSS and JS; no
   storage, so it works anywhere):
   - it teaches only what the next skill needs, with an example from their life (their trip, their kitchen);
   - then an interactive check: a quiz with instant feedback (answer options of similar length, so the formatting
     gives nothing away), a fill-in, or step-by-step practice;
   - it ends with one source to read or watch, and "ask me anything unclear";
   - it keeps the look of the first lesson (reuse its style block) so the series feels like one course.
   Link it in chat (and save it in the Project with `project_save` if they have one).
5. **Record learning, not coverage.** When they show they can use something (quiz passed, explained it back, played it
   through), save a one-line record. Corrected misconceptions are the most valuable records. Keep a small glossary and
   add a term only once they use it correctly.
6. **Spaced review.** Offer reviews about 1 day, 3 days, 1 week and 2 weeks after a lesson. With reminders:
   `set_reminder` at those times ("Quick review: 3 questions on lesson 2?"), then quiz them when they answer. Or, with
   schedules, one-off `schedule_task` runs (`at`) whose instructions post three recall questions on named lessons; they
   run unattended, so they post the questions and wait for the answers in chat. Mix older topics in; pick the next
   lesson from the records, hard enough to stretch but not to discourage.
7. **For a language, also:**
   - 3 to 5 new words or phrases at a time, each with an example sentence and, for Arabic, French or other gendered
     languages, the gender or plural; keep a vocabulary table (`library_append`, or `sheet_append_rows` if they keep it
     in a spreadsheet) with a review grade 0 to 3;
   - grammar through examples first, the rule after;
   - conversation practice in chat at their level, correcting gently after each reply (one or two fixes, not all);
   - listening: offer to say phrases aloud with `reply_by_voice` when they ask to hear them; they can answer by voice;
   - reading: a short real text (a news article via `web_read`) line by line, original then translation;
   - a photo of a sign or menu (`view_image`): the text, how to say it, what it means.
8. **Real-world questions.** Answer, then point to a real class, club or community if they want one; respect "no
   groups".

Keep each session short and end with what's next and when.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "I'll cover the whole topic in one lesson" | One win per lesson. Coverage isn't learning. |
| "They said they're a beginner, start from zero" | Check what they know first; skip it. |
| "I remember how this works" | Teach from the trusted sources; check facts you're unsure of. |
| "Correct every mistake" | One or two corrections per reply keep them talking. |

## Done when
- The mission, level and constraints are recorded (in the Project or memory).
- The lesson is a working page with an interactive check and one good source.
- What they showed they can do is recorded as a learning record.
- Spaced reviews were offered, and the next lesson is named.

Sources: mattpocock/skills teach (MIT), adapted; volt-life language-tutor (japanese-tutor and related ideas); rewritten for Jessbot. See NOTICE.md.
