---
name: family-update
description: 'A news round-up for people who aren''t there day to day: a monthly family newsletter for grandparents and relatives abroad, a year-end or holiday letter, or a short "what''s happening this week" note for the household with progress, plans and problems. Use for "write the family update", "news for grandma", "what''s on this week for us".'
toolsets: []
---

# Family update

Warm, specific and short. Relatives want the real little things ("Maya lost her first tooth at the beach"), not a
report.

1. **Which kind, for whom, which period?** Infer it from the request; ask only what's missing in one `ask_user` round:
   - a **newsletter** for relatives (the last month or season, a warm "we" voice);
   - a **household week note** (last week and the coming one), in three parts: what went well, what's planned,
     what needs help.
   Also the language: grandparents may prefer Arabic or French even if the household chats in English. Write in theirs.
2. **Gather before asking.** From what you can see:
   - the calendar for the period, if they have it (`calendar_events` with `from` and `to`): trips, birthdays, school
     events, appointments to mention (skip private ones such as medical visits unless they say so);
   - memory (`recall`) and past chats (`search_history`) for recent news they told you;
   - goals they made progress on (`goals_list`, if they have goals);
   - photos and documents in the Library, if they have it (`library_list`), to reference.
   Then ask them for the two or three things they most want to share, and anything to leave out.
3. **Write it.**
   - **Newsletter:** a friendly greeting, 3 to 5 short sections (each child or person, a trip, the house, what's
     coming), short sentences, a photo or two referenced by name, a warm sign-off from everyone. About 250 to 400 words.
   - **Week note:** Progress, Plans, Problems, one to three plain lines each, with times and names; end with one line on
     who does what.
   Only facts you have. Don't guess ages, dates or how someone feels.
4. **Privacy check.** Before it goes to a wide circle, point out anything sensitive (health, money, a child's
   embarrassing moment, the address when the house is empty) and let them decide.
5. **Deliver.** Show the draft in chat. Offer to save it in the Library (`library_create`), make a printable PDF
   (`make_pdf`) or a nicer page, or email it if they have email: `email_send` to the relatives they name, and the approval
   card shows the text and recipients first.
6. **Make it a habit (offer).** A monthly reminder to write the next one, or a scheduled draft (`schedule_task`) that
   gathers the month's events and posts a draft for them to check; a scheduled run never sends on its own.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "Everyone knows the background" | Grandma abroad doesn't. One line of context per item. |
| "I'll fill in a nice detail" | Only real details. Ask for one instead. |
| "More news is better" | Three or four good moments beat a list of everything. |
| "It's family, anything goes" | Check for sensitive bits before it goes to the whole circle. |

## Done when
- The right format (newsletter or week note), period and language were used.
- Content came from calendar, memory and what they said, not invention.
- Sensitive items were flagged before sharing.
- It was delivered as they wanted, and any email went through the approval card.

Sources: anthropics/skills internal-comms (3P update and newsletter shapes), modified; ComposioHQ copy of internal-comms. See NOTICE.md and LICENSE.txt.
