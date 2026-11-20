---
name: book-or-memoir
description: 'Writing a book or a family memoir over months: planning the chapters, gathering stories from relatives, keeping names, dates and facts consistent, tracking word counts, never losing a version, and exporting the manuscript to Word or PDF. Use for "I want to write my life story", "help me with my novel", "a memoir of Grandpa''s life for the family".'
toolsets: [projects]
---

# Book or memoir

A book is written in many sittings. The work is keeping everything in one place, in their voice, and never losing a
page.

1. **A home for it.** `project_propose` (field creative) after two short `ask_user` rounds: what it is (memoir, novel,
   family history, children's book), for whom (the family, or to publish), the voice (theirs, told to Jess), language or
   languages, and a target length. The brief holds these.
2. **The shape.** An outline saved with `project_save` ("Outline"): a memoir by life periods or themes, a novel by
   premise, characters and the turns of the story. It will change; that's fine.
3. **The story bible.** A "People, places and dates" file (`project_save`): every name spelled once and for all,
   relationships, dates, places, recurring objects. Before writing a name or a date, `project_search` it so chapter 12
   agrees with chapter 2.
4. **Each sitting.** One chapter or scene. They talk (voice notes arrive as text) or write; Jess shapes it in their
   words, rhythm and dialect, asking about the sensory details and feelings a reader needs, and doesn't invent events.
   Save it as its own file, "Ch 03, Porto 1962 (v2)", and reply with the chapter's word count and the book's total.
5. **Never lose a version.** A rewrite is a new version file; the old one stays. Decisions ("we drop the chapter on the
   move") go in the brief with `project_update`.
6. **Gathering stories.** Questions for relatives (questions-for-someone), their answers saved as dated notes; photos
   described and captioned; dates checked with them, and uncertain ones marked "(to check)".
7. **Sensitive things.** Living people, family conflicts, health, secrets: ask before including, and mark passages
   that should be read by the people concerned before anyone else sees them.
8. **Exporting.** The whole manuscript in order, as a Word file with chapters (`make_word_document`) or a print-ready
   PDF (`make_pdf`) if they have office documents; an audio version for a grandparent with `make_audio` if they have
   the Library.
9. **Momentum,** if they want it: a weekly writing time with `set_reminder` (`repeat: "weekly"`), and a goal with
   `goal_suggest`.

| Excuse | Reality |
|---|---|
| "I'll tidy the old chapter" | Save a new version; keep the old. |
| "His name was Moncef, or Mounsef" | Check the story bible; one spelling everywhere. |
| "Let me polish it" | Keep their voice; polish only what they ask. |

## Done when
- The book lives in a Project with a brief, an outline and a story bible.
- Each sitting's chapter is saved as a versioned file with word counts reported.
- Names and dates were checked against the story bible.
- Sensitive passages were agreed with them; exports work on request.

Sources: volt-life book-or-memoir (OpenClaw novel-writing and memoir skills; ideas, own words).
