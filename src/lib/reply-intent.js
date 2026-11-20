// Did this chat message say a reminder is done, or ask to stop the reminding? (decision #190) Plain code, many languages:
// English, French, Arabic (standard and Maghrebi, in Arabic letters or Latin "arabizi"). It is the fallback of the Jev
// question "does this message confirm reminder X?" and is deliberately careful: a missed "done" costs one more gentle
// nudge, a wrong "done" can cost a missed pill. So:
//   - a question, or a negation ("not yet", "pas encore", "مازلت", "ما خذيتهاش"), is never a confirmation;
//   - a bare "done" / "خلاص" counts only as the direct answer to the nudge (the first message after it), and only when short;
//   - a message that names the thing ("took my pills", "شربت الدواء") counts wherever it comes after the nudge;
//   - "stop reminding me" (any language) stops the nudges; a bare "stop" / "يزي" only as the direct answer.

import { normalize } from './word-match.js';

export { normalize };

const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrases = list => new RegExp(`${B}(?:${list.map(p => esc(normalize(p))).sort((a, b) => b.length - a.length).join('|')})${E}`, 'u');

// "It's done" on its own (the direct answer to a nudge).
const DONE = phrases([
  'done', 'all done', 'done it', 'did it', 'i did', 'i did it', 'yes i did', 'yes done', 'ok done', 'okay done', 'its done', 'it\'s done',
  'it is done', 'finished', 'completed', 'taken', 'took them', 'took it', 'sorted', 'handled', 'already did', 'already done', 'yep done',
  'fait', 'c\'est fait', 'c fait', 'cest fait', 'fini', 'c\'est fini', 'termine', 'j\'ai pris', 'je l\'ai pris', 'je les ai pris', 'deja fait', 'effectue',
  'تم', 'تمت', 'خلاص', 'خلصت', 'كملت', 'انتهيت', 'انهيت', 'عملتها', 'عملته', 'عملتو', 'عملت', 'درتها', 'درت', 'فعلت', 'اخذتها', 'اخذته', 'اخذت',
  'شربتها', 'شربته', 'شربت', 'هزيتها', 'هزيت', 'صار', 'صارت', 'تمام تم',
  'khlas', '5las', 'khalas', 'kammalt', 'kamalt', 'kmalt', '3malt', '3maltha', '3maltou', 'saye', 'sayé', 'chrebt', 'chrebtha', 'hazit', 'hazitha', 'derthom',
  '✅', '✔', '☑',
]);
const DONE_ALL = new RegExp(DONE.source, 'gu');
// Words that may sit around a bare "done" without making it about something else ("ok done, thanks").
const FILLER = new Set(['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'thanks', 'thank', 'you', 'all', 'just', 'now', 'already', 'finally', 'jess',
  'it', 'please', 'oui', 'merci', 'bon', 'voila', 'svp', 'stp', 'نعم', 'اي', 'ايه', 'شكرا', 'مرسي', 'يعيشك', 'تمام', 'باهي', 'behi', 'yaatik',
  'saha', 'aya']);
// Verbs that confirm only together with the thing ("took my pills", "called the dentist", "put the bins out").
const DONE_VERBS = phrases([
  'took', 'taken', 'called', 'paid', 'fed', 'sent', 'bought', 'put out', 'took out', 'put', 'cleaned', 'watered', 'finished', 'did',
  'done', 'completed', 'booked', 'picked up', 'emptied', 'walked', 'gave',
  'pris', 'appele', 'paye', 'envoye', 'achete', 'sorti', 'nourri', 'arrose', 'fait', 'fini', 'donne',
  'اخذت', 'شربت', 'عملت', 'كلمت', 'اتصلت', 'دفعت', 'خلصت', 'بعثت', 'شريت', 'هزيت', 'خرجت', 'عطيت', 'نظفت', 'درت',
  'chrebt', 'kallamt', 'khallast', 'b3atht', 'chrit', 'hazit', '3malt', '3tit',
]);
// "Stop reminding me" — explicit about the reminding, so it counts wherever it comes after the nudge.
const STOP = phrases([
  'stop reminding', 'stop the reminder', 'stop the reminders', 'stop reminders', 'stop these reminders', 'stop nagging', 'quit reminding',
  'don\'t remind', 'dont remind', 'do not remind', 'no more reminders', 'enough reminders', 'cancel the reminder', 'cancel this reminder',
  'arrete de me rappeler', 'arrete les rappels', 'plus de rappel', 'plus de rappels', 'ne me rappelle plus',
  'توقف عن تذكيري', 'لا تذكرني', 'ما تذكرنيش', 'ما تفكرنيش', 'بطل تفكرني', 'بطل تذكرني', 'كفى تذكير', 'يزي من التذكير', 'يزي ما تفكرني',
  'ma tfakarnich', 'matfakarnich', 'maadech tfakarni', 'yezzi mel tfakir',
]);
// A bare "stop" / "enough" (only as the direct answer to a nudge).
const STOP_BARE = phrases(['stop', 'enough', 'basta', 'arrete', 'ca suffit', 'يزي', 'بركا', 'كفى', 'yezzi', 'barka']);
const STOP_BARE_ALL = new RegExp(STOP_BARE.source, 'gu');
// Not done (yet): English contractions, French, Arabic (standard, Maghrebi), arabizi.
const NEGATION = phrases([
  'not', 'no', 'nope', 'never', 'later', 'yet', 'soon', 'tomorrow', 'in a minute', 'in a bit', 'will', 'gonna', 'going to', 'about to', 'forgot',
  'pas', 'pas encore', 'plus tard', 'bientot', 'demain', 'jamais', 'oublie',
  'لا', 'لم', 'لن', 'ما', 'مش', 'موش', 'مازلت', 'مزال', 'مازال', 'مازالت', 'بعد', 'غدوه', 'بكره', 'سوف', 'نسيت',
  'mazelt', 'mezel', 'mazal', 'ba3d', 'moch', 'mouch', 'mech', 'ghodwa', 'nsit',
]);
const CONTRACTED_NOT = /\p{L}n't(?![\p{L}\p{N}])/u;          // didn't, haven't, won't
const MAGHREBI_NOT = /(?<![\p{L}\p{N}])ما\p{L}{2,}ش(?![\p{L}\p{N}])/u; // ماخذيتهاش, ماعملتش

const STOPWORDS = new Set(['the', 'your', 'you', 'my', 'and', 'for', 'with', 'from', 'this', 'that', 'them', 'take', 'call', 'get',
  'les', 'des', 'une', 'ton', 'ta', 'tes', 'mon', 'ma', 'mes', 'pour', 'avec', 'prendre', 'من', 'في', 'على', 'الى', 'مع', 'عن', 'هذا', 'هذه']);
// Content words, with Arabic clitics (و ب ل ال …) peeled so "الدواء", "دواء" and "بالدواء" meet.
const peel = w => w.replace(/^(?:وال|بال|لل|فال|كال|ال|و)(?=\p{L}{3,})/u, '');
const words = text => (normalize(text).match(/[\p{L}\p{N}]+/gu) || []).map(peel).filter(w => w.length >= 3 && !STOPWORDS.has(w));
const sameWord = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) && b.startsWith(a.slice(0, 4))));

/** Does the message name the reminder's thing? ("pills" ~ "pill", "الدواء" ~ "دواء"). */
export function namesThing(text, label) {
  const mine = words(label);
  return !!mine.length && words(text).some(w => mine.some(m => sameWord(w, m)));
}

/**
 * → { intent: 'done' | 'stop' | null, specific }. specific: the message named the thing or the reminding itself, so it
 * counts anywhere after the nudge; otherwise only as the direct (first) answer to it (`direct`).
 */
export function readReply(text, label = '', { direct = false } = {}) {
  const t = normalize(text);
  if (!t) return { intent: null, specific: false };
  const stop = STOP.exec(t);
  const rest = stop ? `${t.slice(0, stop.index)} ${t.slice(stop.index + stop[0].length)}` : t; // "stop reminding me, i did it"
  const question = /[?؟]\s*$/.test(t);
  const negated = NEGATION.test(rest) || CONTRACTED_NOT.test(rest) || MAGHREBI_NOT.test(rest);
  if (!question && !negated) {
    const named = namesThing(rest, label);
    if (named && (DONE.test(rest) || DONE_VERBS.test(rest))) return { intent: 'done', specific: true };
    // Bare: nothing but the "done" and a few fillers ("ok done, thanks"); "I finished the report" is about something else.
    const leftover = (rest.replace(DONE_ALL, ' ').match(/[\p{L}\p{N}]+/gu) || []).filter(w => !FILLER.has(w) && w.length > 1);
    if (direct && !leftover.length && DONE.test(rest)) return { intent: 'done', specific: false };
  }
  if (stop) return { intent: 'stop', specific: true };
  if (direct && !question && STOP_BARE.test(t) && !(t.replace(STOP_BARE_ALL, ' ').match(/[\p{L}\p{N}]+/gu) || []).some(w => !FILLER.has(w) && w.length > 1)) {
    return { intent: 'stop', specific: false }; // "stop" / "enough please", not "stop the car"
  }
  return { intent: null, specific: false };
}
