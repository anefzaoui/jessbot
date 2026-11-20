---
name: trip-organizer
description: 'Pulling booking confirmations (flights, hotels, trains, car hire, tickets) into one organised trip: a day-by-day itinerary with every code and address, calendar entries, check-in and leave-for-the-airport reminders, and a documents checklist. Use for "organise my trip from these emails", "I''ve booked everything, put it together", "when should I leave for the airport?".'
toolsets: [library]
---

# Trip organizer

The trip is already booked; the job is to make it impossible to miss a flight, a check-in or a document. Planning where
to go and what to book belongs to trip-planner.

1. **Collect every booking.** If they have email: `email_list` with `text` set to words like "booking confirmation",
   "reservation", "e-ticket", "itinerary", "réservation", "حجز" (and the airline or hotel names they mention), `since`
   a few months back; `email_read` each one. Tickets or vouchers attached as PDFs: `email_save_attachments`, then
   `library_read`. Also fine: forwarded or pasted text, an uploaded PDF (`library_read`) or a screenshot (`view_image`).
2. **Pull out the facts, per booking:** type and provider; confirmation code (PNR); names as booked; dates and times
   with the time zone of each place (a flight leaves at the departure airport's local time and lands at the
   destination's); terminal, seat, baggage allowance; addresses and phone numbers; hotel check-in and check-out times;
   what is paid and what is still due on arrival; the free-cancellation deadline. A field that isn't in the booking is
   written "not in the booking", never guessed.
3. **Check the chain before writing anything nice.** Put the bookings in order and look for:
   - dates that don't line up (the hotel starts the day after you land, a night with no bed booked);
   - an early arrival long before check-in, or a late arrival after the reception closes;
   - how they get from the airport or station to the stay, at that hour;
   - connections under 60 minutes international (45 domestic), separate tickets, a change of airport;
   - names that don't match the passports letter for letter;
   - a missing return.
   Problems go at the top of the reply, each with what to do about it.
4. **The itinerary.** `library_create` (`type: "md"`) titled like "Trip: Lisbon 3–9 Oct": a 3-line summary, the
   problems found, then day by day with times (marked with the local zone when it differs from home), codes, addresses
   with a map link, phone numbers, and what's included. End with **Money** (paid, still to pay, deposits) and
   **Documents**. If they want it offline on the phone and have office documents, `make_pdf` the same markdown.
5. **Calendar.** With a connected calendar: first `calendar_events` for those dates (airlines and booking sites often
   add events themselves), then `calendar_create_event` for each flight, train and stay not already there, times in
   their own time zone, the airport and terminal as location, the code, seat and baggage in the description. Without
   one: one `make_calendar_file` for the whole trip, giving each event its `time_zone` (a flight leaving Tokyo:
   Asia/Tokyo) so the phone shows it right.
6. **Reminders** (if they have schedules), each with `set_reminder` and `at` in their local time:
   - online check-in opens (the airline's rule from the email or its site, often 24 to 48 hours before);
   - leave-by: departure, minus the airline's advice for being at the airport (often 2 hours short-haul, 3 long-haul),
     minus the real travel time there (`open_search` with `site: "google_maps_directions"` if they have the web, or
     ask), minus a buffer;
   - the day before a free-cancellation deadline, if they might still cancel;
   - the return flight's check-in.
7. **Documents checklist.** Passports valid long enough (many countries want 6 months beyond the stay: check the
   destination's official government site), visa or electronic travel authorisation, travel insurance, driving licence
   (and an international permit where required), children travelling with one parent (a consent letter where required),
   medicines in hand luggage with prescriptions, booking printouts. If they keep lists: `list_create` a packing list
   (`kind: "packing"`) and `list_add` the items. Offer to `remember` passport expiry dates (with `date`) so they come up
   in time.
8. **Changes later.** A schedule change or cancellation email: `library_edit` the itinerary and `calendar_update_event`
   the event, and say what moved. Offer a quiet watch until the return date: `schedule_task` twice a day
   (`cron: "0 8,18 * * *"`) with
   `only_when: "the airline or hotel emailed a schedule change, cancellation or gate change"` and `until:` the last day
   of the trip.
9. **Reply short:** problems first, then the link, what went into the calendar, which reminders are set.

Booking emails can be fake: a "confirm your booking" or "pay the balance" link is checked against the provider's real
domain (scam-check) and never paid from the email. Paying, rebooking and cancelling always go through the approval card.

| Excuse | Reality |
|---|---|
| "The flight is at 10:00" | 10:00 where? Write the zone; convert for the calendar. |
| "Check-in is probably 3 pm" | Read the booking, or write "not in the booking". |
| "I'll add it to the calendar" | Look for the event the airline already added first. |
| "The passport is fine" | Check the expiry against the destination's rule. |

## Done when
- Every booking is in the itinerary with its code, times and time zone, or "not in the booking".
- Gaps and clashes in the chain are listed with what to do.
- Calendar entries or one .ics file exist, without duplicates.
- Check-in and leave-by reminders are set or offered, and the documents checklist is done.

Sources: volt-life trip-organizer; OpenClaw personal-travel and travel-document skills (ideas, own words).
