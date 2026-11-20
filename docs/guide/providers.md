# Models and costs

Jessbot doesn't come with an AI model of its own: you bring one, and you pay the provider for what it uses. This page
explains which providers work, what each one can do, how to choose the models in Admin → Models, and how weekly budgets
keep the bill where you want it.

## OpenRouter, the default

Out of the box Jessbot talks to [OpenRouter](https://openrouter.ai), a service that offers many models behind one key.
You paste the key on the setup page (or put it in `.env` as `OPENROUTER_KEY`), and Jessbot saves it in `.env` on this
machine, never in the database. The default model is `openai/gpt-6-luna`, a cheap, capable one picked for everyday
household use.

## Any OpenAI-compatible endpoint

You can use another service that speaks the OpenAI API instead: OpenAI itself, or a model server you run yourself.
On the setup page or in Admin → Models, open **Advanced: a different endpoint** and enter its **Base URL**. Before the
first setup you can also set `LLM_BASE_URL` (and `LLM_MODEL`) in `.env`; after setup, change them in Admin → Models,
because the values in `.env` are only the starting defaults. The key goes in the same place either way
(`OPENROUTER_KEY`, or `LLM_API_KEY`).

A model server on your own network works without opening the local network to the agent's browser: the address you
configure is allowed, and only that one. Choose a model that supports tool calls, or the assistant can't act.

## What works where

| Feature | OpenRouter | Other OpenAI-compatible endpoints |
|---|---|---|
| Chat, tools, memory, Library, everything else | Yes | Yes, with a model that supports tool calls |
| Memory search by meaning | Yes | Falls back to keyword search |
| Voice replies (spoken audio) | Yes | No |
| Making pictures | Yes | No |
| Quick decisions (a small second-opinion model) | Yes | No, the built-in rules are used instead |
| Model prices, spending budgets, balance alerts | Yes | Prices only from what was used; budgets may not count everything |

## Admin → Models

![Admin → Models: the API key saved in .env, the main model openai/gpt-6-luna, two fallback models tested when added, and a background model](../images/admin-models-desktop-light.webp)

The tiles at the top say what the assistant **Thinks with**, **Speaks with**, **Listens with** and **Decides with**.
Below them:

- **Model**: the main model. Every reply goes to it first. Any model id your provider offers works; the cheapest one
  that answers well is usually the right choice.
- **Fallback models** (optional, up to 3): when the main model is down, busy or refuses, the next one answers, in the
  order you set. Each one answers a tiny test before it is added (**Test and add**). OpenRouter supports a fallback
  order; other endpoints may not. Admin → Usage shows how often a fallback answered.
- **Background model** (optional): a cheaper model for summaries, memory, the feed and goals. If it fails or answers
  badly, the main model tries once. Leave it empty and the main model does this work too.
- **Save and test** saves your changes and checks that the model answers.

Further down the same page:

- **Jess's voice** (titled with your assistant's name): which voice it speaks with (Auto follows its look) and the
  models for speaking and for transcribing your voice notes. Spoken replies need OpenRouter.
- **Quick decisions**: a small decision model answers narrow questions in about a third of a second, so the assistant
  skips work that isn't needed and moves faster in its browser. You can switch each use on or off,
  choose how sure it must be before it acts, and try it with **Try a decision**. It can only add checks, never skip
  one. It needs an OpenRouter key and endpoint; without them everything is decided the usual way.
- **Pictures**: an image model for invitations, colouring pages and story art. It stays off until you enter an image
  model id, and then only people with the **Pictures** permission can use it (off for everyone until you turn it on in
  Admin → Permissions, Groups or People). Saving checks the id with the provider and shows what a picture costs,
  without making one. Each picture counts against that person's weekly budget.

## Budgets and spending limits

Every person has a **weekly budget** in US dollars: $2 a week unless you change it. The week resets on Monday. Set it
for everyone in Admin → Permissions, or for a group or one person in Admin → Groups and Admin → People (leave
"Inherit" to follow the level above). A budget of 0 means no limit.

Next to it, **One task, at most (USD)** caps a single task: a task that would spend more stops and asks first. By
default the cap is $0.50 or a quarter of the weekly budget, whichever is lower; 0 means no cap per task.

What happens as a budget fills:

- each person gets a notification at 75 %, 90 % and 100 % of their week;
- once it is reached, new tasks and background work wait until Monday;
- the admin is alerted on a day that costs far more than usual, or when the provider keeps failing.

Everyone sees their own spending in You → Usage and in the "Usage this week" bar in the sidebar.

## Admin → Usage

![Admin → Usage: this week's and the last 30 days' spending, the OpenRouter balance with "Under a week left", a daily chart and each person's spend against their budget](../images/admin-usage-desktop-light.webp)

Admin → Usage shows this week's and the last 30 days' spending, a chart by day, each person's spend against their
budget, what the money went to, which models it went to, and the costliest tasks. With an OpenRouter key it also reads
your **OpenRouter balance** every few hours, estimates how many days it will last at this pace, and warns when that is
under a week. Press the arrow on the balance card to read it now.

Related: [Guide index](README.md) · [Getting started](getting-started.md) ·
[Approvals and safety](approvals-and-safety.md) · [People and admin](people-and-admin.md) · [FAQ](faq.md) ·
[Troubleshooting](troubleshooting.md)
