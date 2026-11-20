---
name: document-compare
description: 'Comparing two versions of the same document to see exactly what changed: a lease renewal, an updated contract or job offer, new insurance or bank terms, a revised school policy, the draft the other side sent back. Use for "what changed?", "compare these two versions", "is the new one worse for me?", or before signing a renewal.'
toolsets: [library]
---

# Document compare

1. **Which is which.** Find both files (attached, or `library_list`), confirm which is older and which is newer, and
   whose side they're on (tenant or landlord, employee, customer).
2. **Read both fully.** Long documents section by section with `library_read` (`pages` for a PDF, or `start`), keeping
   notes per section with the page. Scans: `ocr_document` first, as in read-long-document. Never compare from one skim.
3. **Line up the sections** by heading or clause number, but match by content too: clauses move and get renumbered.
4. **For each change**: the section, the old and the new text quoted exactly with their pages, the kind (substantive,
   wording only, typo or layout), what it means in practice, and who it favours. Added and removed clauses count too.
5. **Check every quote** against the text before writing it down: a misquote in a contract comparison is worse than none.
6. **Summary first**: the 3–7 changes that matter most (money, rent or price, dates and notice periods, fees and
   penalties, liability, automatic renewal, cancellation, what's covered). Then the full table:
   `| Section | Before (p.) | After (p.) | Kind | What it means | Favours |`. Mark your interpretations as interpretations.
7. **Questions to ask** the other side about each unclear or unfavourable change, ready to paste into a message (the
   questions-for-someone skill can turn them into a form).
8. **Save it** with `library_create` (`type: "md"`) as "What changed: <title>" when there are more than a few changes;
   the reply gives the top changes and the link.
9. **Not legal advice**: say when to see a lawyer (large sums, a dispute, anything binding and unclear).

| Excuse | Reality |
|---|---|
| "Mostly the same wording" | List the changes, then judge which matter. |
| "Clause 7 is now clause 9, so it's new" | Match by content: it moved. |
| "It says roughly…" | Quote it exactly, with the page. |

## Done when
- Both versions were read in full, and it's clear which is newer.
- Every change has before and after quoted exactly, with pages, a kind and who it favours.
- The summary leads with the changes that matter, followed by questions to ask.
- A not-legal-advice line is included.

Sources: composio legal version-diff and long-document pattern (MIT; ideas, own words).
