---
name: generative-art
description: 'Generative art for fun or for the wall: flow fields, particles, geometric or Islamic-style patterns, a living wallpaper or screensaver, or a first "make art with code" moment for a child. An interactive page with a seed and sliders to explore, and a picture to download or print. Use for "make some generative art", "a moving pattern for the TV".'
toolsets: [library]
---

# Generative art

1. **One concept.** A sentence tied to what they asked or love ("the sea at dusk as slow flowing lines", "tiles like
   the old medina, in Maya's favourite colours") and a named palette of 3–5 colours.
2. **Reproducible randomness.** Keep every setting in one `params` object (seed, counts, speed, sizes, colours) and
   seed both the random and the noise generators from it (in p5.js, `randomSeed` and `noiseSeed`), so the same seed
   always draws the same picture.
3. **The page.** p5.js from cdnjs; a side panel with the seed (previous, next, random, jump to a number), sliders for
   the settings that really change the picture, a reset, and "Download PNG" (`saveCanvas`). It fills the screen on a
   phone or a TV, aims for smooth motion, caps the particle count on phones, pauses when the tab is hidden, and shows
   a still picture under `prefers-reduced-motion`.
4. **Save and check.** `library_create` (`type: "html"`); read the checks it returns and fix real problems once.
5. **For the wall.** A fixed-size version of the seed they like, exported with `library_export` (`format: "png"` or
   `"pdf"`, `size` A4, A5 or Letter, `landscape` if wide), with the seed in a small caption so it can be made again.
6. **With a child,** explain one idea in plain words (what a seed is: "the same number always makes the same
   drawing") and let them choose the colours and press "random".

## Done when
- The concept and palette fit what they asked for.
- The same seed reproduces the same picture, and the sliders change it visibly.
- The page passed its checks and runs smoothly on a phone.
- A downloadable or printable picture is offered.

Sources: anthropics/skills algorithmic-art (Apache-2.0, adapted and modified: see NOTICE.md and LICENSE.txt).
