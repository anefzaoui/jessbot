---
name: difficult-conversation
description: 'Hard messages and hard talks: a complaint or refund dispute, pushing back on a landlord, school, employer or contractor, setting a boundary with family, saying no, asking for something awkward, answering an angry message. Use for "how do I tell them…", "help me reply politely but firmly", "I need to have a difficult talk with…".'
toolsets: []
---

# Difficult conversation

Clear and kind beats clever. The aim is the outcome they want and a relationship that survives it.

1. **Get the situation.** Who it is, the relationship, what happened (the actual message: `email_read` if they have
   email and it came by mail, or the pasted text). Keep relationship matters private: nothing from this chat goes into
   group memory or other chats.
2. **What do they really want?** For themselves, for the other person, and for the relationship. Ask it if it isn't
   clear (one `ask_user` round). Watch for the false choice between "say nothing" and "blow up": there is almost always a
   third way.
3. **Facts before stories.** Separate what happened (dates, amounts, words said) from the story told about it ("they
   don't respect me"). Gently check the story against the facts; point out what the other side may be feeling or
   fearing.
4. **Pick a shape:**
   - **Written reply to a dispute** (landlord, shop, school, contractor): acknowledge their specific point in one line;
     your position or request up front in one sentence; one reason; a concrete next step or deadline. About 120 words.
     No "I'm sorry you feel that way", no "as per policy", no pile of hedges.
   - **Boundary or request:** what I noticed → how it affects me → what I'm asking for. Add "I'm not saying X, I am
     saying Y" when they fear being misread.
   - **A talk in person:** an opening line, the two or three points to make, likely reactions with a calm answer to
     each, and a clear ask at the end.
5. **Draft in their voice**, in the language and register the other person expects. Offer two tones: warmer and firmer.
   Keep facts exact: amounts, dates, reference numbers from what they gave you. Don't invent a legal right; if one
   matters, look it up on an official source first (if they have the web) and say where it comes from.
6. **Cool-off.** A heated message gets the one-hour hold, offered once: `set_reminder` with `in_minutes: 60` and the
   draft in its `text` (if they have reminders). Their call.
7. **Send only with the approval card.** If they have email and want it sent, `email_send` with the original's uid as
   `reply_to_uid` so it threads; the card shows the exact text. Otherwise hand over the text to copy.
8. **After sending:** offer a follow-up reminder ("no answer by Friday? nudge them") and a short dated note of what was
   agreed, for the record.

Harassment, threats or anything legal: don't draft a comeback. Suggest keeping a record (dates, screenshots), and
getting advice from the right body (a lawyer, a consumer office, the school's head). If someone may be in danger, say
so and point to local emergency help.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "Softer is always safer" | Too soft gets ignored. State the request plainly, once. |
| "Let's list every grievance" | One point, one reason, one next step. Extra grievances dilute it. |
| "They're clearly in the wrong" | Maybe. Write it so a neutral reader would agree. |
| "They told me to send it now" | Heated? Offer the one-hour hold once, then respect their choice. |

## Done when
- The outcome they want is stated in one line.
- The draft has one clear position or request, one reason and a concrete next step, in their voice.
- A warmer and a firmer version were offered.
- Nothing was sent without the approval card; a follow-up was offered.

Sources: volt-life difficult-conversation (communication-skill, crucial-conversations-coach ideas); ComposioHQ review tough-reply (rockscy email-customer), rewritten for Jessbot.
