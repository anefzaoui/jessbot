---
name: expense-log
description: 'Jotting down spending as it happens in a running expenses ledger: a receipt photo, a payment text or screenshot, or quick notes like "lunch 18", "petrol 60". Also shared costs between people (a trip, housemates, "I paid, you owe me"), who owes whom and settling up, and "how much have we spent on food this month?".'
toolsets: [office, library]
---

# Expense log

1. **Their ledger.** `library_list` "Expenses <year>" (or the name they use; one per person or one shared for the
   household, as they choose). None yet: make it with `make_spreadsheet`:
   - **Transactions**: Date (date), Merchant, Category, Amount (currency), Paid with, Who paid, Split with, Note, Month
     (text "YYYY-MM");
   - **Summary**: categories down, months across, each cell a `SUMIFS` on Category and Month so it stays live;
   - **Shared** (only when costs are split): Person, Paid, Share, Balance, all formulas.
   Currency: from memory; if unknown, ask once and `remember` it.
2. **Read the entry loosely.** "lunch 18" means today, eating out, 18 in their currency. A receipt or a bank text
   screenshot: `view_image` for the date, merchant (as written, not translated), total and how they paid. Refunds are
   negative. Guess the category and name it in the confirmation; ask only about an amount you can't read.
3. **Add it** with `sheet_append_rows` on the Transactions sheet, rows as `{ "Date": "2026-09-26", "Merchant": "…",
   … }`. Read the last rows first (`library_read`) and skip an exact repeat (same date, merchant and amount) unless they
   say it really happened twice. Several receipts at once: one call with all the rows.
4. **Confirm in one line with one small insight**: "Added: 64.30 at the supermarket, groceries. Groceries this month:
   412." A correction: fix the cell with `sheet_set_cells`, and `remember` merchant rules they teach you.
5. **Shared costs.** Note who paid and who shares ("split 90 dinner with Theo and Priya" is three shares of 30). For "who
   owes whom", each person's paid minus share comes from formulas on the Shared sheet; settle up in the fewest transfers
   (whoever owes most pays whoever is owed most, and repeat until everyone is at zero). Show the transfers as a short
   list; nobody's money moves because of this skill.
6. **Questions** ("how much on food this month?", "more than last month?"): `library_read` the Summary sheet (its numbers
   are computed) and answer with exact figures. A whole bank statement goes to household-budget instead.
7. **Budgets they set**: mention it once when a category passes 80%, and again at 100%, at the moment you log; no
   nagging in between.

Privacy: at most the last 4 digits of a card, never bank logins. Keep a personal ledger out of group chats.

## Done when
- The entry is one new row with date, merchant, category and amount, and no duplicate was added.
- The confirmation states the category and one running total from the sheet.
- Shared costs show who owes whom and the fewest transfers to settle.
- Every total quoted comes from the sheet's formulas.

Sources: household review drafts (expense-log); OpenClaw pocket-lens, expense-tracker, split-expenses skills (ideas, own words).
