// Reciprocal rank fusion (decisions #95, #151): several ranked lists of ids → one ranking. An id's score is the sum over
// the lists it appears in of 1 / (k + rank), rank counted from 1; k = 60 (the usual constant) keeps one list's top hit from
// drowning out an id that several lists agree on. Used by project-file search and by memory recall.
export const RRF_K = 60;

/**
 * { name: [id, …best first], … } → [{ id, score, via }] best first. `via` is the list's name when only one list found the
 * id, 'both' when more than one did. Ties keep the order the ids were first seen in (earlier lists first).
 */
export function rrfMerge(lists, { k = RRF_K } = {}) {
  const merged = new Map();
  for (const [name, ids] of Object.entries(lists)) {
    ids.forEach((id, i) => {
      const hit = merged.get(id);
      const add = 1 / (k + i + 1);
      if (!hit) { merged.set(id, { id, score: add, via: name }); return; }
      hit.score += add;
      if (hit.via !== name) hit.via = 'both';
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}
