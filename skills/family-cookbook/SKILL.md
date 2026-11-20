---
name: family-cookbook
description: 'Saving recipes the family loves into one family cookbook: from a link or video, a photo of a cookbook page or handwritten card, or grandma dictating hers; finding them again and scaling servings. Use for "save this recipe", "add it to our cookbook", "write down mum''s couscous", "what was that lentil soup recipe?", "make a cookbook for grandma''s birthday".'
toolsets: [library]
---

# Family cookbook

1. **One cookbook.** `library_list` "Family cookbook"; if there's none, `library_create` it (`type: "md"`) with a short
   index at the top. One document per family, unless they want sections of their own (Desserts, Ramadan).
2. **From the source.**
   - A link or a video: `web_read` the page (a YouTube video comes with its transcript, a social post with its caption).
     Missing quantities or steps: say so plainly and ask; never invent them.
   - A photo of a cookbook page or a handwritten card: `view_image` and transcribe; ask about words you can't read.
   - Someone dictating: tidy it up, keep their words for the special touches ("until it smells like grandma's
     kitchen"), and ask what makes it repeatable (how much is "a glass"? how long exactly?).
3. **The same shape every time**: the title (with the name in the original language), who it's from, servings, time,
   ingredients with quantities, numbered steps, tips, and tags (quick, kids like it, Ramadan, Eid, vegetarian, freezes
   well). Keep the units they use, with a conversion in brackets when it helps.
4. **Add it** with `library_append`, `under_heading:` the recipe title and the whole recipe as the text (a new heading is
   made at the end). Check first that the recipe isn't already there; fix an existing one with `library_edit`. Add the
   title to the index.
5. **Finding and using.** "What was that lentil soup?": `library_read` the cookbook and give the recipe. Scaling ("for 10
   people"): recalculate every quantity and round to what can be measured.
6. **Sharing** on request: a designed HTML page with `library_create` (the make-a-page skill has the design steps) and a
   printable PDF with `library_export`, for a wedding, a new home or a grandparent's birthday.

## Done when
- The recipe is in the family cookbook in the standard shape, once, and listed in the index.
- Nothing was invented: missing quantities or steps were asked about or marked.
- Where a recipe came from (a person, a page, a video) is recorded.

Sources: OpenClaw recipe-saver and recipe-from-video skills (ideas, own words); volt-life review family-cookbook.
