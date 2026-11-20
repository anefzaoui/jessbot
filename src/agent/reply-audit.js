// Before a final reply counts (Phase 19 part B, decisions #176 and #177): plain code reads what the reply SAYS and holds
// it against what the task DID. Two checks, both pure (no I/O; the loop gathers the inputs and asks the decision model
// about what's left):
//   - the reply audit: "done" claims ("I've set the reminder") with no successful call of that kind in this task (or an
//     earlier attempt of the same message, #114), capability denials ("I can't browse") while that toolset is on, and
//     promises ("I'll let you know") with nothing scheduled;
//   - the figure check: money, percentages, clock times, dates and flight/train numbers in the reply, normalised and
//     matched against what the task read (full tool results), simple sums allowed. Only what no evidence supports is left.
// English, French and Arabic patterns; a reply in a non-Latin script also gets a decision-model check (the caller).

// ---- The reply audit ----------------------------------------------------------------------------------------------
// Tool families a claim can be about. `words`: what a sentence names when it's about that family (EN/FR/AR).
export const FAMILIES = {
  schedule: { label: 'the reminder or scheduled task', tools: ['set_reminder', 'set_alarm', 'set_timer', 'schedule_task', 'cancel_alarm', 'cancel_schedule'],
    words: /\b(?:remind\w*|alarms?|timers?|schedul\w*|recurring|rappels?|alarmes?|minuteurs?|programm\w*|planifi\w*)\b|تذكير|منبه|منبّه|مؤقت|جدول/iu },
  calendar: { label: 'the calendar change', tools: ['calendar_create_event', 'calendar_update_event'],
    words: /\b(?:calendar|events?|meetings?|appointments?|invit\w*|agenda|calendrier|rendez-vous|réunion)\b|التقويم|موعد|اجتماع/iu },
  lists: { label: 'the list change', tools: ['list_create', 'list_add', 'list_check', 'list_remove'], words: /\b(?:lists?|listes?)\b|قائمة/iu },
  email: { label: 'sending the email', tools: ['email_send'], words: /\b(?:e-?mails?|mail|inbox|courriels?)\b|البريد|الإيميل|الايميل|ايميل|إيميل/iu },
  memory: { label: 'saving it to memory', tools: ['remember'], words: /\b(?:memory|remember\w*|mémoire|retenu)\b|ذاكرت|الذاكرة/iu },
  goals: { label: 'the goal change', tools: ['goal_suggest', 'goal_progress'], words: /\b(?:goals?|objectifs?)\b|هدف|الهدف/iu },
  library: { label: 'saving the document', tools: ['library_create', 'library_update', 'library_edit', 'library_append', 'library_describe', 'library_export',
    'sheet_append_rows', 'sheet_set_cells', 'make_word_document', 'make_spreadsheet', 'make_presentation', 'make_pdf', 'docx_fill', 'pdf_fill_form',
    'pdf_write_text', 'pdf_merge', 'make_calendar_file', 'project_save', 'project_update', 'project_note', 'make_image', 'make_audio'],
  words: /\b(?:documents?|docs?|pages?|files?|library|spreadsheets?|sheets?|presentations?|slides|pdfs?|notes?|reports?|itinerary|fichiers?|bibliothèque|projects?)\b|ملف|مستند|صفحة|المكتبة/iu },
  booking: { label: 'the booking or order', tools: ['browser_click', 'browser_press', 'browser_autopilot', 'browser_upload', 'email_send', 'calendar_create_event'], words: null },
};
const ORDER = ['schedule', 'calendar', 'lists', 'email', 'memory', 'goals', 'library'];
// (JavaScript's \b only knows ASCII letters: words ending in an accent end with (?!\p{L}) instead.)
const BOOKING = /\b(?:booked|reserved|ordered|purchased|paid|réservée?s?|commandée?s?|payée?s?)(?!\p{L})|حجزت|طلبت|دفعت/iu;
const SENDING = /\b(?:sent|forwarded|emailed|replied|envoyée?s?|transférée?s?)(?!\p{L})|أرسلت|ارسلت/iu;

// "I've saved", "I just sent", "is booked", "has been scheduled" (EN); "j'ai envoyé", "c'est réservé" (FR); "أرسلتُ" (AR).
const PAST = 'saved|sent|added|booked|scheduled|created|cancell?ed|updated|made|wrote|written|noted|stored|reserved|ordered|purchased|paid|submitted|'
  + 'forwarded|removed|deleted|ticked|marked|logged|moved|emailed|replied';
const EN_CLAIM = new RegExp(String.raw`\bi(?:['’]ve|\s+have)?\s+(?:now\s+|just\s+|also\s+|already\s+|successfully\s+|gone\s+ahead\s+and\s+)*(?:${PAST})\b`
  + String.raw`|\bi(?:['’]ve|\s+have|\s+just)\s+(?:now\s+|also\s+|already\s+)*(?:set|put)\b`
  + String.raw`|\b(?:it|this|that|everything|they|(?:your|the)\s+[\p{L}-]+(?:\s+[\p{L}-]+)?)\s+(?:is|are|has\s+been|have\s+been|was|were|['’]s|['’]re)\s+(?:now\s+|all\s+|been\s+|successfully\s+)*(?:set|${PAST})\b`, 'iu');
const FR_CLAIM = /\b(?:j['’]ai|je\s+(?:les|l['’]|vous|t['’]|lui)\s*ai|c['’]est|(?:il|elle|ils|elles|le\s+\p{L}+|la\s+\p{L}+|votre\s+\p{L}+|ton\s+\p{L}+|ta\s+\p{L}+)\s+(?:est|a\s+été|sont|ont\s+été))\s+(?:bien\s+|déjà\s+|maintenant\s+)*(?:envoyé|enregistré|sauvegardé|ajouté|programmé|créé|réservé|annulé|mis\s+à\s+jour|noté|défini|réglé|planifié|supprimé|retenu|commandé|payé)e?s?(?!\p{L})/iu;
const AR_CLAIM = /(?:^|[\s،,.:])(?:لقد\s+|قد\s+)?(?:أرسلت|ارسلت|حفظت|أضفت|اضفت|ضبطت|جدولت|أنشأت|انشأت|حجزت|ألغيت|الغيت|حدثت|حدّثت|سجلت|سجّلت|عينت|عيّنت|دونت|دوّنت)(?:ه|ها|هم|ُ)?(?=[\s،,.:!]|$)/u;
const FUTURE_MEMORY = /\bi(?:['’]ll|\s+will)\s+(?:remember|keep\s+(?:that|this|it)\s+in\s+mind|make\s+a\s+note)\b|\bje\s+(?:m['’]en\s+souviendrai|retiendrai)\b|سأتذكر|سأحفظ/iu;
// A promise is only undone by a real negation ("I'll let you know WHEN it drops" is still a promise).
const NOT = /\b(?:not|never|can['’]t|cannot|won['’]t|unable)\b|\bne\s|\bn['’]|(?:^|\s)(?:لن|لا)\s/iu;
const NEGATION = /\b(?:not|never|couldn['’]t|can['’]t|cannot|unable|haven['’]t|hasn['’]t|wasn['’]t|weren['’]t|didn['’]t|won['’]t|yet\s+to|failed|if|once|when|ne|n['’]|pas|jamais|si)\b|(?:^|\s)(?:لم|لا|لن|ما|إذا|اذا|عندما)\s/iu;

// "I can't browse the web" while web is on (EN/FR/AR). Objects map to toolsets.
const EN_DENY = /\b(?:i\s+(?:can(?:not|['’]t)|am\s+(?:not\s+able|unable)|do(?:n['’]t|\s+not)\s+have\s+(?:access|the\s+ability|a\s+way|any\s+way|tools?)|have\s+no\s+(?:access|way))|i['’]m\s+(?:not\s+able|unable)|as\s+an\s+ai)\b/iu;
const FR_DENY = /\bje\s+ne\s+(?:peux|suis)\s+pas\b|\bje\s+n['’]ai\s+pas\s+(?:accès|la\s+possibilité)\b|\bimpossible\s+pour\s+moi\b/iu;
const AR_DENY = /لا\s+(?:أستطيع|استطيع|يمكنني|أقدر|اقدر)|ليس\s+(?:لدي|لديّ|بإمكاني)|لا\s+أملك/u;
const DENY_OBJECTS = {
  web: /\b(?:brows\w*|search\w*|look\s+(?:it|that|this|things|them)\s+up|internet|web\s*sites?|web\s*pages?|the\s+web|online|links?|urls?|real-time|live\s+(?:data|information|prices)|current\s+(?:prices|information|data|news)|naviguer|recherch\w*|en\s+ligne|sites?\s+web)\b|الإنترنت|الانترنت|تصفح|البحث|المواقع/iu,
  email: /\b(?:e-?mails?|inbox|mail|courriels?|boîte)\b|بريد|الإيميل|الايميل/iu,
  calendar: /\b(?:calendar|agenda|calendrier)\b|التقويم/iu,
  schedule: /\b(?:remind\w*|reminders?|alarms?|timers?|schedul\w*|rappel\w*)\b|تذكير|منبه/iu,
  memory: /\b(?:remember|memor(?:y|ies)|recall|souvenir|mémoire)\b|أتذكر|ذاكرة/iu,
};

// "I'll let you know / keep an eye / follow up / remind you" with nothing scheduled (EN/FR/AR).
const PROMISE = /\b(?:i['’]ll|i\s+will|i['’]m\s+going\s+to|i\s+am\s+going\s+to|i\s+shall)\s+(?:be\s+sure\s+to\s+|make\s+sure\s+to\s+|definitely\s+|also\s+)?(?:let\s+you\s+know|keep\s+(?:an\s+eye|you\s+(?:posted|updated|informed))|follow\s+up|check\s+(?:back|again|in)|remind\s+you|get\s+back\s+to\s+you|update\s+you|watch|monitor|track|ping\s+you|notify\s+you|tell\s+you\s+(?:when|if|as\s+soon))\b|\bje\s+(?:vous|te)\s+(?:tiendrai\s+au\s+courant|préviendrai|rappellerai|recontacterai|dirai\s+(?:quand|si|dès))\b|\bje\s+vais\s+(?:surveiller|suivre|vous\s+rappeler|te\s+rappeler|revenir\s+vers)\b|\bje\s+reviendrai\s+vers\b|سأخبرك|سأبلغك|سأتابع|سأذكرك|سأذكّرك|سأبقيك\s+على\s+اطلاع|سأراقب|سأعود\s+إليك/iu;
// delegate backs "I'll let you know when it's done": its background task posts back by itself when it finishes (#197).
export const PROMISE_TOOLS = ['set_reminder', 'set_alarm', 'set_timer', 'schedule_task', 'delegate'];

// What the reply says in its own voice: code, quotes (a draft for them) and block quotes aren't claims.
function ownWords(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/[“"«][^”"»]{30,}[”"»]/g, ' ');
}
const sentencesOf = text => ownWords(text).split(/(?<=[.!?؟…])\s+|\n+/u).map(s => s.trim()).filter(Boolean);
const clip = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Latin letters are under half of the letters: the patterns may miss it, so the caller asks the decision model too. */
export function nonLatin(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (letters.length < 8) return false;
  return (String(text).match(/\p{Script=Latin}/gu) || []).length / letters.length < 0.5;
}

/** Which family a claim sentence is about (null: none we can check). */
export function familyOf(sentence) {
  if (BOOKING.test(sentence)) return FAMILIES.calendar.words.test(sentence) ? 'calendar' : 'booking';
  for (const f of ORDER) {
    if (f === 'email' && !SENDING.test(sentence) && !FAMILIES.email.words.test(sentence)) continue;
    if (FAMILIES[f].words.test(sentence)) return f;
  }
  return null;
}

/**
 * The reply audit in code. succeeded: Set of tool names with a successful call in this task (and its earlier attempts);
 * toolsets: Set of the person's enabled toolsets. → { claims: [{ family, label, sentence }], denials: [{ toolset, sentence }],
 * promises: [{ sentence }], nonLatin }. Each list holds only what the task doesn't back up.
 */
export function auditReply(text, { succeeded = new Set(), toolsets = new Set() } = {}) {
  const claims = [], denials = [], promises = [];
  const did = family => FAMILIES[family].tools.some(t => succeeded.has(t));
  for (const s of sentencesOf(text)) {
    if (/[?؟]\s*$/.test(s)) continue;
    if (FUTURE_MEMORY.test(s) && !did('memory')) { claims.push({ family: 'memory', label: FAMILIES.memory.label, sentence: clip(s) }); continue; }
    if ((EN_CLAIM.test(s) || FR_CLAIM.test(s) || AR_CLAIM.test(s)) && !NEGATION.test(s)) {
      const family = familyOf(s);
      if (family && !did(family)) claims.push({ family, label: FAMILIES[family].label, sentence: clip(s) });
      if (family) continue;
    }
    if (EN_DENY.test(s) || FR_DENY.test(s) || AR_DENY.test(s)) {
      const toolset = Object.keys(DENY_OBJECTS).find(k => DENY_OBJECTS[k].test(s));
      if (toolset && toolsets.has(toolset)) { denials.push({ toolset, sentence: clip(s) }); continue; }
    }
    if (PROMISE.test(s) && !NOT.test(s) && !PROMISE_TOOLS.some(t => succeeded.has(t))) promises.push({ sentence: clip(s) });
  }
  return { claims, denials, promises, nonLatin: nonLatin(text) };
}

/** Anything the audit found (code side). */
export const auditHits = a => a.claims.length + a.denials.length + a.promises.length;

/** A denial of something that exists nowhere in the person's tools ("I can't order food"): a candidate for the wish log
 *  when the decision model is off. Returns the sentence or null. */
export function unmetAsk(text, toolsets = new Set()) {
  for (const s of sentencesOf(text)) {
    if (!(EN_DENY.test(s) || FR_DENY.test(s) || AR_DENY.test(s))) continue;
    const toolset = Object.keys(DENY_OBJECTS).find(k => DENY_OBJECTS[k].test(s));
    if (!toolset || !toolsets.has(toolset)) return clip(s, 240);
  }
  return null;
}

// ---- The figure check ---------------------------------------------------------------------------------------------
const MONTHS = {
  jan: 1, january: 1, janvier: 1, janv: 1, enero: 1, januar: 1, feb: 2, february: 2, février: 2, fevrier: 2, févr: 2, febrero: 2, februar: 2,
  mar: 3, march: 3, mars: 3, marzo: 3, märz: 3, apr: 4, april: 4, avril: 4, avr: 4, abril: 4, may: 5, mai: 5, mayo: 5,
  jun: 6, june: 6, juin: 6, junio: 6, juni: 6, jul: 7, july: 7, juillet: 7, juil: 7, julio: 7, juli: 7, aug: 8, august: 8, août: 8, aout: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9, oct: 10, october: 10, octobre: 10, octubre: 10, oktober: 10,
  nov: 11, november: 11, novembre: 11, noviembre: 11, dec: 12, december: 12, décembre: 12, decembre: 12, déc: 12, diciembre: 12, dezember: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const CURRENCY = String.raw`[$€£¥₹₺]|\b(?:USD|EUR|GBP|TND|AED|CHF|MAD|SAR|QAR|EGP|CAD|AUD|JPY|DT|DH|dinars?|dollars?|euros?|pounds?|francs?)\b|د\.ت|درهم|ريال|دينار|دولار|يورو`;
const NUM = String.raw`\d{1,3}(?:[,.   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const SUFFIX = String.raw`(?:\s?(?:k|K|m|M|bn|million|billion|thousand|mille|millions?))?`;
const MONEY_RE = new RegExp(String.raw`(?:(?:${CURRENCY})\s?(${NUM})(${SUFFIX}))|(?:(${NUM})(${SUFFIX})\s?(?:${CURRENCY}))`, 'giu');
const PERCENT_RE = new RegExp(String.raw`(${NUM})\s?(?:%|percent\b|per\s?cent\b|pour\s?cent\b|بالمئة|بالمائة)`, 'giu');
const TIME_RE = /\b([01]?\d|2[0-3])[:h]([0-5]\d)(?:\s?([ap])\.?m\.?)?(?![\d:])|\b(1[0-2]|0?[1-9])\s?([ap])\.?m\.?\b/giu;
const DATE_RES = [
  /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, // ISO → y m d
  new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th|er)?\s+(?:of\s+)?(${MONTH_RE})\.?(?:\s+(\d{4}))?\b`, 'giu'), // 3 October (2026)
  new RegExp(String.raw`\b(${MONTH_RE})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, 'giu'), // October 3(, 2026)
  /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/g, // 03/10/2026 (either order)
];
const CODE_RE = /\b(?:(ICE|TGV|IC|EC|RJ|TER|AVE|Eurostar|Frecciarossa|Thalys)\s?(\d{2,5})|([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?-?(\d{2,4}))\b/gu;
const TRAVEL_WORDS = /\b(?:flights?|vols?|airlines?|depart\w*|arriv\w*|boarding|trains?|gate|terminal|seat)\b|رحلة|طيران/iu;

/** A written number → its possible values (a lone "1.200" may be 1200 or 1.2). */
export function numberValues(raw, suffix = '') {
  let s = String(raw).replace(/[   ]/g, ' ').trim();
  const out = new Set();
  const groups = s.split(/[,. ]/);
  const seps = s.match(/[,. ]/g) || [];
  if (!seps.length) out.add(Number(s));
  else if (seps.length === 1) {
    const [a, b] = groups;
    // "1,200" is twelve hundred; "1.200" may be either (European thousands, or a decimal); "1,5" and "12.5" are decimals.
    if (b.length === 3) { out.add(Number(a + b)); if (seps[0] === '.') out.add(Number(`${a}.${b}`)); } else if (seps[0] !== ' ') out.add(Number(`${a}.${b}`));
  } else {
    const last = seps.at(-1), rest = seps.slice(0, -1);
    const lastGroup = groups.at(-1);
    if (rest.every(x => x !== last) && lastGroup.length !== 3) out.add(Number(`${groups.slice(0, -1).join('')}.${lastGroup}`)); // 1.200,50 / 1,200.50
    else out.add(Number(groups.join(''))); // 1,200,000 / 1 200 000
  }
  const mult = /^\s?(?:k|thousand|mille)$/i.test(suffix) ? 1e3 : /^\s?(?:m|million|millions)$/i.test(suffix) ? 1e6 : /^\s?(?:bn|billion)$/i.test(suffix) ? 1e9 : 1;
  return [...out].filter(Number.isFinite).map(v => v * mult);
}
// How exact the reply's number is: "1.2k" is to the hundred, "about 1,200" to the hundred, "1,199.99" to the cent.
function stepOf(raw, suffix, sentence) {
  const s = String(raw);
  const dec = /[.,](\d{1,2})$/.exec(s)?.[1]?.length || 0;
  const mult = /^\s?(?:k|thousand|mille)$/i.test(suffix) ? 1e3 : /^\s?(?:m|million|millions)$/i.test(suffix) ? 1e6 : 1;
  let step = mult > 1 ? mult / 10 ** dec : 10 ** -dec;
  if (mult === 1 && !dec && /\b(?:about|around|roughly|approx\w*|~|≈|nearly|almost|environ|vers|près\s+de)\b|[~≈]|حوالي|تقريبا/iu.test(sentence)) {
    const zeros = /0+$/.exec(s.replace(/\D/g, ''))?.[0].length || 0;
    step = 10 ** Math.min(zeros, 3);
  }
  return step;
}
const hhmm = (h, m, ap) => {
  let hour = Number(h);
  if (ap) { const pm = /p/i.test(ap); if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0; }
  return `${String(hour).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
};
const md = (m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

function datesIn(text) {
  const found = [];
  for (const [i, re] of DATE_RES.entries()) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) {
      const keys = i === 0 ? [md(+m[2], +m[3])] : i === 1 ? [md(MONTHS[m[2].toLowerCase()], +m[1])] : i === 2 ? [md(MONTHS[m[1].toLowerCase()], +m[2])]
        : [md(+m[2], +m[1]), md(+m[1], +m[2])];
      const k = keys.filter(Boolean);
      if (k.length) found.push({ raw: m[0], keys: k, index: m.index });
    }
  }
  return found;
}

// The sentence around a position (for context: "about", travel words, the decision model's question).
function sentenceAround(t, i) {
  const before = t.slice(0, i);
  const stop = before.search(/[.!?]\s[^.!?]*$/);
  const start = Math.max(before.lastIndexOf('\n'), stop >= 0 ? stop + 1 : -1) + 1;
  const m = /[.!?](?:\s|$)|\n/.exec(t.slice(i));
  return t.slice(start, m ? i + m.index + 1 : t.length).trim();
}

/** Every figure in a text: [{ kind: money|percent|time|date|code, raw, values?, step?, keys?, index }]. reply: work out how
 *  exact each number is ("about 1,200", "1.2k") and keep flight-like codes only in travel sentences. */
export function figuresIn(text, { reply = false } = {}) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(MONEY_RE)) {
    const raw = m[1] || m[3], suffix = m[2] || m[4] || '';
    out.push({ kind: 'money', raw: m[0].trim(), values: numberValues(raw, suffix), step: reply ? stepOf(raw, suffix, sentenceAround(t, m.index)) : 0, index: m.index });
  }
  for (const m of t.matchAll(PERCENT_RE)) out.push({ kind: 'percent', raw: m[0].trim(), values: numberValues(m[1]), step: reply ? stepOf(m[1], '', sentenceAround(t, m.index)) : 0, index: m.index });
  for (const m of t.matchAll(TIME_RE)) out.push({ kind: 'time', raw: m[0].trim(), keys: [m[1] != null ? hhmm(m[1], m[2], m[3]) : hhmm(m[4], 0, m[5])], index: m.index });
  for (const d of datesIn(t)) out.push({ kind: 'date', ...d });
  for (const m of t.matchAll(CODE_RE)) {
    const code = (m[1] ? m[1] + m[2] : m[3] + m[4]).toUpperCase();
    if (reply && !m[1] && !TRAVEL_WORDS.test(sentenceAround(t, m.index))) continue; // "A4", "UK 2026": only in a travel sentence
    out.push({ kind: 'code', raw: m[0], keys: [code], index: m.index });
  }
  return out;
}

/** The evidence as sets to match against: every number (with its possible values), the amounts written as money (for sums),
 *  times, dates, codes. */
export function evidenceIndex(texts) {
  const numbers = new Set(), money = new Set(), times = new Set(), dates = new Set(), codes = new Set();
  for (const text of texts) {
    const t = String(text || '');
    for (const m of t.matchAll(new RegExp(String.raw`(${NUM})(${SUFFIX})`, 'gu'))) for (const v of numberValues(m[1], m[2])) numbers.add(v);
    for (const f of figuresIn(t)) {
      if (f.kind === 'money') f.values.forEach(v => money.add(v));
      if (f.kind === 'time') f.keys.forEach(k => times.add(k));
      if (f.kind === 'date') f.keys.forEach(k => dates.add(k));
      if (f.kind === 'code') f.keys.forEach(k => codes.add(k));
    }
    // Flight tables write times as 1530, dates as 20261003.
    for (const m of t.matchAll(/\b([01]\d|2[0-3])([0-5]\d)\b/g)) times.add(`${m[1]}:${m[2]}`);
  }
  return { numbers: [...numbers], money: [...money].filter(v => v > 0), times, dates, codes };
}

const near = (v, e, step) => Math.abs(v - e) <= Math.max(step / 2, Math.abs(v) * 1e-9) + 1e-9;
// A figure supported by the evidence as written (any number there), or as a simple sum of amounts written as money there
// (two or three of them, or one 2–9 times: a price for the whole party). Sums use money only: a page's many small numbers
// would add up to almost anything.
function supported(f, idx) {
  if (f.kind === 'time') return f.keys.some(k => idx.times.has(k));
  if (f.kind === 'date') return f.keys.some(k => idx.dates.has(k));
  if (f.kind === 'code') return f.keys.some(k => idx.codes.has(k));
  const nums = idx.numbers;
  for (const v of f.values) {
    if (nums.some(e => near(v, e, f.step))) return true;
    if (f.kind !== 'money') continue;
    const money = idx.money.filter(e => e <= v).slice(0, 400);
    for (const e of money) for (let k = 2; k <= 9; k++) if (near(v, e * k, f.step)) return true;
    for (let i = 0; i < money.length; i++) for (let j = i; j < money.length; j++) if (near(v, money[i] + money[j], f.step)) return true;
    const few = money.slice(0, 60);
    for (let i = 0; i < few.length; i++) for (let j = i; j < few.length; j++) for (let k = j; k < few.length; k++) if (near(v, few[i] + few[j] + few[k], f.step)) return true;
  }
  return false;
}

const WORD = /[\p{L}\p{N}]{3,}/gu;
/** The window of the evidence that shares the most words with the reply's sentence (≤ 400 chars), for the decision model. */
// Words that say nothing about which evidence is meant: "the" in a prompt heading outranked a fares page that shared no
// function word with the sentence (seen when "Coming up" got its "(until the end of tomorrow)" heading, #207).
const FUNCTION_WORDS = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'with', 'from', 'this', 'that', 'you', 'your', 'its', 'our',
  'has', 'have', 'had', 'not', 'but', 'into', 'than', 'then', 'les', 'des', 'une', 'est', 'pour', 'avec']);
export function nearestEvidence(sentence, texts, width = 400) {
  const want = new Set((String(sentence).toLowerCase().match(WORD) || []).filter(w => !FUNCTION_WORDS.has(w)));
  let best = { score: -1, text: '' };
  for (const text of texts) {
    const t = String(text || '');
    for (let at = 0; at < t.length; at += width / 2) {
      const win = t.slice(at, at + width);
      const score = (win.toLowerCase().match(WORD) || []).filter(w => want.has(w)).length;
      if (score > best.score) best = { score, text: win };
    }
  }
  return best.text.replace(/\s+/g, ' ').trim();
}

/**
 * Figures in the reply that nothing in the evidence supports: [{ figure, kind, sentence, evidence }] (≤ 8). The evidence is
 * what the task read (full tool results), the person's own messages and the prompt's facts (time, what's coming up).
 */
export function unmatchedFigures(reply, evidence) {
  const figs = figuresIn(ownWords(reply), { reply: true });
  if (!figs.length) return [];
  const idx = evidenceIndex(evidence);
  const text = ownWords(reply);
  const seen = new Set();
  const out = [];
  for (const f of figs) {
    if (supported(f, idx) || seen.has(f.raw)) continue;
    seen.add(f.raw);
    const start = Math.max(text.lastIndexOf('\n', f.index), text.slice(0, f.index).search(/[.!?]\s[^.!?]*$/) + 1, 0);
    const end = (() => { const m = /[.!?](?:\s|$)|\n/.exec(text.slice(f.index)); return m ? f.index + m.index + 1 : text.length; })();
    const sentence = clip(text.slice(start, end), 240);
    out.push({ figure: f.raw, kind: f.kind, sentence, evidence: nearestEvidence(sentence, evidence) });
    if (out.length >= 8) break;
  }
  return out;
}
