---
name: daily-devotion
description: 'A short daily reflection in the family''s own faith and language: a verse, āyah, hadith, psalm or saying quoted exactly with its reference, a little context, a reflection and one small intention for the day, for adults or children. Use for "a verse for today", "something from the Qur''an about patience", "a daily reflection for the family every morning".'
toolsets: [web]
---

# Daily devotion

Sacred texts are quoted exactly or not at all. A paraphrase inside quotation marks, or a saying attributed to the
wrong source, is worse than no quote.

1. **Their tradition.** `recall` their faith and tradition, languages, preferred translation (for example Sahih
   International or Hamidullah for the Qur'an, a named Bible version) and who it's for (adults, children, the whole
   family). Ask once for what's missing and `remember` it. A family with more than one faith: ask how they'd like it.
2. **Choose the text.** A theme (patience, gratitude, forgiveness, work), the season (Ramadan, the Hajj days, Lent,
   Advent, the High Holy Days) or what they're going through. Avoid repeating recent ones (`search_history`, or the log
   in step 8).
3. **Quote it exactly from a trusted source.** `web_read` a reputable site of that tradition (for example quran.com,
   sunnah.com with the hadith's grading, a Bible society's site, Sefaria), never from memory. Give the original when
   they want it, the named translation, and the reference: surah and āyah; book, chapter and verse; for a hadith the
   collection, number and grading. Flag a weak or disputed saying as such, and leave out sayings whose source you can't
   find, even popular ones.
4. **Context** in 2–3 lines: when and why it was revealed, written or said, from a reputable commentary, named.
5. **A reflection,** short and warm, about daily life, not a sermon. Religious rulings are for their scholar, imam,
   priest, pastor or rabbi; say so when a question turns into one.
6. **One small intention** for the day, 3 to 15 minutes, concrete ("call someone you haven't thanked"), and not the
   same as recent days.
7. **For children:** simpler words, a short story around the verse, and one question to talk about at dinner.
8. **Every morning, if they want it:** `schedule_task` at their chosen time (`cron`, e.g. "30 6 * * *") with
   self-contained instructions: the tradition, translation, language, the trusted sites, the format above, and "don't
   repeat recent texts". If they have the Library, a log of past texts (`library_append`) keeps the repeats away.

Respect their faith as they practise it: no comparing religions, no persuading, no mixing traditions unless asked.

| Excuse | Reality |
|---|---|
| "I know this verse by heart" | Read it from the source and copy it exactly. |
| "A well-known saying of the Prophet" | Find the collection, number and grading, or leave it out. |
| "Roughly, it says…" | No paraphrase in quotation marks. |

## Done when
- The text is quoted exactly from a named, trusted source with its full reference (and grading for a hadith).
- Context, reflection and one practical intention follow, short.
- It suits who it's for (adults or children) and their tradition.
- A daily schedule, if wanted, is set with self-contained instructions.

Sources: volt-life daily-devotion (OpenClaw daily-verse skills; ideas, own words).
