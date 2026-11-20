# Quick decisions — Jev, the decision model (Phase 16, decisions #106–#111)

Owner's ask (2026-09-25): research Jev ("a system bot, a decision bot"), find it on OpenRouter, see what people build
with it, and integrate it "to take max advantage" — as its own model choice next to the LLM and voice models. Then:
"for browser use learn from [jev-ultrafast and typesafe-computer-use] … bring the technology to us".

## What Jev is (researched 2026-09-25, four parallel agents + live calls)
- TypeSafe AI's "System One" model (released 2026-09-15). **Not an LLM**: no text out. You send a **state** (text or a
  JSON object) and named **questions**, answered in parallel with calibrated probabilities:
  - `choice` — one of up to 255 options → `{ choice, probabilities, confidence }`
  - `noul` — yes-probability (the name comes from Bernoulli) → `{ noul }`
  - `score` — 2–10 ordered levels → `{ score, probabilities, legend, confidence }`
- **Through OpenRouter with our key**: `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`
  (`~typesafe/jev-latest` floats — we pin). It is not a chat model (`/chat/completions` doesn't serve it); it only
  appears in `/api/v1/models?output_modalities=all`. 32K context, **text only**, $0.042 per million input tokens,
  output free. Measured from here: **0.3–0.6 s**, $0.00002 for three questions.
- `typesafe/jev-router` is something else: a chat router that picks a model per request (not used).
- Weaknesses (vendor + community): literal reading; no numbers/dates/counting (do those in code); accuracy drops with
  long noisy state; **steerable by text injected into the state**; option wording/order matters; add an `other` option;
  English is strongest. Best practice: atomic questions fanned out in one call, act on confidence thresholds, pin the
  model version.
- Community patterns: cheap-model-decides / big-model-acts; the indexed element table for browser agents
  (browser-use/jev-ultrafast: Google Flights in 7.1 s); confidence-gated escalation; keeping math in code.

## How Jess uses it
One client (`services/decide.js`) with a switch per use, a confidence bar (default 60%) and a **fallback for every use**:
off, error, timeout or unsure → exactly what Jess did before. Every call is logged (`decisions`, 30 days) and costed
(usage purpose `decide`). Admin → Models → Quick decisions: switches, stats, "Try a decision", recent decisions.

| Use | Where | What it decides | If unsure / off |
|---|---|---|---|
| Check-ins | `agent/proactive.js` → `sense.worthCheckin` | anything worth saying now (it also sees remembered dates: the next 7 days and one-off events of the last 3, #154, and the notes unattended work left for them, #200; an important note skips the question and goes ahead)? skip before the full model | check-in runs as before |
| Check-ins: goal lapse nudge (same `checkin` switch, #183) | `agent/goals.js` `nudgeLapses` (goals tick; only after the code found a lapse on a per-week rhythm and the person may get one today) | would a short, friendly "how is it going?" be welcome now, given the recent chat (not when they're ill, away, on a break, dropped it, or already said they did it)? a clear no → no nudge, asked again a day later | the nudge goes out (≤ 1 a day per person, 1 per lapse) |
| Memory pass | `services/context.js` `worthRemembering` | a durable fact / something worth a one-line episode / a project change? (skips only when all ≤ 0.25; #155) | memory pass runs |
| Ideas & goal reviews | `agent/goals.js` → `sense.worthReflecting / worthReviewing` | anything new since last time? | runs as before |
| Ideas: overnight prep (same `reflect` switch, #199) | `services/prep.js` `pickIdea` (goals tick → `prepTick`; only for someone who opted in, in their quiet hours, not busy, budget not low, with ≤ 5 open research/plan/draft/comparison ideas never tried) | per idea (a noul): worth preparing tonight, will they still care tomorrow (fits what they talk about, not done or dropped in the recent chat), can research, a plan, a draft or a comparison move it forward without them? The highest wins; all a clear no (≤ 1 − the bar) → nothing tonight, not asked again until the next night | the newest candidate is prepared (logged as a fallback) |
| See it through, and the checks before a reply counts (#113, #176–#181) | `agent/loop.js` `checkReply` → `sense.goalCheck` (one call per final reply, only the questions needed) | after real work: delivered? the next step theirs? a question for them? every explicit requirement met (dates, times, headcount, class, budget, place, format, language; one not mentioned counts as unmet)? · when the code audit (`agent/reply-audit.js`) found a "done" claim no step backs, a denial of an enabled tool or a promise with nothing scheduled — or the reply is in a non-Latin script — which action it claims (choice), which ability it denies (choice), a promise (noul) · each figure code couldn't find in what the task read, with the nearest evidence (never her reasoning): stated in or computed from it? · in chats: did they ask for something none of their abilities can do (the wish log)? → ONE push with a specific nudge (≤ 3 per task; the audit and the figures push once each) | code alone: the audit's hits in Latin scripts push (its patterns are specific), unmatched figures push, "delivered" and requirements aren't judged, a denial of something outside their toolsets goes to the wish log |
| Reminder answers (#209) | `agent/reminders.js` `settle` (after each chat turn while a reminder waits, and before a nudge; once per reminder post and message) | the person was reminded of “<label>”: does the message say it's done, ask to stop the reminders, or neither (a choice) · is it about this reminder and not another one waiting in the chat (a noul)? Done/stop act only when both clear the bar; a confident "neither" leaves the reminder open | `lib/reply-intent.js` (English, French, Arabic and Maghrebi Arabic; negations and questions never count; a bare "done" only as the direct answer with one reminder waiting), plus the main model's `reminder_done` in the turn |
| Voice, language, memories, routing | `agent/sense.js` `senseTurn` (started with each message; the query embedding races 0.9 s, then Jev gets 3 s; the run's first step waits for it up to that budget + 0.3 s counted from the message, `SENSE_MAX_MS`; measured ~0.6–0.7 s typical) | spoken reply wanted? reply language? which memories matter (of ~40 candidates found by words and meaning) and which earlier conversations (of ≤ 6 episodes)? (#151, #155) · which skill fits (of the ≤ 12 whose name and description share the most words with the message, TF-IDF pre-filter) → "## Skill for this" in the tail; the reasoning effort (low/medium/high rubric) → sent with the chat call when the model lists `reasoning`; a careful topic (health/legal/money) → the safety text of that field + authoritative sources, nothing personal in searches, red flags first (#177) · does the message correct how she did something (a noul, `services/lessons.js CORRECTION_QUESTION`, ≥ max(bar, 0.6))? → the "They just corrected you" nudge in the tail (#187) | `reply_by_voice` tool, Arabic-letter rule, words-only recall; routing by keywords (a skill only when it clearly leads on 2+ words; careful topics by word lists; no effort), logged in the decisions log as "(by keywords)"; a correction by phrases in five languages (`looksLikeCorrection`) |
| Page state | `browser/session.js` `judgePage` (runs alongside the snapshot) | content / results / form / bot wall / login / cookie panel / paywall / error / confirmation + did the last action progress | the regex checks and the unchanged-page counter |
| Spend & send check | `agent/tools/browse.js` `riskCheck` → `policy.decide({ raised })` | would this click pay, book or send? (any language, icon buttons; raises at ≥ 60%, and "search" is its own answer — without it a Wikipedia search read 0.51 "send") | the regex; **it can only add an ask** |
| Fast steps | `agent/fast-steps.js` (loop, before a model step) | the obvious next click/scroll on the page she's working (≤ 4 in a row) | the full model takes the step |
| Autopilot | `browser_autopilot` tool → `agent/autopilot.js` + `browser/pilot.js` | drives a whole goal: operation + per-operation target each step; Mercury writes typed text | hands back (unsure, stuck, missing value, pays/sends) |
| Story relevance | `services/feed-relevance.js` (ticks, digests) → `feed-rank.js` | would they want this story, given what they asked the feed for? | ranking without it |
| Injection check (Safety, #120) | `agent/injection.js` `detect` (inside `guardOutside`, only after a stage-1 pattern matched visible outside text; one verdict per run and excerpt) | is this excerpt written to instruct an AI (act, change its instructions, hide something from its user), or ordinary text for people (a person asking a person, an article about AI)? A noul; the warning stays unless the answer is a clear no (below 1 − the bar) | the pattern stands: the warning goes in, the run is tainted-high, the audit event is written |

**Safety rules (all uses):** page text is untrusted data, so page judgments only *add* warnings and the risk check
only *raises* risk. The one exception is bounded: the injection check can clear a *visible* pattern match on a clear
"no" (so articles about AI and people writing to people don't cry wolf), but what it clears is still fenced and still
marks the run as having read outside content, and hidden text that trips a pattern is never sent to it; the autopilot never sees password/card fields and stops before any click that may pay, book or
send (Jess then uses `browser_click`, which asks the person); "done" from the autopilot is a claim — Jess checks the
page it hands back.

## The autopilot (from browser-use/jev-ultrafast, MIT; also informed by awlevin/typesafe-computer-use, MIT)
- **Observe** (`browser/pilot.js`, ported `snapshot.js`): one in-page read of visible HTML/ARIA controls with their live
  value, checked/selected/expanded state; a WeakMap gives each real node a code-owned id; ≤ 250 candidates; visible text
  (6 000 chars); scroll/wait controls.
- **Decide** (`agent/autopilot.js`, ported `model.py`): one request per page state — `operation` choice (CLICK /
  TYPE_TEXT / SELECT / SCROLL / WAIT / DONE / BLOCKED) plus a speculative target question per operation; instructions
  carry the goal and jev-ultrafast's next-step rules; only the chosen operation's target is used.
- **Text**: a small LLM (`inception/mercury-2.5`, setting `decide.textModel`) returns `{ "text": … }` for the field, or
  null when the goal lacks the value (→ hand back "needs information"). Never invents personal data.
- **Act safely**: before input, the target is re-checked (same page key, same node + nearby context, visible, enabled,
  not covered at its centre) and clicked at its current position; fill = click, select-all, insert text. After input:
  two animation frames (autocomplete waits up to 200 ms for options).
- **Bounds**: 30 actions, 60 decisions, 2 minutes; stops after three no-change actions or three "page changed" retries in a row (#112); hand-back below 35% — a target
  also counts as clear at ≥ 20% and twice the runner-up (the guardrails don't depend on it).
- Measured 2026-09-25 (CloakBrowser): Google Flights "one-way Zurich → London on October 3, 2026, 1 adult,
  economy" — 13 actions, **11.6 s**, correct results; ~$0.004 including the two Mercury calls.
