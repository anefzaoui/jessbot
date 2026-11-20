---
name: document-expiry
description: 'Keeping track of when official documents and renewals run out: passports, ID cards, driving licences, residence permits and visas, car insurance and registration, health cards. Use for "when does my passport expire?", "remind me to renew…", "are our passports OK for the trip?", or when they share a document''s expiry date.'
toolsets: [memory, schedule]
---

# Document expiry

1. **Record only what's needed**: whose document, the type, the issuing country and the expiry date. Never the document
   number. `remember` it with `kind: "fact"`, `date:` the expiry date and `importance: 2`, private unless they ask to
   share it with a group ("Passport of Maya (daughter), issued in Canada, expires 2027-04-10"). From a photo:
   `view_image`, read only the type, name and expiry date, and tell them you didn't keep the number.
2. **Reminders well ahead**, because renewals take time: `set_reminder` at about 90, 30 and 7 days before (`at:` the
   date with a morning time), each saying what to do ("Maya's passport expires on 10 April: book the renewal
   appointment"). Some offices need months: ask how long it took last time.
3. **Before trips.** When a trip comes up (a memory, a calendar event, trip planning), check each traveller's passport
   and permit. Many countries want a passport valid for 6 months after the return date, blank pages, or a visa: check the
   destination's official rule (`web_search`, `web_read`, if you have web tools) and flag it early.
4. **"What expires soon?"**: `recall` "expires", listed by date, overdue first.
5. **Renewal help** on request: the official renewal page and the documents, fees and photos needed, from the
   government's or insurer's own site, searched in the local language too. Walk-me-through or fill-a-form can guide the
   application itself.
6. **Renewed.** Update the memory with `remember` (`action: "update"` and its `memory_id`) to the new date, set the new
   reminders, and cancel the old ones (`list_alarms`, `cancel_alarm`).

| Excuse | Reality |
|---|---|
| "I'll keep the passport number, it's handy" | Only type, owner and date: numbers don't belong in memory. |
| "Valid until after the trip is enough" | Many countries need 6 months beyond return: check the rule. |
| "One reminder a week before" | Renewals take weeks or months: 90, 30 and 7 days. |

## Done when
- Each document is remembered with owner, type, country and expiry date, and no number.
- Reminders are set about 90, 30 and 7 days before.
- Upcoming trips were checked against passport validity rules.
- Renewed documents have their memory and reminders updated.

Sources: OpenClaw document-expiry and travel-document reminder skills (ideas, own words); volt-life review document-expiry.
