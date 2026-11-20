---
name: spreadsheet-analysis
description: 'Making sense of a table they share that isn''t their bank statement: school grades, sports results, energy or water meter readings, a survey, a small shop''s sales, a club list. Use for "analyse this spreadsheet", "what does this data show?", "any trends here?", "clean up this Excel", "make a chart of this", "which month was highest?".'
toolsets: [office, library]
---

# Spreadsheet analysis

1. **The question first.** What do they want to know or decide? ("Is Leo's maths improving?", "which month did we use
   the most water?", "which products sell best?") If they only say "analyse this", choose the 2–3 questions the data can
   answer and say which.
2. **Read all of it** with `library_read` (continue with `start` to the end; `pages` for a table in a PDF). Describe
   what's there: the columns and their types, how many rows, the date range, blanks, duplicates and odd values (text in a
   number column, a totals row mixed into the data, units that change). Say what you'll clean and how; never drop rows
   quietly.
3. **Compute with formulas, never in your head.** `make_spreadsheet` with the cleaned data on the first sheet and the
   answers on a second one, as formulas (`SUMIFS`, `COUNTIFS`, `AVERAGEIFS`, `MAXIFS`, growth as `=(new-old)/old` in
   percent format). Put any assumption (a price, a target) in its own `input: true` cell. Fix the formula problems the
   reply lists and remake with the same `id`. Quote the numbers the workbook computed (`library_read` it), not your own
   sums. For a small change to their own workbook, `sheet_set_cells` keeps everything else intact.
4. **A chart when a picture helps**: a line for change over time, bars to compare groups, a pie only with 5 slices or
   fewer. An HTML page with `library_create` (inline SVG, or a small chart library when really needed; the data inline;
   readable in dark mode), and `library_export` as a PNG to share.
5. **Findings in 3–5 lines with numbers** and a comparison ("July's water use was 38% above the monthly average"), one
   or two suggestions, and the caveats: missing months, small numbers, and that two things moving together doesn't mean
   one causes the other.
6. **Know the neighbours.** A bank or card statement belongs to household-budget; everyday spending notes to expense-log.

| Excuse | Reality |
|---|---|
| "The average is about 14" | Put it in a formula and read the computed value. |
| "The blank rows don't matter" | Say how many there are and how you handled them. |
| "Sales rose because of the ad" | Say "rose after", not "because of", unless the data shows it. |

## Done when
- The data's shape, gaps and cleaning steps are stated.
- Every number in the answer was computed by the workbook's formulas.
- The findings answer their question with comparisons, plus the caveats.
- A chart exists only where it makes the answer clearer.

Sources: household review drafts (spreadsheet-analysis); composio csv-data-summarizer (MIT; ideas only, "never ask" rule dropped).
