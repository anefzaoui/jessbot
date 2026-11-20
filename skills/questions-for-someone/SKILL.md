---
name: questions-for-someone
description: 'When a decision needs answers that only another person has (a landlord, builder, school, lawyer, seller, a grandparent, a club): write them a clear questionnaire to fill in, email or go through together. Use for "what should I ask the…", "make a list of questions for…", "send the builder some questions", "a form for relatives to fill in".'
toolsets: [library]
---

# Questions for someone

A good questionnaire gets usable answers on the first try, from someone who wasn't in this conversation.

1. **Ask about the send, not the subject.** The topic is already in the conversation. In one `ask_user` round of two
   questions, find out:
   - who it is for: their role, what they already know, how formal to be, which language they read;
   - what you need back: the decisions or facts riding on their answers.
2. **Write it** with `library_create` (markdown), in the recipient's language:
   - a title and one purpose line (the decision that depends on it);
   - From / To, and how the answers will be used;
   - a short context paragraph for someone who wasn't part of the discussion;
   - "How to answer": a date to reply by, and that "I don't know" is a fine answer;
   - themed sections, the most important question first; one idea per question, each with a blank answer line; a
     "why this matters" line only where a question could be misread;
   - multiple choice where the options are known (tick boxes), open questions where they aren't;
   - a last question: "Anything else we should know?"
3. **Check it.** Every item from "what you need back" has at least one question; no question asks two things; nothing
   is loaded or leading; nothing asks for personal data you don't need (ID numbers, bank details stay out unless the
   process truly requires them, and then only through the proper channel).
4. **Offer delivery:**
   - email, if they have it: `email_send` with the questions in the body (plain text), or with the document attached
     (its Library id in `attachments`); the approval card shows the exact message, recipient and file;
   - a printable PDF (`make_pdf`, if they have office documents) to hand over or take to a meeting;
   - a fillable version on paper for relatives who prefer it.
5. **When the answers come back** (a reply email, a photo of the filled sheet, a pasted text), offer to read them,
   note which questions are still open, and continue the decision they were for. A reminder to chase a reply
   (`set_reminder`) helps when there's a deadline.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "They'll know what I mean" | They weren't here. Add the context paragraph. |
| "Two related questions in one line saves space" | It gets half an answer. Split them. |
| "More questions are more thorough" | Only what the decision needs, the most important first. |
| "I'll send it now to save time" | The approval card shows it first; always. |

## Done when
- Recipient and needed outcome were pinned down.
- The questionnaire has purpose, context, how to answer, themed questions and "anything else".
- Every needed answer maps to a question, and each question asks one thing.
- It was delivered the way they chose, with any email through the approval card.

Sources: mattpocock/skills to-questionnaire (MIT), adapted for Jessbot; see NOTICE.md.
