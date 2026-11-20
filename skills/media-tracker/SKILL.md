---
name: media-tracker
description: 'What the family is watching, reading and listening to: to-watch and to-read lists per person, where they are in a series or book, ratings, new seasons or episodes of their shows, a new book by an author they love, and "what should we watch tonight?" picks from their own lists and tastes. Use for "add this film to our list", "what are we watching?".'
toolsets: [lists]
---

# Media tracker

1. **The lists.** `list_show` to see what exists; otherwise `list_create` with `kind: "custom"`: "To watch: family"
   (`shared_with` the family group when they want it shared) and personal ones ("To read: Maya"). `list_add` items with
   what they are: "Severance (series, season 2)", "The Little Prince (book, French)". Finished: `list_check`.
2. **Where they are and what they thought.** If they have the Library, a "Watched and read" log: `library_append` a
   table row that starts with the title (title, kind, who, date, rating out of 5, one line), with `key` set to the title
   so a later update replaces the row. Without it, a short `remember` ("Sam rated Dune 5/5").
3. **Tastes.** `remember` what each person likes and avoids (genres, no horror for the kids, languages, subtitles or
   dubbing), so picks get better.
4. **New seasons, episodes and books.** If they have the web: `web_search` with `freshness: "month"` ("<show> season 3
   release date"), and trust the official or trade source over fan sites. To be told when it's announced, a quiet watch:
   `schedule_task` weekly (`cron: "0 10 * * 6"`) with `only_when: "a release date for season 3 of <show> is announced"`
   (see watch-topic).
5. **"What shall we watch tonight?"** Start from their own list. Filter by who's watching (children's ages: the
   official age rating), mood and time available. Offer 3 with length and why each fits; where it streams belongs to
   where-to-watch. Still stuck: `pick_random` among the three.
6. **Bringing in an existing list** from a public Letterboxd or Goodreads page: `web_read` it on request and
   `list_add` the titles.
7. **A reading goal** ("24 books this year"): `goal_suggest` if they have goals.

| Excuse | Reality |
|---|---|
| "Season 3 is out in spring" | Only with a source and its date. |
| "Suitable for kids" | Check the official age rating. |
| "Add it again" | `list_show` first; the list skips duplicates anyway. |

## Done when
- Titles live on the right person's or family list.
- Ratings or progress are logged when they gave them.
- Release news came from a dated, reliable source, or a watch was offered.
- Tonight's picks came from their list and suit who is watching.

Sources: volt-life media-tracker (OpenClaw watchlist and reading-list skills; ideas, own words).
