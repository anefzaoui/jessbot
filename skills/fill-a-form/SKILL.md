---
name: fill-a-form
description: 'Filling in an online form for someone with Jess''s own browser: a school or club sign-up, an appointment request, a visa, permit or enrolment application, a contact or claim form. Uses what she already knows about them and shows the filled form for review before anything is submitted.'
toolsets: [web]
---

# Fill a form

1. **Open it and look at everything first.** `browser_open` the form and `browser_snapshot` to list every field, and how
   many pages there are. If the form is a PDF rather than a web page, use `pdf_form_fields` and `pdf_fill_form` instead
   (office tools).
2. **Gather the answers before typing.** Take what you already know (`recall`, their Library documents), then one
   `ask_user` round for everything missing, as text or choice questions. For a long form, keep a private checklist
   document (`library_create`) with each field and its answer, so the work can resume if it stops halfway.
3. **Fill it in.** `browser_type` for text, `browser_select` for lists, `browser_pick_date` for dates, `browser_click` for
   boxes and buttons. After each page, `browser_snapshot` again to check what took, and fix what didn't. For a long,
   repetitive form, `browser_autopilot` with a goal that ends "stop before submitting".
4. **Files.** For a photo or document the form wants, `browser_upload` one of their own Library files (it asks them
   first). If that can't work, hand over with `ask_user` and `show_screen: true` so they can attach it themselves.
5. **Sign-ins, captchas and codes are theirs.** Hand over with `show_screen: true`; they type passwords and one-time codes
   themselves on the site, never in chat, and you never type a password or card number for them.
6. **Keep the reference.** Note the application or reference number, and how to resume (non-secret), in the checklist.
7. **Review before submitting.** Read back every answer in a short list with a screenshot (`browser_screenshot`) of the
   filled form, and ask them to confirm. Submitting goes through the approval card. At a payment step, stop: they pay
   themselves, or approve the exact amount on the card.
8. **After.** Report the confirmation number and what happens next; offer reminders (the appointment date, documents to
   bring) and, with their OK, `remember` new non-secret facts for the next form.

Only fill in what this form needs: an ID or passport number goes into the form, not into memory, unless they ask.

## Done when
- Every field is filled from known facts or their answers, and nothing was invented.
- They saw the filled form (list and screenshot) before submitting.
- Submitting and any payment went through their approval, and no password or card number was typed by Jess.
- The confirmation or reference number is reported, with next steps and reminders offered.

Sources: OpenClaw autofillin (MIT; ideas, own words) and official-form-filler skills; browser review drafts.
