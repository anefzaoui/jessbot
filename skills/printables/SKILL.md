---
name: printables
description: 'Designing something to print or post: a party invitation, poster, flyer, greeting card, certificate, menu, sign, chore or reward chart, name labels, or a Wi-Fi guest card with a QR code. A designed page at the exact paper or social-post size, checked, and exported as a print-ready PDF or a picture to share on WhatsApp. Use for "make an invitation for…", "a poster for our bake sale".'
toolsets: [library]
---

# Printables

For family printables the facts must be clear before anything is pretty: a beautiful invitation with the wrong date
is a failure.

1. **The facts that must be right.** Names spelled right, the date with its weekday, time, full address, RSVP (by when,
   to whom, how), dress code, anything to bring. Read them back and get a yes before designing.
2. **Size and use.** A4, A5 or Letter for paper; square (1080×1080) for a post; story (1080×1920) for a status;
   landscape or portrait; how many per sheet (two cards on A4 need cut marks). Printed at home or at a shop (a full dark
   background uses a lot of ink at home).
3. **One idea.** A single visual idea in one sentence, tied to the occasion ("a quiet Japanese-print feel with one red
   sun", "a chalkboard menu for a café"), a palette of 2–3 colours, and fonts that export reliably: Noto Sans, Noto
   Serif and Noto Naskh Arabic are built into the export. Arabic runs right to left (`dir="rtl"`).
4. **Build the page** with `library_create` (`type: "html"`) at the exact size: fixed width and height, nothing to
   scroll, `@page` with the size and a margin (or the page's own padding as the margin). Margins of at least 10 mm;
   nothing touches the edges; nothing overlaps; little text, all of it legible (body text at least 11 pt on paper,
   poster headlines readable from across a room); strong contrast.
5. **Wi-Fi guest card.** The network name and password come from the person and are used only on the card: don't
   `remember` the password (it would travel with every message) and keep the card in their private Library. The QR code
   holds `WIFI:T:WPA;S:<network name>;P:<password>;;` (put a backslash before any `;`, `,`, `:`, `"` or `\` in the
   name or password; `T:nopass` for an open network). Draw it inside the page with a small QR library from the allowed
   CDNs, and print the network name and password in text under it for guests without a camera. Suggest scanning it
   with a phone once before printing. A contact card works the same way with a vCard or MECARD code.
6. **Check it, then export.** Read the check results `library_create` returns and look at the phone screenshot; fix
   overlaps and overflow once with `library_edit`. Then `library_export`: `format: "pdf"` with the paper `size` for
   printing, `format: "png"` with `size: "square"` or `"story"` to share. Look at the exported picture (`view_image`
   on the new item) and fix anything cut off. Refine; don't add more elements.
7. **Hand over** the PDF and PNG links with printing tips: print at 100% ("actual size"), not "fit to page"; heavier
   paper (200 g/m² or more) for cards; cut along the marks.
8. **An illustration** only if they want one: if you have `make_image` (it costs from their weekly budget), make it
   first with `depicts: "no_real_people"` for a made-up scene (a real person only as the tool allows), a `size` that
   fits the layout and a `style` when one suits (`"colouring_page"`, `"storybook"`), then place it on the page;
   otherwise shapes and type do the work.

| Excuse | Reality |
|---|---|
| "Saturday the 12th" | Check the weekday matches the date. |
| "It'll fit when printed" | Export it and look; fix what's cut off. |
| "Add a few more decorations" | Refine what's there instead. |

## Done when
- Every fact on the design was read back and confirmed.
- The page is at the exact size, with margins and nothing overlapping or cut off in the export.
- A print-ready PDF and/or a shareable PNG exist and are linked.
- A Wi-Fi password was used only on the card, never saved to memory.

Sources: anthropics/skills canvas-design (Apache-2.0, adapted and modified: see NOTICE.md and LICENSE.txt); composio canvas-design poster idea; volt-life wifi-guest-card (OpenClaw; idea, own words).
