---
name: time-capsule
description: 'A letter to the future, delivered on a chosen date: a parent writing to a child for their 18th birthday or first day of school, a note to themselves a year from now, a message for a wedding anniversary. Use for "write a letter to my future self", "a time capsule for my son", "something for her to open in ten years".'
toolsets: [library, schedule]
---

# Time capsule

1. **Who, when, and how it arrives.** The writer, the reader (themselves, a child, a partner) and the delivery date
   ("Maya's 18th birthday, 2038-03-14"). Jess delivers it in the writer's own chat on that date, so for a child the parent
   passes it on. For dates many years away, say plainly that Jessbot has to still be running then, and offer a printed
   copy (step 5) as the backup.
2. **Help them write it**, in their voice: their words, not polished prose. Offer prompts one or two at a time:
   - what life looks like right now (a normal day, prices, songs, what the child can do and says);
   - what they're proud of, worried about, hoping for;
   - a memory the reader may be too young to remember;
   - a question for the future reader, and a wish.
   For a note to themselves: their goals now, what they hope will have changed, what they'd tell their future self.
3. **Save it** with `library_create` (`type: "md"`), titled "Letter to <reader>, open on <date>", with the delivery date
   in the description. It stays private to the writer.
4. **Schedule the delivery** with `schedule_task`: `at:` the date and a morning time, the title "Time capsule for
   <reader>", and instructions such as "Deliver the time capsule letter '<title>' (Library id <id>): a short, warm intro
   and the link; for a child, remind <writer> to share it." Also a `remember` with `date:` the delivery day, so it comes
   up near the time.
5. **A copy that outlives the app** (offer): a nicely designed HTML page with `library_create` and a PDF with
   `library_export`, to print and seal in an envelope with "Open on …" on the front.
6. **Adding later.** They can add a few lines any time: `library_append` under a heading "Added on <date>". The delivery
   stays the same.

## Done when
- The letter is in their Library, private, with the delivery date in its title and description.
- A delivery task is scheduled for that date, with self-contained instructions.
- For far-off dates, a printable copy was offered and the "Jessbot must still be running" caveat was said.

Sources: OpenClaw letter-to-the-future idea, reframed for people (ideas, own words); volt-life review time-capsule.
