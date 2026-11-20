---
name: decision-stress-test
description: 'For a big, costly or hard-to-undo commitment (a job offer, buying a car or home, a loan, lease or contract, moving, changing schools, a plan with real risk): poke holes in it, weigh real alternatives including doing nothing, and give a ranked recommendation. Use for "what could go wrong?", "is this a good deal?", "est-ce une bonne affaire ?", "شنوة ممكن يغلط قبل ما نمضي؟".'
toolsets: []
examples:
  positive:
    - "Stress-test my plan to buy this apartment with a loan"
    - "Est-ce une bonne affaire ce contrat de leasing ?"
    - "شنوة ممكن يغلط في هذا العقد قبل ما نمضي؟"
  negative:
    - "Pizza or sushi tonight?"
    - "Which laptop should I buy for school?"
---

# Decision stress test

The point is to find the problem before they sign, not after. Judge the thing itself (the terms, the numbers, the
plan), not the argument they have already built for it.

1. **Frame it in one line.** What are they about to commit to, by when, and what is at stake: money, time, the
   family, and whether it can be undone. Add 3 to 5 criteria that matter to them (cost, commute, safety, the kids…).
   Take what you can from the conversation and memory (`recall`); ask only a missing fact that would change the answer,
   in one `ask_user` round.
2. **Get the real thing.** The actual offer, contract, listing or plan, not a summary of it: an uploaded file
   (`library_read`, if they have the Library), a page (`web_read`, if they have the web), or the pasted text. Note the
   fine print as you go.
3. **Line up genuinely different options (3 to 5).** Always include "wait / do nothing" and one that turns the
   problem around (rent instead of buy, negotiate instead of switch, repair instead of replace). Options that differ
   only in colour don't count.
4. **Stress each option.** For each, look for:
   - the total cost over time, including recurring and hidden costs (fees, insurance, maintenance, exit penalties);
   - fine print: auto-renewal, cancellation terms, variable rates, notice periods, who pays for what;
   - how reversible it is, and what it costs to back out after a month, a year;
   - the worst realistic case, and who in the family carries it;
   - the one assumption that, if wrong, sinks it;
   - pressure tactics: a deadline that is suspiciously short, "only today", a seller who profits from the answer.
   Check factual claims on official or primary sources and note their date. A seller's claim is a claim, not a fact.
5. **Sort what you found.** Each finding is one of: a real problem with a fix (say the fix), a trade-off to accept
   knowingly, or not an issue given what you know (say why). Re-check an option after its fixes.
6. **Rank.** A compact table: option × criteria plus reversibility and risk. Then one clear recommendation, the first
   three steps, the warning signs that would mean it is going wrong, and a date or trigger to look at it again.
7. **Skeptic pass before you answer.** Would a sharp stranger spot a hole you skipped? Does the recommendation answer
   the question they actually asked? If big issues remain after two or three rounds, say plainly that it is not ready.
8. **Read back before acting.** If they want to act on the result (book, buy, reply, sign), list what was decided and
   what you assumed, and get a yes first. Money, signing and sending stay theirs, and every payment or message goes
   through the approval card.
9. **Keep it short in chat:** at most about 200 words plus the table. Offer the long version as a document.

## The decision record (offer it)

If they have the Library, offer to save a document titled "Decision: …" with `library_create` (markdown):
context and date, who decided, the options with why each was rejected, the decision, what it costs and what they give
up, what to watch, and the revisit date. Status: accepted. When a decision changes later, write a new record that
says which one it replaces; keep the old one. In a project chat, add a `decision` row with `project_update` instead.
Offer a reminder for the revisit date (`set_reminder`), and `remember` one short dated line if it is a lasting choice.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "It looks fine" | Confidence isn't evidence. Read the terms. |
| "The seller said it's included" | A claim. Find it in the contract or say it isn't there. |
| "Doing nothing isn't an option" | It is always an option; it is often the baseline everything else must beat. |
| "Probably around €X a month" | Work out the real number from the terms, or say you couldn't find it. |

Legal, medical and large financial decisions: give the analysis, say where a professional (lawyer, notary, doctor,
independent adviser) should check it, and don't present your view as advice from one.

## Done when
- At least three genuinely different options were weighed, including doing nothing.
- Every finding is marked fix / trade-off / not an issue, with the reason.
- There is a ranked table, one recommendation, warning signs and a revisit date.
- Nothing was booked, signed, paid or sent before an explicit yes and the approval card.
- A "Decision: …" record was offered.

Sources: report-selfimprove decision-stress-test draft; addyosmani/agent-skills (doubt-driven-development, pre-mortem, documentation-and-adrs); volt-life big-decision (aoi-council, first-principles method only); mattpocock/skills grilling (read-back before acting).
