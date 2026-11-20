# Translating Jessbot

Jessbot's interface is English for now, with everything in place to add languages. The assistant itself already reads
and writes in many languages; this is about the app's own words (buttons, labels, messages).

## How texts are marked

The English text is the key (gettext style), so code stays readable and a missing translation shows English, never a
blank:

| Where | Write |
|---|---|
| Templates | `{{t "Sign in"}}`, `{{t "Sign in to talk to {name}." name=bot.name}}`, as a value `label=(t "Email")` |
| Templates, plurals | `{{tn count "{count} file" "{count} files"}}` |
| Server code | `translate(locale, 'Text', { name })`, `translatePlural(locale, n, 'one', 'other')` (`src/lib/i18n.js`) |
| Browser code | `import { t, tn } from './i18n.js'`, then `t('Couldn’t save')`, `tn(n, '{count} file', '{count} files')` |

- Placeholders are `{word}`: pass the value with the same name. Values are inserted as text and escaped like anything
  else in a template.
- Write whole sentences. Don't build one from pieces (`t('You have') + n + t('files')`): word order differs between
  languages. When part of a sentence needs emphasis, make two sentences, or a sentence per case.
- Keep the text exactly as people should read it in English, typographic quotes and all; the key is the text.

## The list of texts

`npm run i18n` collects every marked text into `locales/messages.json` (each with the files and lines that use it) and
prints how far each language is. `npm run i18n:check` (run by CI) fails when that list is out of date, or when a
catalog has a text that is no longer used, a placeholder the English doesn't have, or a plural that isn't one.

## Adding a language

1. Create `locales/<code>.json` (`fr`, `ar`, `pt-BR`…): `{ "English text": "translation" }`. Plurals take the
   language's plural categories (`Intl.PluralRules`): `{ "{count} files": { "one": "{count} fichier", "other": "{count} fichiers" } }`
   (Arabic has zero, one, two, few, many, other).
2. Translate from `locales/messages.json`; anything left out shows in English.
3. `npm run i18n` to see the coverage and any problems.

A language is offered as soon as its catalog exists. The page's language is `?lang=<code>` (remembered in a cookie),
else the browser's preferred languages, else English. Arabic, Hebrew, Persian and Urdu pages are right-to-left
(`<html dir="rtl">`); English shown on such a page because it isn't translated yet keeps its own direction. Icons that
point somewhere (arrows) take `rtl:-scale-x-100`.

## Seeing what isn't translated

In development, `?lang=en-XA` shows every marked text with accents and brackets: `[Sígn ín]`. Whatever still reads as
plain English on that page isn't going through the layer yet.

## What is marked so far

The sign-in pages (sign in, two-step code, password reset, invite) and the shared form messages. The rest of the
interface, server messages (form errors, notifications) and a language picker on the You page come next.
