// A quantity given on its own (a tool call's qty, a form field) reads the same as one written in the item's text
// ("Milk 1L" → 1 L), so a list never shows "1L" for one item and "1 L" for the next. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { normalizeQty, parseItem } = await import('../src/services/lists.js');

test('explicit quantities take the parser’s form; what it can’t read stays as written', () => {
  for (const [given, want] of [['1L', '1 L'], ['2kg', '2 kg'], ['1.5 l', '1.5 L'], ['3 bottle', '3 bottles'], ['500g', '500 g'], ['x12', '12'],
    ['12', '12'], ['a dozen', 'a dozen'], ['', ''], [null, null]]) assert.equal(normalizeQty(given), want, String(given));
  assert.equal(normalizeQty('1L'), parseItem('Milk 1L').qty, 'the same as written in the text');
});
