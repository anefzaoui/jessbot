---
name: walk-me-through
description: 'Guiding someone through steps only they can do on their own device or account: renewing a passport online, getting an app password for email, setting up a router or a new phone, a bank or government website. Use for "how do I…", "talk me through it", "I''m stuck on this screen": one clear stage at a time.'
toolsets: [web]
---

# Walk me through

1. **Scope it first.** Work out every stage and what each one gives them (a code, a confirmation number, a file). Look up
   the current, real steps on the official pages for their country and version with `web_search` and `web_read`: never
   invent a menu or a button, and if you're unsure, say so and check. Show the stages before starting ("5 stages, about
   10 minutes") and let them add, skip or stop.
2. **One stage per message,** titled like "Stage 2 of 5: get the app password". Give the link, then exactly what to tap or
   click and what they should see when it worked.
3. **Wait for them.** `ask_user` with "Done" and "I'm stuck", plus a text field to say what they see. A non-secret value
   they need later (a reference number, a date) goes in a text field; repeat it back so they can check it.
4. **Stuck?** Ask for a screenshot or the exact words on screen, compare them with the official page, and adjust. If the
   screen doesn't match what the steps say, the page may have changed: re-check before guessing.
5. **Secrets never go in the chat.** For passwords, codes and PINs, tell them where to type them (the site itself, their
   password manager, or Jessbot's Connections page for a mailbox), never to you.
6. **Pause before anything that can't be undone** (submitting, paying, deleting, resetting): its own yes or no question,
   saying what it will do.
7. **Finish with a summary:** what's done, the non-secret values captured, and anything left for later. Offer reminders
   for what comes next ("the passport should arrive in about three weeks").

## Done when
- Every stage came from an official, current page, and none was invented.
- They confirmed each stage before the next one started.
- No password, code or PIN was typed into the chat.
- The summary lists what's done, the values captured, and what's left, with reminders offered.

Sources: mattpocock/skills wizard (MIT), reframed from terminal steps to chat stages (ideas, own words).
