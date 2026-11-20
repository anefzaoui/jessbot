---
name: translate-a-document
description: 'Translating a whole document and giving it back in the same shape: a letter, contract, school report, certificate, manual, CV, a scanned page or a subtitle file, between Arabic, French, English or any language, keeping headings, tables, numbers and names. Use for "translate this PDF into French", "what does this German letter say?", "these subtitles in Arabic".'
toolsets: [library]
---

# Translate a document

1. **Get the text.** An upload: `library_read`, in parts with `start`, or by `pages` for a PDF. A scan or a photo with
   no text layer: `ocr_document` first, which costs money: call it without `confirm` to get the pages and the
   estimate, ask them, and only after a yes call it with `confirm: true`. An email attachment:
   `email_save_attachments`, then `library_read`. A photo in the chat: `view_image`.
2. **What is it for?** To understand it (a short summary plus the lines that matter), or a full translation to use.
   For an official use (a court, an embassy, a university), authorities usually want a certified or sworn
   translation: say that Jess's version is an unofficial working copy.
3. **Glossary first.** Names exactly as in the passport, places, institutions, technical terms, units, date formats
   and currency; the register (formal "vous", standard Arabic unless they ask for a dialect). Keep one choice per term
   all the way through.
4. **Translate section by section,** keeping the structure: headings, lists, tables, numbering, signatures and stamps
   noted as "[stamp: …]". Translate everything; don't summarise. Numbers, amounts and dates stay exactly as written.
   Unreadable source: "[illegible]". Translator's notes only where a term has no equivalent, in brackets.
5. **Give it back in the same form.**
   - Word or PDF: `make_word_document` or `make_pdf` if they have office documents (Arabic runs right to left
     properly); otherwise a Library document with `library_create`.
   - A spreadsheet: `make_spreadsheet` with the same sheets and columns.
   - Subtitles (.srt): keep every number and timing line exactly; change only the text, at most 2 lines of about 42
     characters. Save the result as a Library document for them to save as a .srt file.
6. **Check before handing over:** every section is there (count headings and paragraphs), numbers and dates match the
   original, names are identical everywhere, nothing is left untranslated. Translate one tricky passage back to the
   original language to check the meaning held.
7. **Reply** with the link, the glossary choices that matter, and anything uncertain.

| Excuse | Reality |
|---|---|
| "The gist is enough" | They asked for the document: all of it, same shape. |
| "Mohamed or Mohammed, same thing" | Use the spelling on their papers, everywhere. |
| "Close enough for the embassy" | Official use needs a certified translator: say so. |

## Done when
- Every section of the original is translated, in the same structure and format.
- Names, numbers and dates match the original exactly.
- Unclear or illegible parts are marked, not guessed.
- They know whether an official certified translation is needed.

Sources: volt-life translate-a-document (OpenClaw document and subtitle translation skills; ideas, own words).
