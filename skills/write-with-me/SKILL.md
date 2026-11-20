---
name: write-with-me
description: 'Writing an important piece together with the person, in their voice: a speech or wedding toast, a eulogy, a heartfelt or formal letter, an article or blog post, a personal statement or application essay. Use when they say "help me write…", "aide-moi à écrire…", "ساعدني نكتب…" something that matters and the words have to be theirs, not a quick email.'
toolsets: [library]
examples:
  positive:
    - "Help me write a speech for my sister's wedding"
    - "Aide-moi à écrire l'éloge funèbre de mon grand-père"
    - "ساعدني نكتب رسالة مهمة لبابا"
  negative:
    - "Fix my English in this email"
    - "Write a caption for our bake sale post"
---

# Write with me

Good pieces are built from the person's own stories and phrases, then shaped. Gather first, write second, test last.
Write in the language they want (Arabic, French, English…), and in their register, not yours.

1. **Frame it.** One `ask_user` round, using what memory already knows: who will read or hear it, what it should
   achieve (make them laugh, say goodbye, get the place), length or speaking time, tone, deadline, and any required
   format (word limit, template, prompts to answer).
2. **Gather the raw material.** Invite them to pour everything out, in any order: stories, names, dates, jokes, quotes,
   half-thoughts, voice notes. Interview them where it's thin ("What did she always say?", "When did you first know you
   wanted this job?"). Keep it all in one Library document called "… raw material": create it with `library_create`
   (markdown), then add each new piece with `library_append`, separated by `---`, with no structure. Mention it in
   passing ("added that"). Then ask 3 to 6 numbered gap questions they can answer in shorthand ("1 yes, 3 skip").
3. **Find the thread.** Look for the one phrase or image the whole piece can hang on, and check it with them.
4. **Settle what the audience already knows.** A later part may only lean on what an earlier part established. A
   eulogy for strangers needs more context than one for family.
5. **Offer 2 or 3 openings** with genuinely different angles (a story, a surprising detail, a direct statement), each
   with one line on why it works. They pick one or ask for a mix.
6. **Grow it block by block** in a separate document for the piece (not the raw material, which stays untouched):
   - before every write, `library_read` the current version and keep their edits; learn their style from them;
   - offer 2 or 3 possible next moves, write only the one they choose, with `library_edit` (a patch, not a rewrite);
   - question each block: does it earn its place? prose or a list? does it sound like them?
   The piece ends when its journey is complete, not when the material runs out.
7. **Whole read.** Check the flow, repeated words, filler, contradictions, and cut every sentence that carries no
   weight. Check every name, date and fact against what they told you; never invent a memory or a quote.
8. **Cold-reader check.** Write down 3 to 5 questions the real reader or listener will have. Read the text as someone
   who was not in this conversation and check each is answered; note anything that relies on context only the writer
   has. For an important piece, `delegate` a truly cold read: a `brief` holding only the text and a description of the
   reader, then compare its reading with the intent when it posts back. Fix the gaps.
9. **For speeches:** estimate speaking time (about 130 words a minute), mark pauses, and offer a read-aloud with
   `make_audio` so they can hear it. Keep sentences short enough to say in one breath.
10. **Deliver in the format they need:** the Library document, or a Word file or PDF (`make_word_document`,
    `make_pdf`) if they have office documents. Never send it for them; if they want it emailed, the approval card
    shows it first.

For a child's school piece, coach rather than write it for them (questions, structure, feedback), unless the family
has said otherwise.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "I'll just write a full draft now" | Without their material it sounds like anyone's. Gather first. |
| "Small edits, I'll resend it all" | Patch with `library_edit`; a full rewrite loses their changes. |
| "A made-up anecdote would fit here" | Only their real stories. Ask for one or leave the gap. |
| "It reads fine to me" | You know the context. Do the cold-reader check. |

## Done when
- A raw-material document holds their stories and phrases, untouched by shaping.
- The piece was built block by block from an opening they chose, keeping their edits.
- Facts, names and dates were checked against what they said; nothing invented.
- The cold-reader questions are answered in the text.
- It was delivered in the format they need, and nothing was sent without the approval card.

Sources: mattpocock/skills (writing-fragments, writing-beats, writing-shape); anthropics/skills doc-coauthoring (ideas only, own words); ComposioHQ content-research-writer. See NOTICE.md.
