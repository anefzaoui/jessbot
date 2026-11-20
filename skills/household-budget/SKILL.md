---
name: household-budget
description: 'Making sense of where the household''s money goes from bank or card statements they upload (CSV, Excel or PDF): spending by category and month, budgets, forgotten subscriptions and one realistic saving, in a workbook they keep. Use for "where does our money go?", "analyse my bank statement", "un budget pour la maison", "وين تمشي الفلوس؟", "what subscriptions am I paying for?".'
toolsets: [library, office]
examples:
  positive:
    - "Where does our money go every month? Here's the bank statement"
    - "Aide-moi à faire un budget pour la maison"
    - "حلل كشف الحساب البنكي متاعي وقلي وين تمشي الفلوس"
  negative:
    - "Split the dinner bill between Theo and me"
    - "Did I pay the gas bill?"
---

# Household budget

1. **The right file.** The bank's or card's "export transactions" as CSV or Excel is best; a PDF statement works too.
   Jess can't connect to banks and never needs their online banking login. Read all of it with `library_read`
   (continue with `start`, or `pages` for a PDF). A scanned PDF has no text: offer `ocr_document`, which asks before
   spending.
2. **Understand the columns first**: date, description, amount (or separate debit and credit), balance, currency. Dates
   may be DD/MM or MM/DD (a day over 12 settles it); amounts may use decimal commas ("1.234,50"). Say in one line how you
   read it.
3. **Check the totals.** Your money in and out must match the statement's own totals, or opening balance + in − out =
   closing balance. If not, find the missing rows before going on.
4. **Categorise**: groceries, eating out, transport and fuel, bills and utilities, rent or loan, school and kids,
   health, shopping, subscriptions, charity and zakat, cash, income, other; transfers between their own accounts are
   left out of spending. Apply remembered rules first (`recall` "budget rule"). Ask once, in one `ask_user`, about the
   biggest unknown merchants, and `remember` each answer as a rule ("Budget rule: MONOPRIX = groceries").
5. **Find the subscriptions**: the same merchant at a similar amount about every month (or year). List each with amount,
   how often, last date and yearly cost; flag price rises and doubles (two music services).
6. **Build the workbook** with `make_spreadsheet`, all maths in formulas, never in your head:
   - **Transactions**: Date (date), Description, Amount (currency, money out negative), Category, Account, Month (text
     "YYYY-MM");
   - **Summary**: categories down, months across (headers "2026-08"…), each cell
     `=SUMIFS(Transactions!C:C,Transactions!D:D,$A2,Transactions!F:F,B$1)`, then a Budget column (`input: true`) and a
     % used column;
   - **Subscriptions**: merchant, amount, how often, yearly cost as a formula.
   Past 2,000 rows, one Transactions sheet per year. Fix any formula problem the reply lists and remake with the same `id`.
7. **Summary in chat, 3–5 lines**, quoting the numbers the workbook computed (`library_read` it): money in and out, the
   top three categories, the change against last month or the budget, subscriptions found, and one concrete saving ("the
   two streaming services cost 540 a year").
8. **Budgets** on request: `remember` each ("Budget: eating out 300 a month") and put it in the Budget column; compare
   on the next statement. Day-to-day spending notes belong to expense-log.
9. **A monthly rhythm** (offer): a `set_reminder` on the 2nd of the month with `repeat: "monthly"` to upload last
   month's statement, since Jess can't fetch it.

Money is private: keep it in their own Library, and never mention it in group chats or to other household members.

| Excuse | Reality |
|---|---|
| "Roughly 1,200 on groceries" | Read the Summary cell; quote the computed figure. |
| "Close enough to the statement total" | Totals must match: find the missing rows. |
| "That merchant looks like shopping" | Unknown big ones: ask once, then remember the rule. |

## Done when
- Every transaction is in the workbook, and the totals match the statement.
- Each category and month total is a formula, not a typed number.
- Subscriptions are listed with their yearly cost.
- The chat summary quotes computed numbers and names one concrete saving.

Sources: household review drafts (household-budget); OpenClaw expense-tracker statement import and budget-tracker skills (ideas, own words).
