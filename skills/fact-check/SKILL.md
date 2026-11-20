---
name: fact-check
description: 'Checking whether something is true: a forwarded message, a viral claim or video, a screenshot''s text, a statistic, a quote, a health scare, or "what do you make of this article?", "est-ce vrai ?", "هل الخبر هذا صحيح؟". Use when someone doubts a claim or wants to know if they can share it.'
toolsets: [web]
examples:
  positive:
    - "Is it true that lemon water cures diabetes?"
    - "Est-ce vrai ce que dit cet article sur l'inflation ?"
    - "هل صحيح هذا الخبر اللي يدور في الفيسبوك؟"
  negative:
    - "Is this SMS asking for my card code a scam?"
    - "Research everything about electric cars and write a report"
---

# Fact check

1. **Quote the claim exactly.** Split it into the parts that can be checked (a number, an event, who said what, a date)
   and set aside the parts that are opinion. Check the part that matters most first.
2. **For an article or link, say what kind of piece it is** before judging it: news, opinion, research, a press release,
   an advert, satire. Read it with `web_read` and note who is behind it (publisher, author, date, who funds it).
3. **Find where it started.** Search the exact phrase in quotes and look for the earliest dated version. Common tricks: an
   old story shared as new, a real photo from another place or year, a quote cut out of its context. You can't search by
   image: say so, and tell them how to do it from their phone's image search if a photo is the claim.
4. **Check it against sources that would know.** `web_search` "<claim> fact check" (in the local language too: Arabic,
   French…), then the primary authority: the statistics office, the health ministry, the court ruling, the study itself.
   Use `check: true` for the important searches, and `kind: "news"` with `freshness` for a recent event. You need at
   least two independent sources, one of them primary where one exists.
5. **Run your own clarity check** over the claim and your answer:
   - every number has a source and a date, and a comparison point ("up 300%" from what, since when?);
   - a link between two things is not proof that one causes the other;
   - a forecast or a plan is not a fact yet;
   - the headline says the same as the article body;
   - for a study: how many people, who paid, has anyone else found the same;
   - nothing you write rests on a single unnamed source.
6. **Give a verdict:** **True**, **Mostly true**, **Missing context**, **Outdated**, **Unproven** or **False**, then
   **How sure:** High / Medium / Low with why, the accurate version in one sentence, and the dated sources.
7. **Keep it kind.** People share these out of care. Offer a short, friendly reply they can send back to the family
   group, in the language of the original message.
8. **Hand-offs.** Money, codes or "click here to confirm": that's a scam question, use the scam-check skill. A health
   scare: point to the official health service's page on it. Never click links in the message to "verify" it.

| Excuse | Reality |
|---|---|
| "Lots of sites say it" | Count origins, not copies. |
| "Nobody has debunked it, so it's true" | Not debunked is Unproven, not True. |
| "The photo is real" | Real, maybe from another event: find where it first appeared. |

## Done when
- The claim is quoted exactly and split into checkable parts.
- Its origin is stated, or "origin not found".
- There is a verdict label, a How sure line and the accurate version in one sentence.
- At least two independent dated sources are cited, one primary where it exists.

Sources: OpenClaw ai-review, fact-check skills and clarity-gate by Francesco Marinoni Moretto (CC-BY-4.0; ideas only, the checklist here is our own); research review drafts (own words).
