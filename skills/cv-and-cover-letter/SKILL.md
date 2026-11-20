---
name: cv-and-cover-letter
description: 'Writing or tailoring a CV/résumé and cover letter for a specific job ad, or improving a LinkedIn profile (headline, About section, experience bullets). Use for "update my CV", "tailor my CV to this job", "write me a cover letter", "fix my LinkedIn", "my CV in French". Never invents experience; delivers editable Word and PDF files ready to send.'
toolsets: [office]
---

# CV and cover letter

A CV is a promise the person has to keep in an interview. Everything in it must be true and theirs; your job is to
make the truth easy to see.

1. **Get the job and the person.**
   - The job: pasted text, or a link (`web_read`, if they have the web). Company, exact title, location, language.
   - Their background: an uploaded CV (`library_read`, if they have the Library), memory (`recall`), and what they
     say. Ask only for missing facts that matter (dates, responsibilities, numbers), in one `ask_user` round.
2. **Read the ad like a recruiter.** Split it into must-haves, important, nice-to-have, and the keywords: the exact
   tool names, qualifications and the wording of the job title. Note the language and tone of the ad.
3. **Match honestly.** Map each requirement to real experience or a transferable skill. List the gaps plainly; a gap
   is addressed in the letter or the interview, never papered over.
4. **Write the CV:**
   - a 3 to 4 line profile: years of experience, the top required skills they really have, what they want next;
   - skills grouped in the ad's own terms, only ones they can back up;
   - experience in reverse order, bullets as action + what + how + result, with numbers only they gave you (ask if a
     number would help: "roughly how many customers a day?"); no first person;
   - standard headings, no tables, columns or text in images (applicant tracking systems read those badly);
   - length: one page for under about ten years of experience, two otherwise, unless local custom differs;
   - local conventions: photo, date of birth or nationality are expected in some countries and unwise in others. Ask
     where they're applying, or follow what the ad's country usually does, and say which you chose.
   Write it in the ad's language (French, Arabic, English…); offer a second language version if useful.
5. **Write the cover letter** (at most about 350 words): why this company (one specific, true detail from their site
   or the ad), why them (two or three matches with proof), how they'd help in the first months, a clear closing line.
   Address a named person if the ad gives one; don't guess email addresses.
6. **Files.** `make_word_document` for the editable CV and letter; `make_pdf` for the version to send. Title them
   "CV - Name - Company Role". A new pair per application; keep the earlier versions.
7. **After the files:** strengths, gaps and how to handle them, 2 to 3 alternative opening lines for the letter, and
   five likely interview questions with the real story from their past that answers each.
8. **Sending.** They submit it themselves; or, if they have email, `email_send` with the files in `attachments` (their
   Library ids); or, on an online application form, `browser_upload` puts the file in the form's upload field. Both show
   an approval card naming the files (and the site) first. Offer a reminder before the application deadline and a
   follow-up a week after applying.

## LinkedIn profile

1. Take the current profile (pasted, a screenshot, or the public page with `web_read`).
2. Flag empty buzzwords ("results-driven", "passionate about", "dynamic", "team player") and give a specific
   replacement for each.
3. A short audit: each section scored 1 to 10 with a one-line reason, then the order to fix them.
4. Three headline options (under 220 characters): by expertise, by result, by niche.
5. An About section under about 220 words: a first line that isn't "I am…", credibility, proof with their own numbers
   (mark where a number would help), and what they want people to contact them about.
6. Rewritten experience bullets, result first, under 15 words each.
They paste it in themselves; if they want you to edit the profile in the browser, they sign in themselves and you read
back each change before saving it.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "A small stretch in the title is normal" | Never change titles, dates, degrees or numbers. Ask instead. |
| "Increased sales by about 30%" sounds good | Only a figure they gave you. Otherwise ask or leave it out. |
| "One CV fits all jobs" | Tailor to each ad's must-haves and wording. |
| "A photo is always expected" | It depends on the country. Ask or follow the ad's local custom. |

## Done when
- Every must-have in the ad is matched to real experience or listed as a gap.
- Nothing is invented: titles, dates, degrees and numbers all come from them.
- The CV and letter exist as editable Word and sendable PDF files, named for this application.
- Interview questions with their real stories were offered, and any sending went through the approval card.

Sources: ComposioHQ tailored-resume-generator (Apache-2.0, ideas); volt-life cv-and-cover-letter (resume-and-cover-letter, joko-jobhunter ideas); volt householdA cv-and-linkedin draft; all rewritten for Jessbot.
