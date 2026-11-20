---
name: learn-this
description: 'Turning something they read, watched or listened to (an article, a YouTube video, a PDF, a podcast page, a book chapter, a talk) into a small practice plan they will actually do, not just a summary. Use for "how do I apply this?", "make me a plan from this video", "I want to actually use what this article says".'
toolsets: [web]
---

# Learn this

A summary is forgotten by Friday. A small thing tried this week sticks. Pull out what can be done, and turn it into
practice.

1. **Read the source.** `web_read` the link: articles, PDFs (read with page markers) and YouTube videos (the
   transcript from captions, with times) all work. A long source comes in parts: keep reading with `start` until the
   end, or until you have what you need and say which part you used. An upload or pasted text works too
   (`library_read`, if they have the Library). If a video has no captions or a page is blocked, say so plainly; never
   guess what it says.
2. **Extract only the actionable lessons.** 3 to 7 things someone could do differently, each in one line with where it
   comes from (a timestamp [mm:ss] for a video, a page for a PDF). Skip background and anecdotes. If the source makes a
   claim that matters (health, money, safety), note whether it is backed by evidence; say where it conflicts with
   established advice.
3. **Ask what they want from it** in the next 4 to 8 weeks, in one `ask_user` round: a concrete result ("bake a decent
   sourdough loaf", "stop arguing at bedtime", "run 5 km"), how much time a week, and anything that limits them.
4. **Design the first try (Rep 1):** doable this week, a clear "done" they can see, a real result even if small. Then
   sketch Reps 2 to 5, each adding one new element from the lessons. Tie each rep to a lesson.
5. **Save the plan.** If they have the Library, a short document with `library_create`: the source (title and link),
   the lessons, the goal, the reps with their "done" lines, and a reflection box after each rep. Otherwise give it in
   chat.
6. **Make it happen.** Offer a goal for the quest (`goal_suggest`, if they have goals), a reminder for Rep 1
   (`set_reminder`, if they have reminders), and a check-in after it: "What happened? What surprised you? How did it go,
   1 to 10? What next?" Their answers shape the next rep; log progress with `goal_progress` when there is a goal.

Works for anything: cooking, fitness, gardening, parenting advice, a work skill, a language tip.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "A good summary is enough" | They asked to use it. Lessons and a first rep, not a summary. |
| "The video probably says…" | Only what the transcript or page says; cite the time or page. |
| "Rep 1: master the whole method" | Rep 1 fits in one week and has a visible "done". |
| "The source says so, so it's true" | Flag claims that matter and whether evidence backs them. |

## Done when
- The source was actually read (or its unavailability was stated), with lessons cited by time or page.
- The goal is concrete and time-bound.
- Rep 1 is doable this week with a clear "done", and Reps 2 to 5 build on it.
- A reminder or goal for Rep 1 was offered.

Sources: ComposioHQ review learn-this (tapestry learn-this and ship-learn-next ideas); rewritten for Jessbot's web_read readers.
