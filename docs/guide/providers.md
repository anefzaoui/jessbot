# Models and costs

Jessbot doesn't come with an AI model of its own: you bring one, and you pay the provider for what it uses. This page
explains which providers work, what each one can do, how to choose the models in Admin → Models, and how weekly budgets
keep the bill where you want it.

## OpenRouter, the default

Out of the box Jessbot talks to [OpenRouter](https://openrouter.ai), a service that offers many models behind one key.
You paste the key on the setup page (or put it in `.env` as `OPENROUTER_KEY`), and Jessbot keeps it on this machine,
encrypted with the install's own key; a key written in `.env` moves there the next time Jessbot starts. A key set in
the server's environment (Docker's `environment:`, systemd) is used as it is and never stored. The default model is `openai/gpt-6-luna`, a cheap, capable one picked for everyday
household use.

## Ollama: models on your own computer

[Ollama](https://ollama.com) runs models on your computer or another one on your network: free, private (nothing leaves
your network), and slower. On the setup page or in Admin → Models pick **Ollama**: the address fills in
(`http://127.0.0.1:11434/v1`; with Jessbot in Docker and Ollama on the computer, `http://host.docker.internal:11434/v1`),
no key is asked for, and the models Ollama has are listed. Pick one that can call tools and is **7B or larger**
(`ollama pull qwen2.5:7b`, `llama3.1:8b`): smaller ones connect but get lost in Jessbot's instructions. For memory
search by meaning, also `ollama pull nomic-embed-text`. A few features need OpenRouter and are off (below).

### Give Ollama a context of 32,768 tokens

Jessbot's instructions and its list of tools come to about 25,000 tokens before the conversation starts. Ollama's
default context is much smaller (4,096 tokens on most graphics cards), and Ollama doesn't refuse a longer prompt: it
drops the start of it. The model then never sees most of its instructions or tools, calls tools at random and answers
"…", while the connection test (a tiny prompt) still passes. The context is set **on the Ollama server**, not by
Jessbot: Ollama's OpenAI-compatible endpoint, the one Jessbot uses, ignores a context size sent with a request.

Set it where Ollama runs, then restart Ollama:

| Ollama runs as | Set |
|---|---|
| The Windows or macOS app | `OLLAMA_CONTEXT_LENGTH=32768` as a user environment variable (Windows: Settings → System → About → Advanced system settings → Environment Variables; macOS: `launchctl setenv OLLAMA_CONTEXT_LENGTH 32768`), then quit Ollama from its tray or menu bar icon and start it again |
| Linux (systemd) | `sudo systemctl edit ollama`, add `[Service]` and `Environment="OLLAMA_CONTEXT_LENGTH=32768"`, then `sudo systemctl restart ollama` |
| Docker | `-e OLLAMA_CONTEXT_LENGTH=32768` on `docker run` (or under `environment:` in compose) |
| One model only | a Modelfile with `FROM qwen2.5:7b` and `PARAMETER num_ctx 32768`, then `ollama create qwen2.5-32k -f Modelfile` and pick `qwen2.5-32k` |

On a graphics card with **8 GB** (an RTX 4060, say), a 7B model with a 32,768-token context no longer fits and spills
onto the processor: replies slow to a couple of words a second. Two more settings make it fit again:
`OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` (the context's cache at 8 bits, half the memory). Measured
with `qwen2.5:7b` on an RTX 4060: the whole model and its 32,768-token context on the graphics card (5.6 GB), a plain
question answered in about 20 seconds, a task with several steps in one to two minutes. A bigger context helps long chats if your memory allows it: Jessbot folds older messages into a
summary sooner when the context is small.

Jessbot checks this for you. **Test the connection** (setup) and **Save and test** (Admin → Models) read the context
Ollama loaded the model with and compare it with your own prompt: when it is too small, or Ollama doesn't say, a
warning under "Connected" says what to set. A task that still doesn't fit stops with the same advice instead of
running on a cut prompt, and the server log says why (`[agent] … doesn't fit the model's context`).

## Another OpenAI-compatible service

OpenAI itself, LM Studio, a LiteLLM or vLLM server: pick **Another OpenAI-compatible service**, enter its address
(usually ending in `/v1`), its key if it needs one, and the model's name as the service calls it. Before the first
setup you can also set `LLM_BASE_URL` (and `LLM_MODEL`) in `.env`. A key you save is used only for the address you saved
it with: switching to another service asks for that service's key.

A model server on your own network works without opening the local network to the agent's browser: the address you
configure is allowed, and only that one.

## What works where

| Feature | OpenRouter | Ollama | Another OpenAI-compatible service |
|---|---|---|---|
| Chat, tools, tasks, goals, the feed, projects | Yes | With a model that calls tools, 7B or larger, and a 32,768-token context | Yes, with a model that calls tools |
| Memory search by meaning | Yes | With `nomic-embed-text` pulled | If it serves an embedding model; otherwise by keywords |
| Fallback models | Yes | No: the main model only | No: the main model only |
| Quick decisions | Yes | Off: the full model or plain rules decide | Off |
| Voice notes (speaking and listening) | Yes | Off: text only | Off |
| Making pictures | Yes | Off | Off |
| Reading scans and photos of text | Yes | Off | Off |
| Spending caps in dollars | Yes | Free, nothing to count | The service doesn't report costs, so budgets can't count spending |
| Low-balance warning | Yes | n/a | Off |

Admin → Models marks each feature that is off with your provider, and keeps its settings for when you switch back.

## Admin → Models

![Admin → Models: the API key, the main model openai/gpt-6-luna, two fallback models tested when added, and a background model](../images/admin-models-desktop-light.webp)

The tiles at the top say what the assistant **Thinks with**, **Speaks with**, **Listens with** and **Decides with**.
Below them:

- **Model**: the main model. Every reply goes to it first. Any model id your provider offers works; the cheapest one
  that answers well is usually the right choice.
- **Fallback models** (optional, up to 3): when the main model is down, busy or refuses, the next one answers, in the
  order you set. Each one answers a tiny test before it is added (**Test and add**). Only OpenRouter takes a
  fallback order; with other providers the main model answers alone. Admin → Usage shows how often a fallback answered.
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
