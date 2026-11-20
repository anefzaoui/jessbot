---
name: mind-map-page
description: 'Turning a tangled topic into a visual map page: a mind map of an overwhelming week or project, a flowchart of a process (a visa application, a morning routine), a timeline or family plan, the branches of a decision. Use for "map this out", "draw it as a mind map" or "flowchart", "I can''t see the whole picture", or when someone feels swamped by too many threads.'
toolsets: [library]
---

# Mind map page

When everything feels like one big knot, seeing it laid out is half the relief. Keep it short, clear and theirs.

1. **Pick the shape** from what they describe (say which and why in a line):
   - a **mind map** for "too many things at once" (a week, a project, a topic to study);
   - a **flowchart** for a process with steps and choices (a visa application, what to do if the boiler fails);
   - a **timeline** for things across time (a move, a pregnancy, the school year);
   - a **Gantt-style plan** for tasks with dates that overlap (a renovation, wedding prep).
2. **Pull out the structure.** One root, at most about 7 main branches, at most 3 levels deep. Short labels (two to
   five words), their words. Mark status where it helps: done, in progress, blocked, waiting on someone. Take the items
   from the conversation and what you can see (calendar events, list items, goals, if they have them); don't invent
   tasks. If a lot is missing, ask one `ask_user` round.
3. **Build the page** with `library_create` (`type: "html"`), one self-contained file:
   - draw it with Mermaid (mindmap, flowchart, timeline or gantt diagram types), loading the library from
     cdn.jsdelivr.net (the Library allows only cdn.jsdelivr.net, cdnjs.cloudflare.com and unpkg.com, and only when
     needed);
   - a title and a one-line "what this shows", a small legend for the status marks, readable on a phone and in dark
     mode;
   - below the diagram, the same content as a plain nested list, so it still makes sense if the diagram can't load and
     for screen readers.
4. **Check the result.** The save returns a check (script errors, blocked loads, text cut off on a phone) and a phone
   screenshot for the first version: look at it. Fix problems with `library_edit` (a smaller tree, shorter labels, a
   different layout direction).
5. **Talk it through briefly.** In chat: the link, the two or three things that stand out ("three branches wait on the
   landlord's answer"), and one suggested next step. When someone was overwhelmed, end with just one small thing to do
   first.
6. **Keep it alive (offer).** As things change, update it with `library_edit` rather than making a new page. Offer to
   turn branches into list items, reminders or goal steps, and a PNG with `library_export` to share on a phone.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "More branches show more detail" | Seven branches, three levels. Summarise the rest. |
| "The diagram will load, skip the list" | Always add the plain list below it. |
| "I'll fill the gaps with likely tasks" | Only what they told you or what you can see. |
| "It saved, so it looks fine" | Look at the phone screenshot and the check result. |

## Done when
- The shape fits the content, with one root, at most about 7 branches and 3 levels.
- The page loads Mermaid only from an allowed CDN and has a plain-list fallback.
- The check result showed no problems (or they were fixed).
- The chat reply names what stands out and one next step.

Sources: volt-life mind-map-page (mindmap-generator and mermaid ideas); rewritten for Jessbot's Library pages.
