---
name: switch-provider
description: 'Switching or cancelling a provider or account without losing anything: a bank, mobile or internet plan, electricity or gas, insurance, a gym, a subscription, or changing email address or phone number everywhere. Use for "I want to change banks", "cancel my…", "move my phone plan", "is it worth switching?", "change my email on all my accounts".'
toolsets: [web]
---

# Switch provider

The rule: add the new one first, move things one at a time, and close the old one last and on its own.

1. **Is switching worth it?** What does the old one give that's hard to replace (an old low tariff, a phone number or an
   email address everyone uses)? Check the contract end, notice period and exit fees (read-long-document for the
   contract), and compare real total costs over a year, fees included, from the providers' own pages (`web_search`,
   `web_read`, in the local language too). Write down what the switch costs as well as what it saves.
2. **New one first.** Open or order the new account and make sure it works before touching the old one. Many countries
   have number porting or bank switching services: look for the official one, since it may do much of this list.
3. **Every touchpoint in a checklist**: `library_create` (`type: "md"`) with `| Touchpoint | Moved? | Checked on | Notes |`:
   - money: salary, direct debits, standing orders, cards saved in shops and apps, refunds still due;
   - accounts that use the old email or number to sign in, recover a password or get two-step codes (bank, government,
     school, shops, social media);
   - people and places that send to it (employer, school, doctor, family);
   - automatic renewals and subscriptions billed to it.
   If email is connected, `email_list` searches for the old provider's name and messages sent to the old address find
   the forgotten ones.
4. **Move one at a time and check each** (the first payment went through, the sign-in works with the new email, a test
   message arrives), then tick it with `library_edit`. For two-step sign-in, add the new number before removing the old.
5. **Close last and alone**: only after a full billing cycle with nothing arriving at the old one. First download the
   final statements and any history they'll want. Cancellation emails and forms go through the approval card
   (`email_send`, or the fill-a-form skill); ask for written confirmation.
6. **Deadlines.** Offer `set_reminder` for the notice deadline, the final bill, and a check a month after closing.

| Excuse | Reality |
|---|---|
| "Cancel the old one now, set up the new one after" | New first: a gap can cost a salary payment or a login. |
| "All the direct debits are moved" | Check each one went through before ticking it. |
| "Remove the old number from the bank app" | Add the new one first, then remove. |

## Done when
- The switch was costed over a year, notice periods and exit fees included.
- The new account works before anything moved.
- Every touchpoint is on the checklist and ticked only after it was checked.
- The old account closes last, after a quiet billing cycle, with reminders for the deadlines.

Sources: addyosmani/agent-skills deprecation-and-migration (MIT; the "additive first, destructive last" idea, own words).
