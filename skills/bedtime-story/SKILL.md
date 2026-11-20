---
name: bedtime-story
description: 'A bedtime story or short tale made up for someone: for a child with their name, age and favourite things and a calm ending, or a fable for grown-ups. Told in chat, as a voice note, or as a longer recording to play again. Use for "tell me a story", "bedtime story for Maya", "une histoire pour dormir", "حكاية قبل النوم", "a fable about patience".'
toolsets: []
examples:
  positive:
    - "Tell Maya a bedtime story about a brave little cat"
    - "Raconte une histoire pour dormir à Leo"
    - "احكيلي حكاية قبل النوم للصغار"
  negative:
    - "Let's play an adventure game where I'm a pirate"
    - "Write a letter for my son to open when he's 18"
---

# Bedtime story

Short, warm and made for this child tonight. The last lines should make them sleepy, not excited.

1. **Who is it for?** `recall` the child's name, age, favourite things, pets, friends and recurring characters from
   earlier stories. If you don't know them, one `ask_user` round: for whom, a theme or hero, length (about 2, 5 or 10
   minutes), language, and whether they want to hear it or read it.
2. **Fit it to the age:**
   - 3 to 5 years: 250 to 400 words, simple sentences, a little repetition they can join in on;
   - 6 to 8 years: 400 to 700 words, a small adventure and a kind lesson;
   - 9 to 12 years: up to about 1,000 words, a bit of gentle suspense resolved well before the end.
3. **Always, at bedtime:** nothing frightening, no villains who win, no romance, no brand names, no licensed characters
   (make up your own). Personal details only from memory or what was just said. The ending is calm and cosy.
4. **Shape:** an opening picture with the child as the hero (or their favourite animal), a small problem, a kind or
   clever solution, and a warm ending that winds down (the lights, the stars, a yawn).
5. **Language:** in the language they want. Arabic: simple Modern Standard Arabic unless they ask for their dialect;
   French or English: simple, rhythmic sentences. For bilingual families, offer the same story in the other language.
6. **Grown-up fable mode:** a short fable in the voice of a historical, mythical or invented figure; concrete images,
   wonder rather than gloom, 700 to 1,000 words, ending on an image rather than a moral.
7. **How to tell it:**
   - text in chat: short paragraphs, easy to read aloud;
   - a voice note: call `reply_by_voice` before writing, and keep it to about 250 to 280 words (voice notes are short);
     for a longer story, tell part 1 and offer part 2;
   - a longer recording they can play at bedtime again: `make_audio` with the story text and a title (if they have the
     Library); tell them roughly how long it will be, since it takes a while to record.
8. **Keep it (offer):** add it to a "Stories for Maya" document in the Library (`library_append`), or a printable
   booklet with `make_pdf` (if they have office documents). `remember` recurring characters the child loves, so the
   next story can bring them back.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "A scary twist makes it exciting" | Not at bedtime. Gentle suspense only, resolved early. |
| "I'll guess the child's age" | Check memory or ask; length and words depend on it. |
| "A famous cartoon character would be fun" | Invent your own characters. |
| "A long story as one voice note" | Voice notes are short. Split it, or record it with make_audio. |

## Done when
- The story fits the child's age, uses only known personal details, and ends calmly.
- Nothing frightening, romantic, branded or licensed is in it.
- It was delivered the way they wanted (text, voice note or recording).
- Keeping it and remembering favourite characters was offered.

Sources: volt householdB bedtime-story draft (lyrical-fable idea); volt-life bedtime-story (audio-gen idea); rewritten for Jessbot.
