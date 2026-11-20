---
name: meeting-notes
description: 'Turning a meeting, call, parent-teacher talk, doctor''s visit or spoken memo into clear notes: a summary, decisions, who does what by when, open questions, reminders and follow-up drafts. From a voice note, pasted text or a transcript (.srt, .vtt, Word, PDF). Also agendas, a memo log for "note this", "un compte rendu de la réunion", "ملخص الاجتماع".'
toolsets: [library]
examples:
  positive:
    - "Turn this meeting transcript into notes with actions"
    - "Fais un compte rendu de la réunion d'hier"
    - "اكتب ملخص الاجتماع وشكون يعمل شنوة"
  negative:
    - "Prepare me for the meeting with the bank tomorrow"
    - "Summarise this long PDF report"
---

# Meeting notes

1. **The input.** A voice note (it arrives as text), pasted notes, or an upload read with `library_read`: .srt and .vtt
   caption files come in as clean transcripts, with speaker names when the meeting app labelled them. An audio or video
   file on its own can't be read: ask for the meeting app's transcript or captions. "Note this" or "memo:" is a
   note-to-self (step 5).
2. **Pull out:**
   - **Decisions:** what was decided and by whom.
   - **Actions:** every "I'll…" or "can you…" becomes an owner and a due date. No date given: say so and suggest one,
     marked tentative.
   - **Open questions,** and who has to answer them.
   - **Key points** (3–5) and anything parked for later.
   Name speakers only when the text labels them, and never add people who weren't there.
3. **Write it up** in their language: a title line (what, date, who), a summary of up to 5 lines, Decisions, an actions
   table (#, action, owner, due, status), Open questions, Key points.
4. **Save it** with `library_create` (`type: "md"`) and link it. For a file to send or print, `make_word_document` if
   they have office documents. Inside a project chat, `project_save` keeps it with the project.
5. **Memos to self.** Find this month's log ("Notes, October 2026") with `library_list`; add the dated entry with
   `library_append` (`under_heading` the day's date), or create the log if it doesn't exist. Reply short: saved, plus
   the decisions and actions.
6. **Follow-through.**
   - Their own actions: offer a `set_reminder` the day before each due date, in one question for the whole batch.
   - Other people's actions: offer a follow-up email per person; if they have email, `email_send` shows each on the
     approval card.
   - A next meeting that was mentioned: offer `calendar_create_event` (approved) or a `make_calendar_file`.
7. **Recurring meetings.** `library_list` by title for the last notes; carry forward open actions and mark each done or
   still open (`library_edit`).
8. **Agendas.** One line of goal; at most 5 topics, each marked info, discuss or decide, with minutes and a buffer; any
   reading beforehand. If nothing needs deciding, say "this could be a message".
9. **How they came across,** only when asked: quoted examples of hedging, how much they talked, questions they asked,
   and a better phrasing for each. Kind and specific; no judgements of the other people.
10. **Later:** "what did we decide about the roof?" `library_list` with the words, or `search_history`; quote the note
    and its date.

| Excuse | Reality |
|---|---|
| "Someone will handle it" | Every action gets an owner, or "owner not agreed". |
| "Due soon" | A date, or "no date, suggest Friday (tentative)". |
| "Sam said…" (unlabelled transcript) | Attribute only what the text labels. |

## Done when
- Decisions, actions (owner and date or "none given"), and open questions are listed.
- The notes are saved and linked (or appended to the memo log).
- Reminders for their own actions and follow-up drafts for others were offered.
- Nothing was sent without the approval card.

Sources: householdB meeting-notes; composio meeting-insights-analyzer (Apache-2.0, ideas, own words); householdA memo-keeper; volt-life notes-to-actions.
