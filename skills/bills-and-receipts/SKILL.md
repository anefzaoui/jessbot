---
name: bills-and-receipts
description: 'Keeping household paperwork straight: bills, invoices, receipts and official letters from their email or photos. What''s due and when, reminders before due dates, "did I pay the electricity?", "range mes factures", "وين فاتورة الضوء؟", filing so things are easy to find, and a bundle for the accountant or tax return, emailed only with their OK.'
toolsets: [library]
examples:
  positive:
    - "Did I pay the electricity bill this month?"
    - "Range mes factures et dis-moi ce qui est à payer"
    - "وين فاتورة الماء؟ وشنوة الفواتير اللي ما خلصتهاش"
  negative:
    - "Analyse my bank statement and tell me where our money goes"
    - "I spent 45 on petrol, log it"
---

# Bills and receipts

1. **Scope.** Last month by default, or the supplier, period or purpose they name (the tax year, an expense claim,
   "the accountant needs the third quarter").
2. **Gather.**
   - Uploads and photos: `library_list` with "bill", "invoice", "receipt", "facture", "فاتورة" and supplier names.
   - Email, if connected: several `email_list` searches with `subject` or `text` and `since`, in their languages
     (invoice, receipt, bill, payment due, order confirmation, facture, reçu, échéance, فاتورة, وصل), merged by uid.
     `email_read` each and skip marketing. Keep the PDFs they'll need with `email_save_attachments`.
3. **Read each one**: `library_read`, or `view_image` for a photo. A scan with no text: offer `ocr_document` (it shows the
   cost and asks first). Note the supplier, date, number, amount and currency, tax, due date, paid or unpaid, and the
   payment reference. Mark what you read versus guessed; an unreadable total goes on a "Needs you" list, never an
   estimate. Repeat only the last 4 digits of any account or card number.
4. **Spot trouble.** Same supplier, date and amount twice: a possible duplicate, listed rather than dropped. "Pay now by
   this link", "our bank details have changed", or a new account number on a familiar bill: likely fraud. Use scam-check
   and tell them to confirm by phone on a number they already had. Never pay from an email link.
5. **The ledger**: `make_spreadsheet` (or `sheet_append_rows` to their existing one) with Date, Supplier, Type, Number,
   Amount, Currency, Due, Status and the Library link; totals per currency; a By category sheet with `SUMIF` formulas.
   In chat: the total and each unpaid item with its due date.
6. **Due dates.** Offer, in one `ask_user`, a `set_reminder` 3 days before each unpaid due date. Something is paid only
   when they say so; then update its Status (`sheet_set_cells`).
7. **Filing.** Give each document a findable title and description with `library_describe`: "2026-08 Electricity bill,
   84.20, due 15 Sep". For "did I pay X?" or "where's the car insurance?": `library_list` with the supplier, plus `recall`.
8. **For the accountant or the tax return** (on request): merge the PDFs in date order with `pdf_merge`, then attach it
   and the spreadsheet with `email_send` `attachments`; the approval card shows the message and files before anything
   goes. How long to keep records depends on the country: say so rather than stating a number.
9. **Recurring charges** (phone, streaming, gym): list them as subscriptions and ask whether each is still wanted;
   switch-provider helps cancel one.

IDs, passports and medical papers stay private; never email them unless they explicitly ask.

| Excuse | Reality |
|---|---|
| "The total is probably 84" | Unreadable goes on "Needs you". |
| "It looks paid" | Paid is what they tell you. |
| "The new bank details are on the invoice" | Changed details are a classic fraud: confirm by phone first. |

## Done when
- Every bill in scope is in the ledger with amount, due date and status, or on "Needs you".
- Unpaid items with due dates were offered reminders.
- Possible duplicates and fraud signs are named.
- Documents have findable titles; nothing was sent without the approval card.

Sources: household review drafts (bills-and-receipts, paperwork); composio invoice-organizer (Apache-2.0; ideas, own words); volt-dev subscription review; OpenClaw receipt skills (ideas, own words).
