---
name: polish-writing
description: 'Making a text sound natural and human, or just correct: "fix my English", "proofread this", "corrige mon texte", "صحح لي هذا النص", "less robotic", "make it shorter", "more formal" or "friendlier", "does this sound AI-written?". Works on their own writing or a draft Jess made, keeping the meaning, the facts and their voice.'
toolsets: []
examples:
  positive:
    - "Fix my English in this message"
    - "Corrige les fautes dans ce texte"
    - "صحح لي هذا النص وخليه أوضح"
  negative:
    - "Help me write a wedding speech"
    - "Is my CV good enough to send?"
---

# Polish writing

An edit, not a rewrite. The goal is a text that sounds like its author on a good day.

1. **Keep the language and the purpose.** Answer in the language of the text. Ask only if the audience or the wanted
   tone is truly unclear (one `ask_user` question); otherwise infer it and say so in one line.
2. **Proofread first.** Spelling, grammar, punctuation, agreement, names. In French, accents and agreement of past
   participles; in Arabic, hamza and taa marbuta slips, and consistent use of standard Arabic or dialect (don't mix unless
   the author does).
3. **Look for the tells of machine-sounding or padded text:**
   - **English:** big claims of importance ("plays a pivotal role", "a testament to"); vague authorities ("experts
     say"); ad-copy adjectives; "not only X but also Y"; lists of three by reflex; "serves as", "boasts"; chains of dashes;
     bold scattered through sentences; decorative emoji; openers like "Great question" and closers like "I hope this
     helps"; stacked hedges ("it may potentially"); empty endings ("the future looks bright"); filler ("in order to",
     "due to the fact that"); pet words such as delve, tapestry, vibrant, crucial, robust, seamless, leverage, realm,
     landscape, navigate.
   - **Arabic:** stock openers such as «في عالمنا المتسارع» or «لا شك أن»; «يُعدّ … من أهم …» for everything; «وفي الختام»
     to close a short note; a stiff formal register for a message to family; word-for-word calques from English
     («يلعب دوراً محورياً»); long chains joined with «و» where two sentences would read better.
   - **French:** «Dans un monde en constante évolution», «il est important de noter que», «n'hésitez pas à» repeated,
     «en effet» and «ainsi» sprinkled everywhere, «véritable» and «incontournable» as praise, anglicisms where a plain
     French word exists, a «vous» / «tu» mix within one message.
4. **Rewrite gently.** Concrete words, plain verbs, varied sentence length, at most one hedge, the main point early.
   Keep their facts, their structure and their quirks that work. Never add a fact, a number or a promise. For "shorter",
   cut repetition and throat-clearing before cutting content.
5. **Show the result first**, ready to copy, then one to three short notes on what changed and why. For a long text,
   list the main changes rather than every comma.
6. **Their own voice.** If they have email, you can look at two or three messages they sent (`email_list` with
   `folder: "Sent"`, then `email_read`) to match their greetings, sign-offs and sentence length. If memory holds a note
   on how they write, follow it.
7. **Feedback only?** When they ask "is this OK?" rather than "fix it", give at most three points, each "issue →
   concrete fix", then a verdict. (For a full pre-send review of something important, the draft-feedback skill goes
   deeper.)

Never promise that a text will pass an "AI detector"; they are unreliable, and the goal is good writing, not evasion.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "I'll improve the content too" | They asked for polish. Suggest content changes separately. |
| "A stronger phrase would sound better" | Only if it stays true. No new claims. |
| "It's Arabic, the English list covers it" | Each language has its own tells; check them in that language. |
| "I'll list every change" | One to three notes. The text itself is the answer. |

## Done when
- Spelling and grammar are correct in the text's own language.
- The tells listed above are gone, and meaning, facts and voice are unchanged.
- The clean version comes first, followed by at most three notes.
- No claim of passing AI detection was made.

Sources: volt-life plain-writing (solo-humanize, brw-de-ai-ify ideas); volt householdB polish-writing draft (ai-humanizer); tell lists written in Jessbot's own words.
