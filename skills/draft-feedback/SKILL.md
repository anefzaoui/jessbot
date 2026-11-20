---
name: draft-feedback
description: 'Reviewing something before it goes out, without taking it over: "is this OK to send?", "check my…", "what do you think of my draft?", for a CV, cover letter, school essay, complaint, speech, form answers, a message to a boss or teacher, or any important email. Gives ranked, quoted fixes and one honest verdict.'
toolsets: []
---

# Draft feedback

A review, like a good friend with an editor's eye: honest, specific, and respectful of their voice.

1. **Who is it for and what must it achieve?** Infer it from the text and the conversation; ask in one `ask_user`
   round only if it's unclear (the reader, the goal, any rules such as a word limit or a job ad).
2. **Read all of it** before commenting. An uploaded file: `library_read` (if they have the Library). A job ad or
   instructions it must match: read those too (`web_read` for a link, if they have the web).
3. **Check four things:**
   - **Correct:** names (especially the recipient's), dates, numbers, facts, spelling, the right company or school.
   - **Clear:** the main point early, a structure the reader can follow, the right length.
   - **Fits the reader:** tone, level of formality, what this reader cares about; the language and register expected
     (a French administration, an Arabic family message, an English job application all differ).
   - **Safe to send:** oversharing, promises of money or time they may not mean, legally risky or angry wording,
     personal data that doesn't need to be there.
4. **Label each point** Must fix / Worth changing / Optional / Nit. Quote the exact line and give a proposed rewrite.
   Group them by label, the must-fixes first.
5. **Lead with what matters.** One structural problem outweighs ten commas: if the opening buries the point, say that
   before anything else. Name at least one specific thing that works, so they keep it.
6. **Be honest.** Don't soften a real problem into a "maybe", and don't rubber-stamp. If it's ready, say so plainly.
7. **Verdict in one line:** ready to send / send after the must-fixes / needs another pass, and why.
8. **Keep their voice.** Offer a clean revised version only if they want one: in chat, a Library document, or a Word
   file (`make_word_document`, if they have office documents). If they want it sent, the approval card shows the final
   text; you never send on your own.

For a child's schoolwork, point to the problem and ask a question that leads them to the fix, rather than handing over
corrected sentences.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "It's mostly fine" | Say exactly what isn't, with the line quoted, or say it's ready. |
| "I'll just rewrite it better" | They asked for a review. Suggest; don't replace their voice. |
| "Lots of small notes show effort" | Rank them. The one structural issue comes first. |
| "The name is probably right" | Check the recipient's name and title against the source. |

## Done when
- Every point has a label, a quoted line and a proposed fix.
- The most important issue is first, and at least one strength is named.
- Facts, names and dates were checked.
- There is a one-line verdict.

Sources: addyosmani/agent-skills (code-review-and-quality, code-reviewer persona), adapted and rewritten for Jessbot; see NOTICE.md.
