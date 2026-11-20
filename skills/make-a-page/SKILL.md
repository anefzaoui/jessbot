---
name: make-a-page
description: 'Designing an interactive page that looks made for them, not generated: a one-page site for a club or small business, a dashboard, tracker, calculator, visual plan, guide or comparison, easy to use on a phone. Use whenever Jess is about to build an HTML page in the Library, and for "make it a page", "make it look nice", "a website for our association".'
toolsets: [library]
---

# Make a page

1. **Subject, reader, one job.** Name what the page is about, who will use it (a child, grandparents, customers of a
   bakery) and the one thing it must help them do. Take cues from what you know: their language (Arabic pages run
   right to left: `dir="rtl"`), their tastes, what they liked last time. If the subject is obvious, don't ask.
2. **Real content first.** Gather the actual text, numbers and dates before designing. No lorem ipsum and no invented
   figures: if something is missing, design an honest empty state. Show units and dates; put sources in a footer when
   the data came from the web.
3. **Plan the look before writing code:**
   - **colour:** 4–6 named colours taken from the subject's own world (a sea-and-sand page for a diving club, not the
     default blue), written as CSS variables, with a dark set under `prefers-color-scheme: dark`;
   - **type:** one family, or two that are clearly different; a clear size scale; for Arabic, a font made for it (Noto
     Naskh Arabic);
   - **layout:** one sentence describing the arrangement, and the alignment;
   - **one memorable thing:** the element people will remember; everything around it stays quiet.
4. **Compare the plan with the usual generated look, and change what's a default rather than a choice:**
   - a cream background with a serif headline and a terracotta accent; a near-black page with one acid-green accent;
   - everything in identical rounded cards with the same soft grey shadow; purple or indigo gradients as decoration;
   - an ALL-CAPS label above every heading; "A · B · C" meta lines; an arrow tacked onto every link;
   - 01 / 02 / 03 markers on things that aren't a sequence; one word of a headline in a different colour;
   - a fade-and-slide on every section.
   Any of these is fine when the person asked for it: their words win.
5. **Build it well.**
   - Open with the most characteristic thing in the subject's world, not a generic hero with a big number.
   - Phone first: it must work at 360 px wide with no sideways scrolling; lines under about 80 characters.
   - Real buttons and labels, visible keyboard focus, touch targets at least 44 px, text contrast at least 4.5:1,
     never colour alone to carry meaning.
   - One planned motion at most, and none under `prefers-reduced-motion`.
   - No network calls and no browser storage (the Library blocks them); chart or map libraries only from the allowed
     CDNs, and only when really needed.
6. **Words.** Plain verbs, sentence case. A button says what happens ("Add a chore", not "Submit"), and an action keeps
   the same name everywhere. Errors say what went wrong and how to fix it; an empty state says what to do.
7. **Save and look.** `library_create` with `type: "html"`, a one-sentence `description`, and
   `made_without_being_asked: true` (with a short `why`) when you made it unasked because it reads better as a page. It
   returns the check results (script errors, blocked or failed loads, width and cut-off text on a phone, a blank screen)
   and, for the first version, a phone screenshot: look at both. Fix the real defects once with `library_edit`, then
   stop. Before sharing, remove one decoration.
8. **Hand it over** with the link and one line on how to use it. For print or a picture to send, `library_export`
   (the printables skill covers designs meant for paper).
9. **Remember a stated taste** ("they like bold colours", "no dark mode for Grandma") with `remember`.

| Excuse | Reality |
|---|---|
| "Cards look clean" | Identical cards are the default; choose a layout for this content. |
| "Placeholder numbers for now" | Real data, or an honest empty state. |
| "Looks fine on my screen" | Read the phone check and fix what it found. |
| "One more flourish" | Take one away instead. |

## Done when
- The page uses only real content, with units, dates and sources where needed.
- Colours, type and layout were planned for this subject and checked against the default look.
- The library_create checks were read, real defects fixed once, and the phone view works.
- The reply links the page with one line on how to use it.

Sources: anthropics/skills frontend-design (Apache-2.0, adapted and modified: see NOTICE.md and LICENSE.txt); addyosmani/agent-skills frontend-ui-engineering and its accessibility checklist (MIT, see NOTICE.md).
