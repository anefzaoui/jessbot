---
name: home-upkeep
description: 'The household''s appliances and upkeep: a register of devices with model, purchase date, warranty and manual; "is the washing machine still under warranty?", "what does error E21 mean?", "where''s the boiler manual?"; and maintenance or chores that come round (filters, boiler service, descaling, smoke alarms, bins day), what''s due and what''s overdue.'
toolsets: [library, web]
---

# Home upkeep

1. **The device register.** One Library document, "Home devices" (`library_list` to find it, `library_create` with
   `type: "md"` if missing), with a table: `| Device | Brand and model | Where | Bought | Warranty until | Manual | Notes |`.
   Add or update a device with `library_append`, `key:` the device name, from what they tell you, a photo of the label, or
   a receipt. If the receipt is in their email, `email_save_attachments` keeps it in the Library. A serial number only if
   they want it there.
2. **Manuals.** Find the official manual on the maker's site (`web_search` "<model> manual pdf"), keep it with `web_read`
   and `save: true`, and put its Library link in the register.
3. **Error codes.** Search the model and the exact code, the maker's site first (in the local language too). Give what the
   manual says it means and the safe steps it suggests, and say when it's a job for a technician. For a fault that needs
   real diagnosing, work through it the way the troubleshoot skill does.
4. **Warranty before repair.** Before anyone pays for a repair, check the register: still under the maker's warranty? The
   legal guarantee in their country may be longer (search it). Offer a reminder a month before a warranty ends.
5. **The upkeep list.** A second document, "Home upkeep":
   `| Task | Every | Last done | Next due | Who |`. Seed it from the devices (filters every few months, yearly boiler
   service, descaling, smoke alarm test, AC filters before summer, car service) and ask which apply. One repeating
   reminder per task with `set_reminder` (`repeat` as fits); for bins, the evening before.
6. **"What's due?"** Overdue first, then this week, then this month. **"Done"**: `library_append` with `key:` the task to
   update Last done and Next due.
7. **Shared chores.** If the family keeps lists, add this week's jobs to a shared to-do list with `list_add` and
   `kind: "todo"`, so whoever does it can tick it off.

Safety first: a gas smell, sparks or burning, or water near electrics means stop, keep away, and call the emergency line
or a qualified professional.

## Done when
- The device is in the register with model, purchase date and warranty (or "unknown").
- An error code is explained from the maker's own manual or support page, with when to call a technician.
- Each upkeep task has a next due date and a reminder, if they wanted one.
- "What's due?" answers list overdue items first.

Sources: OpenClaw home-devices (MIT; ideas, own words) and home-maintenance skills; household review drafts.
