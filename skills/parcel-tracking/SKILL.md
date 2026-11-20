---
name: parcel-tracking
description: 'Where''s my parcel? Tracking a delivery from a tracking number or a shipping email: which carrier, where it is now, what the status really means, when it should arrive, and keeping a quiet eye on it until it''s delivered. Also when it''s late, lost or "delivered" but not there, or a text asks for a customs or redelivery fee.'
toolsets: [web]
---

# Parcel tracking

1. **Get the number.** From their message or a screenshot; or, if they have email, `email_list` with `text` set to
   "tracking", "shipped", "dispatched", "expédié", "colis", "شحن", "تتبع" and `since` the last month, then `email_read`
   the shipping email. Note the shop, the item, the carrier named in the email and the promised date.
2. **Which carrier?** The email's carrier name wins; otherwise the shape of the number says who it most likely is:

   | Number looks like | Most likely |
   |---|---|
   | 1Z + 16 letters and digits | UPS |
   | 92, 93, 94 or 95 + 20 digits | USPS |
   | 10 or 11 digits | DHL Express |
   | 12 or 15 digits | FedEx |
   | 2 letters + 9 digits + 2 letters (RR123456789CN) | a national post; the last two letters are the sending country |
   | YT… · LP… · SF… | Yanwen · Cainiao (AliExpress) · SF Express |
   | TBA… | Amazon's own delivery (track it in the Amazon order) |

   Shapes overlap: say "most likely", not "it is".
3. **Open the tracking.** `open_search` with `site: "parcel"` and the `number` picks the carrier from the number
   (or falls back to a universal tracker); name the carrier instead (`site: "dhl"`, `"laposte"`, `"aramex"`…) when the
   email says who it is. For a plain page, `web_read` the carrier's tracking page; when it comes back empty (a page
   that needs scripts), `browser_open` it and `browser_read`. Postal parcels change hands at the border and keep the
   same number: after "handed over to the destination country", follow it on that country's post site or a universal
   tracker.
4. **Say what the status really means:**
   - label created / information received: the sender printed a label; the carrier doesn't have it yet (often 1–3 days);
   - in transit: moving; long gaps between scans are normal on international routes;
   - customs: usually a few working days; a duty or tax bill, if any, comes from the carrier or post, see step 7;
   - out for delivery: today;
   - exception / delivery attempted: what the carrier wants (a new slot, a pick-up point, an ID) and by when;
   - returned to sender: contact the shop.
5. **When will it arrive?** The carrier's estimate first; otherwise say the usual range for that route, and that
   weekends and public holidays (`get_holidays`) add days.
6. **A quiet watch** until it arrives: `schedule_task` titled "Parcel: <item>", `cron` once or twice a day
   ("0 9,17 * * *"), `only_when: "the tracking status changed: a new scan, out for delivery, delivered, an exception or
   a charge to pay"`, `watch_url` the tracking page (an unchanged page costs nothing), `until:` the promised date plus a
   week (30 days at most). The instructions stand alone: the number, carrier, link, item, and what to report. If they
   need to be home, a `set_reminder` on the delivery day.
7. **Fees and texts.** Real duties or redelivery charges exist, but they are paid only on the carrier's or post's
   official site or app, reached by typing its address, where the same tracking number shows the same charge. A text or
   email saying "your parcel is held, pay €1.99" with a link is the most common delivery scam: don't open it, and switch
   to scam-check if they are unsure. Nothing is paid from a message link.
8. **Late, lost or "delivered" but not there.** Check the carrier's proof (photo, signature, safe place, a neighbour or
   pick-up point), then the shop: the contract is with the seller, who deals with the carrier; note their deadline for
   claims. Draft the message (difficult-conversation for a firm one); sending it by email goes through the approval
   card.
9. **Privacy.** A surprise gift or something personal: offer to keep updates out of a shared chat, or let them check it
   themselves.

Sending a parcel instead: compare carriers' prices and times for the size, weight and destination on their sites, and
stop before paying for a label.

| Excuse | Reality |
|---|---|
| "It's probably DHL" | Say "most likely", or read the carrier from the email. |
| "No update means it's lost" | Gaps between scans are normal abroad; give the usual range. |
| "The text had the tracking number" | Numbers leak; pay only on the official site. |

## Done when
- The carrier (or "most likely" carrier) and the current status are given in plain words.
- An expected delivery day or honest range is given, with the source.
- A watch, if set, reports only changes and ends by a date.
- Any fee was checked only on the official carrier site, and nothing was paid from a message.

Sources: householdA parcel-tracking (OpenClaw parcel skills, carrier table); volt-life parcel-tracking; volt-dev package-tracking (carrier shapes, privacy note); own words.
