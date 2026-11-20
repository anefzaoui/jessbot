---
name: what-if-page
description: 'When a rule or plan is hard to judge on paper, build a clickable page to try it out: a chore rota or pocket-money rules, splitting bills between housemates, a savings or loan what-if, a shift or custody schedule swap, the rules of a family game. Use for "would this be fair?", "what happens if…", "let me play with the numbers", "simulate this".'
toolsets: [library]
---

# What-if page

People judge a rule best by poking it. A small page with buttons and scenarios shows in a minute what a paragraph of
explanation can't.

1. **State the question** at the top of the page in one short paragraph, in their words: "Is a rota where whoever
   finishes early picks the next chore fair to the youngest?" Get the rules and numbers from the conversation; ask only
   what's missing in one `ask_user` round. Use real figures they gave you (amounts, rates, dates); where you assume one,
   show it as an editable field labelled "assumed".
2. **Keep the rules in one small, pure script section**, separate from the buttons: the state, the actions, and a
   function that takes a state and an action and returns the new state. That makes the logic easy to check and to
   change when they say "no, it should work like this".
3. **Show the current state** as labelled fields and small tables in plain words (who has done what, balance per
   person, month by month), never as raw data. After every click, update it and highlight what just changed.
4. **Free-play buttons**, one per action ("Theo does the dishes", "Add a month", "Pay €50 extra"), plus inputs for the
   numbers people will want to change (a slider or number field for a rate, a price, a share).
5. **Scenario tabs**, each resetting to the same start and playing its steps:
   - the normal case;
   - a tricky edge case (someone away for a week, a rate going up, an odd number of people);
   - something that should be impossible (a negative balance, the same chore twice in a row) to show the rules stop it.
6. **Their words, not code words.** Names of real people, the local currency, plain labels. Clean design, one accent
   colour, works on a phone and in dark mode. One self-contained HTML file with inline CSS and JS; no storage and no
   network calls (the Library blocks them). If maths matters (loans, savings), also show the formula used in plain words.
7. **Save it** with `library_create` (`type: "html"`) and read the check result it returns; fix any problem it lists
   (script errors, text cut off on a phone) with `library_edit`. In chat, say what to try first.
8. **Their "wait, that shouldn't happen" is the finding.** Fix the rule in the script section with `library_edit`,
   say what changed, and let them try again. When they settle on a rule, offer to write it down plainly (a note, a list,
   a message to the family).

Money what-ifs are illustrations, not financial advice: say the assumptions, and point to the lender's or bank's own
figures for a real decision.

## Excuses → reality

| Excuse | Reality |
|---|---|
| "I'll explain the rule in a paragraph" | They asked to see it. Buttons and scenarios. |
| "The logic can live in the click handlers" | One pure rules section, so it's checkable and changeable. |
| "A typical interest rate is fine" | Use their figure, or an editable field marked "assumed". |
| "The page saved, so it works" | Read the check result and fix what it lists. |

## Done when
- The question is stated at the top in their words.
- The rules live in one separate script section; state is shown in plain labels and updates on each click.
- There are free-play buttons and at least three scenarios (normal, edge, impossible).
- The page saved without listed problems, and they know what to try.

Sources: mattpocock/skills prototype (logic prototype idea, MIT), adapted and rewritten for Jessbot; see NOTICE.md.
