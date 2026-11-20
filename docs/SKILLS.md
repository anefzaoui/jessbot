# Skills

A skill is know-how for a kind of task: a `skills/<name>/SKILL.md` file (the agentskills format: YAML front matter, then
markdown steps). Only the name and description sit in Jess's prompt; she loads the steps with `use_skill` when a request
matches, and a skill shows for a person only when they have every toolset it lists. Background: decisions #17 and #84
(skills), #121–#122 (review assistant, folder checksum), #171–#173 (skill_propose, supporting files, routing examples),
#195 (the recommended set and categories). Code: `src/services/skills.js`, `src/services/skill-lint.js`,
`src/agent/tools/index.js` (`use_skill`, `skill_propose`).

## The catalogue

94 built-in skills, in the areas Admin → Skills filters by (`CATEGORIES` in `src/services/skills.js`). **R** marks the
recommended core set (`RECOMMENDED`, 26 skills, all with routing examples). Toolsets are the ones a skill cannot work
without; tools that only help are written in the steps as "if you have email…", so the skill still shows for people
without them (the review screen lists those as "Optional tools").

### Research and facts
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| research-report | A researched, cited answer saved as a report; big ones go to a background side chat (`delegate`) | web, library | R |
| fact-check | Is a claim, forwarded message, statistic or article true? Verdict, how sure, dated sources | web | R |
| scam-check | Is this message, link, site, call or invoice a scam? Real sender, red flags, verdict | web | R |
| medicine-info | A medicine's uses, side effects, interactions, recalls, from the official leaflet | web | R |
| digital-safety-checkup | A calm security check-up, or what to do right now after a hack, leak or scam payment | web, library | |
| watch-topic | A quiet watch that writes only when a page or topic changes the way they care about | schedule | |
| save-page | A dated copy of a web page (text, and a PDF when the look matters) | web, library | |
| knowledge-notes | A personal notebook of articles, papers, how-tos, with an honest "worth reading?" verdict | library | |

### Days and habits
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| morning-briefing | "Your day at a glance", on request or as a scheduled morning brief | none | R |
| plan-my-day | A realistic timed plan for today or tomorrow, three priorities, an evening look-back | none | R |
| weekly-review | Last week in two lines, the week ahead, one next step per goal, three priorities | goals | R |
| life-planner | Direction for the year or the next few: 2–3 goals, this month, a not-to-do list | library | |
| habit-coach | One small anchored habit, nudges, streaks without shame, a weekly resize | schedule | |
| get-unstuck | A two-minute first step, a focus session with check-ins, kindness about guilt | none | |
| automate-my-routines | Spot the loops in their week and hand them to scheduled tasks | schedule | |
| daily-log | Sleep, meals, workouts, mood or any habit logged from quick messages | library | |
| training-plan | A week-by-week running, cycling, swimming or strength plan as a spreadsheet | office | |
| time-capsule | A letter to the future, delivered on a chosen date | library, schedule | |
| get-to-know-me | A few tap-to-answer questions at a time so Jess learns their preferences | memory | |

### People, mail and calendar
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| inbox-triage | What's new and important in the mailbox, tidying, answering in their voice | email | R |
| birthdays-and-people | Birthdays and anniversaries as yearly dated memories, reminders, what people like | memory | R |
| appointment-prep | A one-screen brief before an appointment: history, questions, papers, leave-by time | none | R |
| meeting-notes | Notes, decisions and actions from a meeting, call, transcript or memo | library | R |
| find-a-time | Real free slots across calendars (busy-sharing members too), options, the invite | calendar | |
| email-to-calendar | Events and deadlines found in email, added without duplicates | email | |
| family-update | A family newsletter or a household week note | none | |
| questions-for-someone | A clear questionnaire for someone whose answers a decision needs | library | |
| difficult-conversation | A firm, kind reply or talk plan for a dispute, boundary or awkward ask | none | |

### Money and home
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| household-budget | Where the money goes, from uploaded statements, in a formula workbook | library, office | R |
| bills-and-receipts | Bills and receipts gathered, read, filed, reminded; a bundle for the accountant | library | R |
| expense-log | A running expenses ledger from quick notes or receipt photos; who owes whom | office, library | |
| switch-provider | Switching or cancelling a provider without losing anything: new first, old last | web | |
| home-upkeep | A device register with warranties and manuals, error codes, recurring upkeep | library, web | |
| home-search | Homes to rent or buy: real listings, price per m², area, scams, a watch | web | |
| document-expiry | Passports, permits and renewals remembered with reminders well ahead | memory, schedule | |

### Shopping
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| buying-guide | Which product to buy: maker specs, owners at scale, testers, local prices | web | R |
| price-watch | Today's prices compared, and a quiet watch until the target price | web, schedule | R |
| grocery-order | The online grocery shop from the list to a checked basket, stopping before payment | web | R |
| shop-and-return | Buying, reordering, returns and warranty claims in an online shop | web | |
| second-hand-search | Used items on local classifieds: fair price, seller questions, scam signs | web | |
| gift-finder | Two or three thoughtful gift ideas that arrive in time | web | |
| parcel-tracking | Where a parcel is, what the status means, a watch until it arrives | web | |

### Food
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| meal-planner | The week's meals, Ramadan included, and the shopping list | library | R |
| family-cookbook | The family's recipes in one cookbook, found again and scaled | library | |
| sourdough-starter | Feeding sums, a bake timeline by temperature, starter troubleshooting | none | |

### Travel and going out
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| trip-planner | Planning a trip or day out: options with sources, a checked itinerary, practicalities | web | R |
| trip-organizer | Booked confirmations turned into one itinerary, calendar entries and reminders | library | |
| flight-deals | Cheap or well-timed flights, flexible dates, a fare or flight-status watch | web | |
| places-and-directions | Real places nearby (OpenStreetMap), opening hours, travel time, a directions link | web | |
| public-transport | Departures, disruptions and journeys from the operator's own site | web | |
| events-finder | Things to do this weekend or on a date, checked on their own pages | web | |
| book-something | A table, tickets, a class or a takeaway booked in the browser after their yes | web | |
| where-to-watch | Where a film, series or match streams or airs in their country | web | |
| media-tracker | To-watch and to-read lists, ratings, new seasons, "what shall we watch?" | lists | |

### Writing
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| write-with-me | An important piece written together, in their voice | library | R |
| polish-writing | A text made correct and natural in English, French or Arabic, their voice kept | none | R |
| draft-feedback | Ranked, quoted fixes and a verdict before something goes out | none | |
| academic-writing | School or university writing with verified scholarly references | web | |
| social-post | A post or caption for one platform and one audience; Jess doesn't post | none | |
| cv-and-cover-letter | A tailored CV and cover letter, or a LinkedIn profile, never inventing anything | office | |
| book-or-memoir | A book or family memoir over months, in a Project, never losing a version | projects | |
| translate-a-document | A whole document translated back in the same shape | library | |
| job-search | Openings that really fit, scored honestly, with a tracker and interview prep | web | |

### Documents and pages
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| read-long-document | A long document or contract read to the end and explained, with page references | library | R |
| document-compare | Exactly what changed between two versions of a document | library | |
| fill-a-form | An online form filled in the browser and shown for review before submitting | web | |
| spreadsheet-analysis | A shared table cleaned and answered with formulas, a chart when it helps | office, library | |
| make-a-page | The design steps for any HTML page Jess builds in the Library | library | |
| printables | Invitations, posters, cards, a Wi-Fi guest card, at exact print sizes | library | |
| mind-map-page | A tangled topic drawn as a mind map, flowchart, timeline or plan page | library | |
| what-if-page | A clickable page to try out a rule or plan (rotas, bill splits, what-ifs) | library | |
| generative-art | A seeded, explorable art page and a picture to print | library | |

### Learning and school
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| homework-helper | Tonight's homework with hints before answers, and a quiz before a test | none | R |
| school-helper | School emails, letters and timetables turned into dates and reminders per child | library, schedule | R |
| learn-with-me | A tutor over many sessions: one win per lesson page, spaced review | library | |
| learn-this | An article or video turned into a small practice plan | web | |
| worksheet-maker | Printable practice sheets with an answer key checked by formulas | office | |

### Kids and family
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| bedtime-story | A calm story made up for this child tonight, told, voiced or recorded | none | R |
| story-game | A choose-your-path adventure with real dice and a saved game | library | |
| chore-quest | Chores as a game with points and badges, parents confirming claims | library | |
| kids-activities | Clubs and fixtures in the calendar, kit and leave-by reminders, a changes watch | schedule | |
| baby-log | A baby's feeds, sleep, nappies and growth from one-handed messages | library | |
| family-history | Genealogy with a plan, a research log and cited, weighed evidence | library | |
| fair-draw | Any fair draw through `pick_random`, Secret Santa included | none | |

### Decisions and ideas
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| decide | Quick everyday choices, or one concrete action for a shapeless chore | none | |
| decision-stress-test | A big commitment poked for holes against real alternatives, ranked | none | R |
| big-decision-map | A weeks-long undertaking mapped in a Project, one decision per sitting | projects | |
| idea-shaper | A rough idea turned into a one-page plan | library | |

### Help and calm
| Skill | What it's for | Toolsets | |
|---|---|---|---|
| troubleshoot | Something broken fixed step by step from evidence, one change at a time | web | R |
| walk-me-through | Steps only they can do on their own device, one stage at a time | web | |
| calm-and-breathe | A guided breathing or grounding exercise, a gentle check-in, crisis help | none | |
| calm-requests | A request reworded so it doesn't trigger push-back (PDA, ADHD), honestly | none | |
| daily-devotion | A daily verse or saying in their own tradition, quoted exactly with its reference | web | |
| skill-writer | A way of doing something turned into a skill draft for the admin | none | |

## How a skill gets switched on

1. **Every skill starts in review.** A built-in (from the repo) or one the admin writes (`data/skills/`, backed up) runs
   only after an admin approves it in **Admin → Skills**. Approving pins the checksum of the whole folder; any change to
   it afterwards (a git pull, an edit, a supporting file) puts the skill back to "needs review", and the review screen
   shows what changed since the approval.
2. **The review assistant** (`skill-lint.js`) reads each skill offline before the admin decides: hidden characters,
   steering ("ignore your instructions", "without asking"), requests for secrets, commands, data-catching links, web
   addresses to fetch steps from, tools outside the declared toolsets, sends the description doesn't justify, near
   duplicates of another skill's description, and whether its `examples:` route to it. A serious finding (bad) means
   approving needs "Approve anyway…". A skill that can't be parsed is listed as broken with the reasons.
3. **Recommended to switch on.** On a fresh install the 26 recommended skills sit at the top of Admin → Skills with one
   "Approve these" button. It runs the normal approval for each one (checksum-pinned, review-gated, never silent); the
   other 68 wait in the list below it, which filters by area, status and origin.
4. **The trigger test** on a skill's review page asks the model, a few times, which skill it would open for the skill's
   example requests (or the admin's own), and reports the hit rate and cost.

## Routing examples

A skill may carry `examples:` in its front matter: 3 requests that should open it and 2 that shouldn't:

```yaml
examples:
  positive:
    - "Tell me when this phone is under 300 euros"
    - "Surveille le prix de cette télé et préviens-moi"
    - "نبهني كي ينقص سوم هالآلة"
  negative:
    - "Which fridge is the best for our kitchen?"
    - "Where's my parcel?"
```

An offline check (`examplesCheck`) ranks every skill against each phrasing by the words of its name and description: a
positive must put the skill in the top 3, a negative must not put it first. All 26 recommended skills have examples in
English, French and Arabic. When a French or Arabic phrasing shared no word with the skill, the fix was the description
(the words people really say, such as "fais une recherche sur…", "ابحث لي عن…"), never a reworded example.

## How Jess proposes a new skill

When someone says "make this a skill" or "do it like this every time", Jess follows the skill-writer skill and calls
`skill_propose` (`name`, `description`, `toolsets`, `body`, `tests`, `near_misses`, `why`). The draft lands in Admin →
Skills as "drafted by Jess", never active, with who asked, the chat and the test requests kept outside the folder so the
checksum stays honest. It is refused when the task has read outside content (a web page, an email, a file), when a
built-in, the admin's own skill or someone else's draft has the name, when the body sends her to a web address, reads like
instructions to an AI assistant or holds a secret, or when the description is over 400 characters; proposing the same name again updates her own earlier draft and sends it back to review. The admin
is notified, reviews it like any skill, and may change it before approving.

## Keeping skills true to the tools

`tests/skills.test.js` runs with `npm test` and holds every folder in `skills/` to the same bar:

- it parses, isn't broken, has a description of at most 400 characters and only real toolsets;
- no serious review finding, no unknown-tool note, no description collision with another skill (TF-IDF cosine under 0.75);
- a "Done when" section and a last line "Sources: …";
- **the contract check:** every step (a numbered item, a bullet, a paragraph or a table row) is read with the tools it
  names as its scope. Every tool named exists; every parameter given (`` `yearly: true` ``, `` `until:` ``, `` `watch_url` ``,
  nested ones like `follow_up`'s `every_min`) belongs to a tool that step names; every value is one that parameter takes
  (enum members such as `open_search` sites or `pick_random` modes, booleans, numbers). A snake_case word outside
  backticks must be a real tool or parameter too;
- the recommended skills have 3 + 2 examples that route to them.

When a tool changes, this test names every skill that no longer matches. Behaviour lives in two other places, and skills
don't repeat it: contracts (what a tool takes, returns and refuses) in the tool descriptions, and the household-wide
rules (asking in rounds, the approval card as confirmation, the one-hour hold for a heated message, seeing things
through) in `AGENTS.md`. A skill carries the steps for its kind of task, for example make-a-page's design steps,
which moved out of `library_create`'s description.

## Licences

Every skill is written in Jessbot's own words and ends with a `Sources:` line naming what inspired it. Where a skill
adapts text or structure closely, its folder carries the notice:

| Folder | File | Source and licence |
|---|---|---|
| automate-my-routines | NOTICE.md | mattpocock/skills loop-me, MIT (© 2026 Matt Pocock) |
| big-decision-map | NOTICE.md | mattpocock/skills wayfinder, to-spec, to-tickets, MIT |
| learn-with-me | NOTICE.md | mattpocock/skills teach, MIT |
| questions-for-someone | NOTICE.md | mattpocock/skills to-questionnaire, MIT |
| what-if-page | NOTICE.md | mattpocock/skills prototype, MIT |
| write-with-me | NOTICE.md | mattpocock/skills writing-fragments, writing-beats, writing-shape, MIT |
| decision-stress-test | NOTICE.md | addyosmani/agent-skills doubt-driven-development, pre-mortem, documentation-and-adrs, MIT (© 2025 Addy Osmani) |
| draft-feedback | NOTICE.md | addyosmani/agent-skills code-review-and-quality, MIT |
| idea-shaper | NOTICE.md | addyosmani/agent-skills interview-me, idea-refine, MIT |
| switch-provider | NOTICE.md | addyosmani/agent-skills deprecation-and-migration, MIT |
| make-a-page | NOTICE.md, LICENSE.txt | anthropics/skills frontend-design, Apache-2.0, modified; addyosmani frontend-ui-engineering, MIT |
| printables | NOTICE.md, LICENSE.txt | anthropics/skills canvas-design, Apache-2.0, modified |
| generative-art | NOTICE.md, LICENSE.txt | anthropics/skills algorithmic-art, Apache-2.0, modified |
| family-update | NOTICE.md, LICENSE.txt | anthropics/skills internal-comms, Apache-2.0, modified |
| skill-writer | NOTICE.md, LICENSE.txt | anthropics/skills skill-creator, Apache-2.0, modified |

Other `Sources:` lines credit ideas only (method, not text), which needs no notice: for example OpenClaw skills marked
"ideas, own words", composio and emory skills under MIT or Apache-2.0 credited for ideas, clarity-gate (CC-BY-4.0) in
fact-check, and sourdough-starter, whose inspiration states no licence and whose know-how and worked examples are
entirely rewritten. Anthropic's proprietary docx, pdf, pptx and xlsx skills were never used, and nothing the reviews
flagged unsafe was imported. `NOTICE*` and `LICENSE*` files stay in the checksum and the review but are not offered to
Jess as supporting files.

## What is deliberately not a skill

- **Deterministic work is code, not steps** (standing rule 3): lists (`list_add`…), reminders that follow up until done
  (`set_reminder` `follow_up`, `reminder_done`), fair draws (`pick_random`), free time across calendars
  (`calendar_free_slots`), calendar files, holidays, weather, OCR, PDF forms, spreadsheet formulas, page checks and
  exports, quiet watches (`schedule_task` `only_when` / `watch_url`), the Feed. Skills call these tools; they never
  re-implement them in prose.
- **Rules for every task live in AGENTS.md**, and tool contracts in the tool descriptions (decisions #206–#207), so no
  skill repeats "ask in rounds", "the approval card is the confirmation" or the one-hour hold for a heated message.
- **Dropped by the owner's answers:** prayer times, music picks (Spotify), kid-safe profiles and Home Assistant (not
  now).
- **Rejected on purpose:** XP leaderboards that compare family members (chore-quest counts personal bests only); regex
  "humanizers" (they damage text and miss Arabic; polish-writing edits by judgement); Excel upsert-by-key (it fights
  versioned documents); anything that runs code or installs software, and any skill that fetches its steps from the web
  at run time.
