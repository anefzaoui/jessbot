---
name: worksheet-maker
description: 'Making printable practice sheets for children: maths drills and word problems, times tables, fractions, spelling, grammar or reading comprehension, at the right level, with a separate answer key, as a PDF. Use for "make Leo a fractions worksheet", "a practice sheet for Friday''s test", "20 subtraction problems to print", "spelling list exercises".'
toolsets: [office]
---

# Worksheet maker

A good sheet is at the right level, unambiguous, and has an answer key that is certainly right.

1. **The brief.** The child's grade or age (memory may know it: `recall`), topic, number of items (10 to 20 drills or
   6 to 10 word problems is a good default), the language of instruction, and how their school writes things: decimal
   comma or point, the division sign, units, the alphabet and direction for Arabic. If they share a photo of homework
   (`view_image`), match its style and notation. Ask only what you can't infer, in one `ask_user` round.
2. **Design the sheet.**
   - Start easy and get a little harder through the sheet, mixing sub-types (for fractions: compare, add, simplify).
   - Word problems use familiar names, places and the local currency, and each has exactly one correct reading.
   - Nothing ambiguous: say whether to simplify, round, or show working.
   - For spelling and reading: words from their list or level; comprehension questions answerable from the text.
3. **Solve everything yourself, step by step**, before writing the key.
4. **Check the maths with formulas** (for any sheet with arithmetic). Make a check workbook with `make_spreadsheet`
   titled "Answer check - …": column A the problem written as a formula ("=37*8", "=3/4+1/8", "=(120-45)/5"), column B
   your answer as a number, column C =IF(ABS(A2-B2)<0.0001,"ok",1/0) on each row. Every formula is computed when the
   file is made and any error is listed by cell in the reply, so a wrong answer shows up as a #DIV/0! on its row. Fix
   each flagged answer (the problem or the key) and make it again with the same `id` until no problem is listed. For
   word problems, write the formula from the numbers in the problem, not from your answer.
5. **Make the worksheet** with `make_pdf`:
   - a title, "Name: ______  Date: ______", one clear instruction line;
   - numbered problems with space or "________" answer lines; tables where they help;
   - maths in LaTeX: $\frac{3}{4}$, $x^2$, $\sqrt{16}$, $12 \div 4$ inline, or $$...$$ on its own line (write a plain
     dollar sign as \$);
   - a line holding only \newpage starts a new page, for example after a one-page study sheet or to keep a long sheet
     tidy.
   Arabic and other right-to-left text is laid out properly.
6. **Make the answer key** as a separate `make_pdf` (so the child can have the sheet without the answers): every
   answer, with full working for multi-step problems.
7. **Optional study sheet** (offer it): for each skill on the sheet, the rule in one line, one worked example and one
   common mistake. It can be the first page of the worksheet PDF, followed by \newpage.
8. **Hand over** the links in this order: study sheet (if any), worksheet, answer key. Offer another level (easier or
   harder), or a new sheet each week with `schedule_task` if they have schedules (it runs unattended and just posts the
   new sheet).

## Excuses → reality

| Excuse | Reality |
|---|---|
| "I did the sums in my head" | Put them through the formula check. |
| "The formula check says ok, done" | Also check that the formula matches the problem as the child will read it. |
| "One page of the same drill is fine" | Vary the sub-types and let difficulty rise. |
| "The key can go on the back" | A separate PDF, so the sheet can be printed alone. |

## Done when
- The sheet matches the child's level, language and notation.
- Every arithmetic answer passed the formula check with no listed problem.
- The worksheet and a separate answer key exist as PDFs, with maths rendered properly.
- The links were handed over in order.

Sources: volt householdB worksheet-maker draft (OpenClaw math-worksheets idea, method only); rewritten for Jessbot's make_pdf and make_spreadsheet.
