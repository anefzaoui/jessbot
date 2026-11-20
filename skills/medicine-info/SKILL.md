---
name: medicine-info
description: 'Questions about a medicine: what it''s for, how it''s taken, side effects ("effets secondaires", "الآثار الجانبية"), who shouldn''t take it, whether two medicines (or a medicine and food or alcohol) mix, a recall or shortage, or the local equivalent of a foreign brand. Answers from the official leaflet and the regulator, with citations.'
toolsets: [web]
examples:
  positive:
    - "Can I take ibuprofen with my blood pressure medicine?"
    - "Quels sont les effets secondaires du Doliprane ?"
    - "ما هي الآثار الجانبية لهذا الدواء؟"
  negative:
    - "Prepare questions for my doctor's appointment tomorrow"
    - "Help me start a habit of drinking more water"
---

# Medicine info

1. **Pin the exact product.** Brand name and active ingredient, strength, form (tablet, syrup…) and the country: the same
   brand can contain different things in different countries. Ask when it's unclear. Search by the medicine's name only;
   never put the person's name or their condition into a search.
2. **The official leaflet first.** Find the product information approved for their country: the national medicines
   regulator's database or leaflet; in Europe the EMA (and national agencies such as France's public medicines database);
   in the UK medicines.org.uk; in the US DailyMed, or the openFDA label data
   (`https://api.fda.gov/drug/label.json?search=openfda.generic_name:"<name>"&limit=1`, read with `web_read`). For plain
   language, add MedlinePlus or the national health service. Search in the local language too.
3. **Answer from the leaflet's sections:** what it's for, how to take it (quote the wording exactly), who shouldn't take
   it, warnings, side effects by how common they are, pregnancy and breastfeeding, storage. Cite the source with its
   version or date.
4. **Mixing medicines.** Check both leaflets. "Not mentioned" is not the same as safe: say so, and suggest asking the
   pharmacist, who can see everything they take.
5. **The lines you don't cross.** Don't diagnose, don't work out a personal dose (children by weight, pregnancy, older
   people, kidney or liver problems), and don't advise stopping or switching a medicine. Quote what the leaflet says and
   point to their doctor or pharmacist for their own case.
6. **Red flags mean emergency now:** trouble breathing, swelling of the face or throat, chest pain, fainting, a possible
   overdose, or a child who swallowed medicine. Give the local emergency number and poison centre (look them up for their
   country; never assume a US number) and stop the chat there until they're safe.
7. **Recalls and shortages:** the regulator's recall or shortage page, with its date.
8. **Offer the useful next step:** medicine reminders with `set_reminder` (`repeat` as prescribed; when they ask to be
   nudged until it's taken, a `follow_up`, closed with `reminder_done` once they say so), or to `remember` an allergy or
   a medicine they take, if they want that kept.

| Excuse | Reality |
|---|---|
| "It's a common medicine, the usual dose is…" | Quote their country's leaflet, or don't give a dose. |
| "No interaction was found" | Not mentioned is not safe: say so and point to the pharmacist. |

## Done when
- The exact product and country are named.
- Every answer traces to a leaflet or regulator page, with its date.
- No personal dose was worked out and nothing was diagnosed.
- Red flags were checked, with the local emergency route given when relevant.

Sources: OpenClaw med-info (ideas, own words); research review drafts.
