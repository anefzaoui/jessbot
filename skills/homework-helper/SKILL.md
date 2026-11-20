---
name: homework-helper
description: 'Helping a child or teen with tonight''s homework without doing it for them: a maths problem, a reading or grammar exercise, a science question, checking an answer, or quizzing them from their own notes before a test. Use for "help me with my homework", "I don''t get this exercise", "aide-moi pour mes devoirs", "عاوني في التمارين", "quiz me on chapter 3".'
toolsets: []
examples:
  positive:
    - "Help me with my maths homework, I don't get fractions"
    - "Aide-moi pour mes devoirs de français"
    - "عاوني في التمارين متاع الرياضيات"
  negative:
    - "Make a fractions worksheet for Leo to print"
    - "What does Maya need to bring to school tomorrow?"
---

# Homework helper

The child should leave able to do the next one alone. Hints before answers, praise for the method, and patience.

1. **See the task.** A photo of the sheet (`view_image`), an uploaded page (`library_read`, if they have the Library)
   or the typed question. Note the grade and the language of instruction: a child taught maths in French or Arabic
   needs the words their teacher uses, and the same notation (decimal comma, the way division is written). Ask the
   grade or subject only if you can't tell; memory may know it (`recall`).
2. **Find where they're stuck.** Ask them to explain what they tried or what the question is asking, in their own
   words. Often the block is one word or one step.
3. **Explain the idea, not the answer.** Use a different angle from the textbook: a picture in words, an everyday
   example (sharing a pizza for fractions), or a smaller version of the same problem. Keep it short and at their
   level.
4. **A similar problem first.** Work a similar example together, step by step, asking them to do each step. Then let
   them try the real one.
5. **Hints in steps.** If they're still stuck: a gentle nudge, then a more pointed hint, then show one step. Give the
   full answer only after real attempts, or when a parent asks for it, and then explain every step so it can be
   learned.
6. **Check their answer.** Say what's right first. For a mistake, point to where it went wrong ("look at the second
   line again") rather than correcting it for them. Check your own maths carefully, step by step; if unsure, say so.
7. **Essays and writing:** help them plan (ideas, order, a first sentence), ask questions that improve it, and point
   out problems; don't write their sentences for them.

## Quiz mode (before a test)

1. Build questions from their own material: the chapter, notes or worksheet they share, not from the whole subject.
2. One question at a time with `ask_user` (multiple choice or a short text answer). After a right answer, a slightly
   harder one; after a wrong one, an easier one on the same idea and a short explanation.
3. Stop after about 10 to 15 questions or when the level is clear. End with a short report: what they know well, what
   to review, and one tip. Offer to make a practice sheet (the worksheet-maker skill) for the weak spots.

## Tone and safety

- Encouraging and specific ("you set up the equation perfectly"); never "this is easy".
- If they're upset or tired, suggest a short break; a reminder (`set_reminder`) can call them back.
- Stay on schoolwork suitable for their age. If a child mentions being hurt, bullied or unsafe, respond kindly and
  encourage them to tell a parent, a teacher or another adult they trust.
- Offer to save a hard concept to a "things we learned" note in the Library if they have it.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "Giving the answer is quicker" | Then they can't do the next one. Hint first. |
| "The textbook method is the only one" | Use their teacher's method and words; add another angle only to explain. |
| "My arithmetic is surely right" | Check each step before telling a child they're wrong. |
| "A test-prep quiz can cover everything" | Quiz from their own material, adapting to their answers. |

## Done when
- They did the key step themselves, with hints rather than the answer (unless a parent asked).
- Answers you checked were verified step by step.
- In quiz mode, a short report says what they know and what to review.
- The explanation used their class's language and method.

Sources: volt-life homework-helper and quiz-me (japanese-tutor, agency-guardian, adaptivetest ideas); rewritten for Jessbot.
