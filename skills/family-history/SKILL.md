---
name: family-history
description: 'Researching family history and genealogy: building a family tree, finding birth, marriage, death, census, parish, court, military or immigration records, weighing sources that disagree, citing them properly, and keeping a research log so nothing is searched twice. Use for "help me trace my grandfather''s family", "where was great-grandma born?", "our family tree".'
toolsets: [library]
---

# Family history

Genealogy goes wrong by searching first and thinking later. Plan, search, log, weigh, and only then conclude.

1. **What's known.** Names in every spelling and script (Arabic, French and English transliterations differ: Ben Ali,
   Benali, بن علي), dates, places (with the old names and borders of the time), and what they've already found or
   been told. One research question at a time: "Where and when was Grandpa Salah born?".
2. **A research plan,** saved with `library_create` (or in a Project if they have projects, so the files stay
   together):
   - 3–7 questions and the people involved;
   - which records exist for that place and period: civil registers, parish or church books, religious court and
     notary records, census, land and inheritance, military, immigration and passenger lists, newspapers, cemeteries;
   - the circle around the person: family, associates and neighbours often appear in the same records;
   - where to start (FamilySearch's research wiki for the place, the national and regional archives).
3. **Search when they ask, following the plan** (if you have the web): FamilySearch, archives' online catalogues, local
   history sites. Log every search, including the empty ones, with `library_append` to a "Research log" document: date,
   where, what you searched for, what you found. "Nothing in the 1921 census for that street" is worth knowing.
4. **Weigh each find.** The source: original, a copy, or someone's compiled tree. The information: given by someone
   who was there (primary) or reported later (secondary). The evidence: answers the question directly, only hints, or
   is missing where it should be. Who gave the information and how would they know? Conflicts go in a small table side
   by side.
5. **Conclude honestly:** proven, probable, possible, unproven or disproven, with the reasoning. Online trees without
   sources are leads, never proof.
6. **Cite every fact:** the item (an entry on a page), the source (the register, year), where it is kept (archive or
   website) and the address and date you accessed it.
7. **The tree.** A clear page (`library_create`) or a table of people with dates, places and the source for each.
   Living people stay private: never share or publish their details without their agreement.
8. **Relatives' memories.** Questions for the older generation (the questions-for-someone skill), voice notes turned
   into dated notes, old photos described and titled with `library_describe`.

DNA tests can help but share very personal data with a company and with unexpected relatives: explain the trade-off
and let them decide; Jess doesn't upload anything for them.

| Excuse | Reality |
|---|---|
| "The online tree says…" | A lead. Find the record it rests on. |
| "Nothing found" | Log where you looked; negative searches count. |
| "Must be the same Salah" | Prove it with dates, places and relatives. |

## Done when
- There is a written plan with the question, the record types and where to look.
- Every search, including empty ones, is in the research log.
- Each conclusion has a proof level and a citation.
- Living people's details stay private.

Sources: composio family-history-research (emaynard; ideas, own words); the genealogical proof standard (general method).
