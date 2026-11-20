---
name: job-search
description: 'Looking for work: finding openings that really fit (job boards, company career pages, local sites), scoring them honestly, keeping an application tracker, follow-ups and interview preparation. Use for "find me jobs as…", "help me job hunt", "any openings for nurses near me?", "prepare me for my interview". Never applies or sends anything without them.'
toolsets: [web]
---

# Job search

Run it like a small project: a clear profile, a steady search, an honest shortlist, and a tracker so nothing slips.

1. **The profile.** Roles (and the other titles the same job goes by), level, skills, languages, where (cities,
   commute limit, remote or hybrid), minimum pay, contract type, deal-breakers, companies to skip. Check memory first
   (`recall`); ask the rest once in `ask_user` rounds, and save the answers with `remember` so the next search starts
   there.
2. **Search.** Use several routes, in the local language too (a French or Arabic title finds different ads than the
   English one):
   - the big boards: `open_search` with `site: "linkedin_jobs"` or `"indeed"`, the title as `query`, `location`,
     `posted` (`"week"`), `remote` and `country`; for a local job site, `browser_open` it and use its search and filters
     (date posted, place, remote);
   - `web_search` with the job title, the city and "jobs" or the local word, with `freshness` set to week or month;
   - the career pages of employers they name.
   A login wall: use the company's own careers page instead, or hand over with `ask_user` and `show_screen: true` so
   they sign in themselves. Never type their password.
3. **Open every posting you list.** Read the real ad (`web_read` or `browser_read`): requirements, place, pay if
   given, closing date, and whether it is still open. Check the posting date; old ads are often filled.
4. **Score honestly** out of 100: skills match 40, level 25, location and schedule 15, field 10, no red flags 10.
   Show only the top 3 to 5 with the score, one line why, and the link. Red flags to call out: fees to apply, vague
   company, pay far above the market, requests for bank or ID details before an interview (likely a scam).
5. **The tracker.** If they have office documents, a spreadsheet with `make_spreadsheet`: Company, Role, Link, Found,
   Closing date, Score, Status, Next step, Follow-up date. Add new finds later with `sheet_append_rows` and change a
   status with `sheet_set_cells`. Without office documents, a Library table updated with `library_append`, or keep it in
   chat.
6. **Applying.** For each chosen job, the cv-and-cover-letter skill makes the tailored CV and letter. They submit, or
   you fill the form together in the browser (`browser_upload` attaches the CV from their Library); uploads and any
   "Apply" or "Send" click ask first, and nothing goes out without them.
7. **Follow-ups.** Reminders (`set_reminder`, if they have reminders) about a week after applying and before each
   closing date. A follow-up message is short, specific and never the same text twice.
8. **Interview prep.** A one-page brief: what the company does and recent news, the role's likely challenges, five
   STAR stories (situation, task, action, result) from their real experience matched to the ad, three questions to ask
   them, and a pay range from at least three sources with dates. Offer a practice round: you ask, they answer, you give
   short feedback.
9. **Keeping watch (offer).** A scheduled search with `schedule_task` (weekday mornings: `cron: "0 8 * * 1-5"`) that
   reports only new matches above their score threshold (`only_when: "a new posting scores 70 or more"`). It runs
   unattended: it lists new jobs and never applies.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "The snippet says it's remote" | Open the ad and check. |
| "Twenty results look thorough" | Three to five honest matches beat a dump of links. |
| "This one's close enough" | Score it; show the gap in one line. |
| "It's probably still open" | Check the date and the page. Old ads get filled. |

## Done when
- The profile is saved and was used for the search.
- Every listed job was opened, is current, and has a score and a one-line reason.
- A tracker holds the shortlist with status and follow-up dates.
- Nothing was applied for or sent without their go-ahead through the approval card.

Sources: volt householdA job-search draft (OpenClaw job-search skill, method only); volt-life cv-and-cover-letter (joko-jobhunter follow-up ideas); rewritten for Jessbot.
