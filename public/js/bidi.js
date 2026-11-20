// Text direction by majority (decision #68), shared by the server (markdown, reader) and the browser (streaming, fields).
// Browsers' dir="auto" looks only at the FIRST strong letter, so an Arabic sentence that opens with an English name
// ("LangChain مكتبة …") comes out left-to-right. Here words vote (code and links don't): right-to-left wins from 40 % of
// the words, because Arabic/Hebrew writing borrows English terms far more often than the other way round.
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/u; // Hebrew, Arabic, Syriac, Thaana, NKo… + presentation forms
const LETTER = /\p{L}/u;

/** 'rtl' | 'ltr' | null (no words: let it inherit). */
export function textDir(text) {
  const words = String(text || '')
    .replace(/```[\s\S]*?(```|$)|`[^`\n]*`/g, ' ') // code
    .replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/https?:\/\/\S+|\]\([^)]*\)/g, ' ') // URLs, markdown link targets
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .split(/[\s\p{P}\p{S}]+/u).filter(w => LETTER.test(w));
  if (!words.length) return null;
  const rtl = words.filter(w => RTL.test(w)).length;
  return rtl / words.length >= 0.4 ? 'rtl' : 'ltr';
}

/** ` dir="…"` for an HTML block (auto when there are no words to go on). */
export const dirAttr = text => ` dir="${textDir(text) || 'auto'}"`;
