---
name: academic-writing
description: 'School or university writing that needs real references: an essay, report, literature review, dissertation or thesis chapter, in a citation style such as APA, Harvard, MLA, Chicago or numbered. Use for "find sources for my essay", "help me structure my thesis", "check my references". Finds scholarly sources, verifies every citation, and coaches students when that is the rule.'
toolsets: [web]
---

# Academic writing

The one unbreakable rule: every reference must be real and must say what the text claims it says. A made-up
citation can cost a student the whole assignment.

1. **The brief.** Topic or question, level (secondary school, bachelor, master, PhD), length, citation style,
   language, deadline, and the marking rubric or assignment sheet if there is one (`library_read` for an upload, if they
   have the Library). Ask what's missing in one `ask_user` round.
2. **Who writes it?** For a pupil or student, the default is to coach: explain, help plan the argument, find and
   explain sources, give feedback on their drafts, and leave the writing to them. Remind them of their school's rules on
   AI use. Follow any instruction the family or the person gave about this; for an adult writing their own work, help
   as much as they ask.
3. **Find sources.** Search scholarly places rather than the general web: `open_search` with `site: "google_scholar"`,
   `"pubmed"` (health), `"arxiv"` (physics, maths, computing), `"semantic_scholar"` or `"crossref"`, the topic's key
   terms as `query` (in the language of the field; English literature plus local-language sources when the topic is
   local) and `year_from` when recent work matters. The publisher's page, a university repository and official
   statistics offices count too (`web_search`). Open the abstract or the paper with `web_read` (PDFs are read with page
   markers). Wikipedia and blogs are for orientation only, never as citations.
4. **Verify every citation.** Before a source goes on the list, you have opened it (or its official abstract page),
   and author, year, title, journal or publisher, and the DOI match. A DOI can be checked by opening
   https://doi.org/ followed by it. If you can't confirm a source, leave it out and say so. Never cite a page number or
   a quote you haven't seen.
5. **Build the argument.** A thesis statement or research question, then an outline: introduction, sections each with
   a claim, evidence (which sources) and a link back to the question, and a conclusion. For a literature review, group
   sources by theme or debate, not one paragraph per paper. Show the outline and agree on it before drafting.
6. **Draft or give feedback by section.** Cite as you go in the chosen style; tables and figures only from real data
   in the sources. On their own draft: structure, argument strength, use of evidence, clarity, and whether each claim is
   supported; quote the line and suggest a fix.
7. **Reference list.** Formatted exactly in the chosen style, sorted as the style requires, each entry matching an
   in-text citation and the other way round.
8. **Deliver.** In chat or a Library document, or a Word file with `make_word_document` (headings, references) if they
   have office documents. Offer a reminder before the deadline.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "This paper probably exists" | Open it or leave it out. |
| "The abstract is enough to quote" | Quote only what you have read in full text; otherwise paraphrase the abstract and say so. |
| "Wikipedia has the facts" | Follow its reference to the original and cite that. |
| "Writing it for them is faster" | For a student, coaching is the job unless the family said otherwise. |

## Done when
- The brief (level, length, style, deadline) is pinned down and the coaching-or-writing question is settled.
- Every reference was opened and matches author, year, title and DOI; unconfirmed ones were dropped.
- The argument has an agreed outline, and each claim points to a real source.
- In-text citations and the reference list match, in the chosen style.

Sources: volt householdA academic-writing draft (OpenClaw academic writing skill, method only); ComposioHQ content-research-writer ideas.
