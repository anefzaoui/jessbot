// Skill review assistant (Phase 18, decision #121): a plain-code scan of a skill's text, shown to the admin before they
// approve it. Advisory, deterministic, offline: findings never change what a skill can do (tools stay behind the person's
// policy and approvals). The one hard effect: approving a skill with a `bad` finding needs an explicit "approve anyway"
// (services/skills.js). Tuned so the built-in skills produce no `bad` finding (tests/p18d.test.js).
//
// lintSkill({ raw, meta, body, files }, { others, tools }) → [{ level: bad|warn|info, code, line, excerpt, message, file? }]
//   raw: SKILL.md as written (front matter included; line numbers point into it) · meta: the parsed front matter (or null)
//   files: supporting files [{ name, buf }] · others: other ACTIVE skills [{ name, description }] (description collisions)
//   tools: the tool registry (defaults to every registered tool) for capability checks.
import { allTools } from '../agent/tools/registry.js';
import { botName, DEFAULT_NAME } from './bot.js';

const LEVELS = { bad: 0, warn: 1, info: 2 };
export const BODY_WARN = 15_000;
export const DESCRIPTION_WARN = 400;
export const COLLISION = 0.75;
// Supporting files use_skill can open (decision #172): .md/.txt at the top of the folder, up to 20,000 characters. Licence
// and notice files are attribution, not steps: they stay in the checksum and the review but aren't offered to Jess.
export const SUPPORT_TEXT_MAX = 20_000;
export const openableFile = rel => /^[^/\\]+\.(?:md|txt)$/i.test(rel) && rel !== 'SKILL.md' && !/^(?:licen[cs]e|notice|copying|authors)(?:[.-]|$)/i.test(rel);

// ---- Hidden characters ---------------------------------------------------------------------------------------------
// Zero-width, bidi embeddings/overrides/isolates, invisible operators, fillers, the Unicode "tag" block and the
// variation-selector supplement (both can smuggle text past a reader). ZWJ/ZWNJ (U+200C/U+200D) stay allowed: emoji and
// Persian need them; U+FE0F (emoji presentation) too. LRM/RLM/ALM are real in right-to-left text: a warning, not bad.
const HIDDEN_BAD = /[\u{200B}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{206A}-\u{206F}\u{FEFF}\u{AD}\u{180E}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const HIDDEN_MARK = /[\u{200E}\u{200F}\u{61C}]/u;
const HIDDEN_ANY = /[\u{200B}\u{200E}\u{200F}\u{61C}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{206A}-\u{206F}\u{FEFF}\u{AD}\u{180E}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** Text with every hidden character made visible as ⟦U+200B⟧ (for excerpts). */
export const showHidden = s => String(s).replace(HIDDEN_ANY, ch => `⟦U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);

// ---- Phrases -------------------------------------------------------------------------------------------------------
// [level, code, pattern, message]. Case-insensitive unless the pattern says otherwise (MANDATORY is only a shout in caps).
const STEERING = [
  ['bad', 'override', /\bignore\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|other|system)\s+(?:instructions|rules|prompts?|messages|guidelines)/i,
    'Tells Jess to ignore all other instructions.'],
  ['bad', 'override', /\b(?:overrides?|supersedes?|takes?\s+precedence\s+over)\s+(?:all|any|every)\s+(?:other\s+|previous\s+|prior\s+)?(?:instructions|rules|guidelines|prompts?|directives)/i,
    'Claims to override all other instructions.'],
  ['bad', 'override', /\b(?:instructions?|rules?|directives?|this\s+skill|these\s+steps)\b[^.\n]{0,40}\b(?:has|have|take|takes|is|are|gets?|get)\s+(?:the\s+)?(?:highest|top|absolute|maximum)\s+priority|\b(?:highest|top|absolute)[- ]priority\s+(?:instructions?|rules?|directives?|override)/i,
    'Claims the highest priority over Jess’s own rules.'],
  ['bad', 'hide-from-person', /\b(?:do\s+not|don['’]t|never)\s+(?:tell|inform|notify|alert|warn)\s+(?:the\s+)?(?:user|person|owner|human|admin)\b|\b(?:do\s+not|don['’]t|never)\s+let\s+(?:the\s+)?(?:user|person|owner)\s+know\b|\bwithout\s+(?:the\s+)?(?:user|person|owner)\s+(?:knowing|noticing)\b/i,
    'Tells Jess to keep something from the person.'],
  ['bad', 'scanner-bait', /\bfor\s+(?:automated|security|ai)\s+(?:scanners?|reviewers?|auditors?|tools?|checks?)\b|\bfor\s+(?:scanners?|linters?)\s*[:,-]|\bfalse\s+positives?\b[^.\n]{0,40}\bexpected\b/i,
    'Speaks to the review tools instead of to Jess (a way to talk a reviewer out of a warning).'],
  ['warn', 'role-hijack', /\byou\s+(?:are|['’]re)\s+(?:now|no\s+longer)\b|\bnew\s+(?:system\s+)?instructions?\s*:/i, 'Tries to change who Jess is.'],
  ['warn', 'shouting', /\bMANDATORY\b/, 'Uses "MANDATORY": steering language that tries to outrank Jess’s own rules.'],
  ['warn', 'no-exceptions', /\bno\s+exceptions\b/i, 'Says "no exceptions": steering language that tries to outrank Jess’s own rules.'],
  ['warn', 'without-asking', /\bwithout\s+(?:asking|confirmation|confirming|checking\s+with|(?:the\s+)?(?:user|person)['’]?s?\s+(?:permission|consent|approval|ok)|permission|consent|approval)\b/i,
    'Tells Jess to act without asking. Approvals still apply, but this is a red flag in a skill.'],
  ['warn', 'silently', /\bsilently\b/i, 'Tells Jess to do something silently.'],
];

// Secrets Jess never needs from someone in a chat. Skipped when the sentence says not to ("never ask for a password").
const SECRET = String.raw`(?:passwords?|passcodes?|api[ -]?keys?|access[ -]tokens?|secret[ -]keys?|private[ -]keys?|seed[ -]phrases?|recovery[ -]phrases?|mnemonic|(?:credit|debit|bank)?[ -]?card[ -]?(?:numbers?|details)|cvv|cvc|security[ -]codes?|pin[ -](?:codes?|numbers?)|one[- ]time[ -](?:codes?|passwords?)|otp|2fa[ -]codes?|verification[ -]codes?|social[ -]security[ -]numbers?|ssn)\b`;
const SECRET_ASK = new RegExp(String.raw`\b(?:ask|asks|asking|prompt)\s+(?:(?:the\s+)?(?:user|person|people|owner|admin|them|him|her)\s+)?for\s+(?:(?:their|your|his|her|the|a|any)\s+)?(?:\w+\s+){0,2}?${SECRET}`
  + String.raw`|\b(?:collect|obtain|harvest|gather)\s+(?:(?:their|your|his|her|the|all)\s+)?(?:\w+\s+){0,2}?${SECRET}|\b(?:send|share|paste|give|provide|tell|forward|email)\s+(?:(?:me|us|jess|it)\s+)?(?:your|their|his|her)\s+(?:\w+\s+){0,2}?${SECRET}`, 'i');
const NEGATED = /\b(?:never|not|don['’]t|no|without)\b[^.\n]{0,30}$/i;

const PERSIST = [
  ['bad', 'self-modify', /\b(?:edit|write|append|update|modify|change|overwrite|rewrite|add\s+(?:this|it|these|a\s+line|lines?)\s+to|save\s+(?:this|it)\s+(?:in|to))\b[^.\n]{0,50}\b(?:SOUL|AGENTS|MEMORY|USER|IDENTITY|HEARTBEAT|TOOLS)\.md\b|\b(?:SOUL|AGENTS|MEMORY|USER|IDENTITY|HEARTBEAT|TOOLS)\.md\b[^.\n]{0,30}\b(?:edit|append|overwrite|rewrite|modify)/i,
    'Tells Jess to edit Jess’s own instruction or memory files.'],
  ['bad', 'self-modify', /\b(?:edit|update|modify|change|rewrite|replace)\s+(?:your|jess['’]s)\s+(?:own\s+)?(?:system\s+prompt|instructions|personality|soul|rules)\b/i,
    'Tells Jess to change Jess’s own instructions.'],
  ['warn', 'persistence', /\bfrom\s+now\s+on\b|\b(?:remember|save|store|keep)\s+(?:this|these)\s+(?:rules?|instructions?|skill)\b[^.\n]{0,30}\b(?:memory|forever|permanently|future)/i,
    'Tries to make itself stick beyond the task it is for ("from now on").'],
  ['info', 'recurring', /\b(?:set\s+up|create|schedule|add|make)\s+(?:a\s+|an\s+)?(?:recurring|repeating|daily|weekly|hourly|nightly|cron)\b|\bcron\s+(?:job|expression)\b/i,
    'Sets up something that repeats. Check that is what this skill is for.'],
];

// Shell and installs: Jess can't run code, so a command in a skill is at best an example and at worst a trap.
const COMMANDS = [
  ['pipe-to-shell', /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:ba)?sh\s+<\(\s*(?:curl|wget)|\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b|\biex\s*\(\s*(?:new-object\s+net\.webclient|irm|iwr|invoke-restmethod)|base64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:ba)?sh\b|\bpowershell(?:\.exe)?\s+[^\n]*-(?:enc|encodedcommand)\b/i,
    'Downloads and runs code (a pipe into a shell).'],
  ['install-command', /\bnpx\s+(?:-y|--yes)\b|\bpip[3x]?\s+install\b|\bnpm\s+(?:i|install)\s+(?:-g|--global)\b|\b(?:brew|apt|apt-get|yum|dnf|choco|winget|cargo|gem)\s+install\b|\bclawhub\s+install\b|\bopenclaw\s+install\b/i,
    'Installs software at run time.'],
];
const SHELL_LANGS = /^(?:sh|bash|zsh|shell|console|powershell|ps1?|pwsh|cmd|bat|python|py|js|javascript|node|ts|typescript|ruby|rb|perl|php|go|rust)$/i;

// ---- Links ---------------------------------------------------------------------------------------------------------
// Hosts that exist to receive data (request catchers, tunnels, out-of-band callbacks) or to host throwaway text.
const EXFIL_HOSTS = [/(?:^|\.)webhook\.site$/, /(?:^|\.)requestbin\.[a-z.]+$/, /(?:^|\.)pipedream\.(?:net|com)$/, /(?:^|\.)ngrok(?:-free)?\.(?:io|app|dev)$/,
  /(?:^|\.)interact\.sh$/, /(?:^|\.)interactsh\.com$/, /(?:^|\.)oast\.[a-z]+$/, /(?:^|\.)oastify\.com$/, /(?:^|\.)burpcollaborator\.net$/, /(?:^|\.)pastebin\.com$/,
  /(?:^|\.)transfer\.sh$/, /(?:^|\.)beeceptor\.com$/, /(?:^|\.)hookbin\.com$/, /(?:^|\.)requestcatcher\.com$/, /(?:^|\.)paste\.ee$/, /(?:^|\.)termbin\.com$/,
  /(?:^|\.)0x0\.st$/, /(?:^|\.)canarytokens\.(?:com|org)$/];
const EXFIL_PATHS = [[/(?:^|\.)discord(?:app)?\.com$/, /^\/api\/webhooks\//], [/(?:^|\.)api\.telegram\.org$/, /^\/bot/], [/(?:^|\.)hooks\.slack\.com$/, /^\//]];
const SHORTENERS = /(?:^|\.)(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|amzn\.to|rebrand\.ly|is\.gd|cutt\.ly|shorturl\.at|ow\.ly|buff\.ly|tiny\.cc)$/;
const TRACKING = /^(?:utm_[a-z]+|ref|ref_|tag|aff|aff_id|affid|affiliate|affiliate_id|clickid|click_id|gclid|fbclid|msclkid|irclickid|subid|sub_id|mc_cid|mc_eid|partner|partner_id|campaign_id|linkcode|ascsubtag)$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const BARE_HOST = /(?<![@\w./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|dev|app|site|xyz|sh|me|co|info|biz|ru|cn|tk|top|ly|to|st|gg|link|click|live|pro|fun|online)\b(?![\w-]|\.[a-z])/gi;
const REMOTE_INSTRUCTIONS = /\b(?:fetch|download|load|pull|curl|wget|retrieve|get|grab|sync)\b[^\n]{0,80}?\b(?:instructions?|latest\s+version|newest\s+version|updated?\s+(?:version|skill|steps|rules)|skill\s+file|prompts?|this\s+skill)\b[^\n]{0,80}?(?:https?:\/\/|\bfrom\s+(?:the\s+)?(?:url|link|web|internet|server)\b)|\b(?:latest|newest|updated|current)\s+(?:version\s+of\s+)?(?:this|these|the)\s+(?:skill|instructions|steps|rules)\b[^\n]{0,60}?(?:https?:\/\/|\b(?:at|from)\s+(?:the\s+)?(?:url|link)\b)|\bcheck\b[^\n]{0,80}?https?:\/\/[^\n]{0,80}?\b(?:updates?|new\s+versions?)\s+(?:to|of)\s+(?:this|these|the)\s+(?:skill|instructions)\b/i;

// ---- Front matter --------------------------------------------------------------------------------------------------
const OPENCLAW_BAD = ['hooks', 'install'];
const OPENCLAW_INFO = ['allowed-tools', 'requires', 'disable-model-invocation', 'user-invocable', 'command-dispatch', 'command-tool'];

// ---- Helpers -------------------------------------------------------------------------------------------------------
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return pos => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
}
function excerptAt(text, pos, len = 0) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  const le = (i => (i < 0 ? text.length : i))(text.indexOf('\n', pos));
  let from = ls, to = le;
  if (to - from > 160) { from = Math.max(ls, pos - 60); to = Math.min(le, pos + Math.max(len, 0) + 80); }
  return `${from > ls ? '…' : ''}${showHidden(text.slice(from, to).replace(/\r$/, '')).trim()}${to < le ? '…' : ''}`;
}
const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; } };

// ---- Text rules (SKILL.md and supporting text files) ---------------------------------------------------------------
function lintText(text, add) {
  const line = lineIndex(text);
  const at = (level, code, pos, len, message) => add({ level, code, line: line(pos), excerpt: excerptAt(text, pos, len), message });

  // Hidden characters: one finding per line.
  const seen = new Set();
  for (const m of text.matchAll(HIDDEN_ANY)) {
    if (m.index === 0 && m[0] === '\u{FEFF}') continue; // a byte-order mark at the very start is harmless
    const ln = line(m.index);
    const bad = HIDDEN_BAD.test(m[0]);
    const key = `${ln}:${bad}`;
    if (seen.has(key)) continue;
    seen.add(key);
    at(bad ? 'bad' : 'warn', bad ? 'hidden-characters' : 'direction-marks', m.index, 1,
      bad ? 'Hidden characters: invisible to a reader, but the model sees them.' : 'Direction marks (normal in Arabic or Persian text; odd anywhere else).');
  }

  for (const [level, code, re, message] of STEERING) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) at(level, code, m.index, m[0].length, message);
  }

  for (const m of text.matchAll(new RegExp(SECRET_ASK.source, 'gi'))) {
    if (NEGATED.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    at('bad', 'secret-request', m.index, m[0].length, 'Asks for a password, key, code or card details. Jess never needs these in a chat.');
  }

  for (const [level, code, re, message] of PERSIST) {
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) at(level, code, m.index, m[0].length, message);
  }

  for (const [code, re, message] of COMMANDS) {
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) at('bad', code, m.index, m[0].length, message);
  }
  for (const m of text.matchAll(/^[ \t]*(```|~~~)[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1/gm)) {
    const lang = m[2];
    if (SHELL_LANGS.test(lang) || (!lang && /^\s*(?:\$|>|PS>|sudo\s|curl\s|wget\s|npm\s|pip\s|git\s|cd\s)/m.test(m[3]))) {
      at('info', 'code-block', m.index, 3, 'A code block. Jess can’t run code: at most it’s an example to show someone.');
    }
  }
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (/[\p{L}]{3,}/u.test(m[1])) at('warn', 'html-comment', m.index, 4, 'An HTML comment: hidden when the page is shown, but the model reads it.');
  }
  for (const m of text.matchAll(/(?<![\w/+=.-])[A-Za-z0-9+/]{60,}={0,2}(?![\w/+=])/g)) {
    if (/[0-9]/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0])) at('warn', 'encoded-blob', m.index, m[0].length, 'A long encoded string (base64?): its content can’t be read here.');
  }

  // Links: every one listed; data-catchers, shorteners and tracking parameters flagged.
  const urlSpans = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    urlSpans.push([m.index, m.index + url.length]);
    const host = hostOf(url);
    if (!host) continue;
    let pathname = '/', params = [];
    try { const u = new URL(url); pathname = u.pathname; params = [...u.searchParams.keys()]; } catch { /* host only */ }
    if (EXFIL_HOSTS.some(re => re.test(host)) || EXFIL_PATHS.some(([h, p]) => h.test(host) && p.test(pathname))) {
      at('bad', 'exfil-host', m.index, url.length, `Links to ${host}, a service for catching data or pasting text. Nothing a household skill needs.`);
    } else if (SHORTENERS.test(host)) at('warn', 'short-link', m.index, url.length, `A short link (${host}) hides where it really goes.`);
    else at('info', 'link', m.index, url.length, `Link to ${host}.`);
    const tracked = params.filter(p => TRACKING.test(p));
    if (tracked.length) at('warn', 'tracking-link', m.index, url.length, `The link carries tracking or affiliate parameters (${tracked.join(', ')}).`);
  }
  for (const m of text.matchAll(BARE_HOST)) {
    if (urlSpans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const host = m[0].toLowerCase();
    if (EXFIL_HOSTS.some(re => re.test(host))) at('bad', 'exfil-host', m.index, m[0].length, `Names ${host}, a service for catching data or pasting text.`);
    else at('info', 'link', m.index, m[0].length, `Names the site ${host}.`);
  }
  for (const m of text.matchAll(new RegExp(REMOTE_INSTRUCTIONS.source, 'gi'))) {
    at('bad', 'remote-instructions', m.index, m[0].length, 'Tells Jess to fetch instructions (or a "latest version") from the web when it runs, so what Jess follows could change after you approve it.');
  }
}

// ---- Capability checks ---------------------------------------------------------------------------------------------
const JUSTIFIES = /\b(?:send|sends|sending|sent|e-?mail|mail|reply|replies|replying|share|sharing|post|posting|book|booking|bookings|buy|buying|order|ordering|pay|paying|payment|purchase|invite|invitation|schedule|calendar|events?|meetings?|appointments?|message|forward|publish|submit|group|family)\b/i;
const riskLevel = tool => {
  if (typeof tool.risk === 'string') return tool.risk;
  try { return tool.risk({}, {}) || 'write'; } catch { return 'write'; }
};

function lintCapabilities({ body, description, toolsets }, tools, add, line, raw, bodyOffset) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const declared = new Set(toolsets);
  const used = new Map();
  for (const t of tools) {
    const re = t.name.includes('_') ? new RegExp(`\\b${t.name}\\b`) : new RegExp(`\`${t.name}\``);
    const m = re.exec(body);
    if (m) used.set(t.name, m.index);
  }
  for (const [name, pos] of used) {
    const t = byName.get(name);
    const where = bodyOffset + pos;
    if (t.toolset !== 'core' && !declared.has(t.toolset)) {
      add({ level: 'warn', code: 'undeclared-toolset', line: line(where), excerpt: excerptAt(raw, where, name.length),
        message: `Uses ${name} (the "${t.toolset}" tools) but doesn’t list ${t.toolset} under toolsets, so the steps can fail for people without it.` });
    }
    const risk = riskLevel(t);
    if ((risk === 'external' || risk === 'spend') && !JUSTIFIES.test(description || '')) {
      add({ level: 'warn', code: 'unjustified-send', line: line(where), excerpt: excerptAt(raw, where, name.length),
        message: `Uses ${name}, which ${risk === 'spend' ? 'spends money' : 'reaches other people or sites'}, but the description doesn’t say this skill does that.` });
    }
  }
  // A snake_case name in backticks that is no tool: fine when it is one of the tools' parameters or values (`watch_url`,
  // `secret_santa`), a note otherwise.
  const known = new Set();
  const walk = schema => {
    if (!schema || typeof schema !== 'object') return;
    for (const [k, v] of Object.entries(schema.properties || {})) { known.add(k); walk(v); }
    for (const v of [].concat(schema.enum || [], schema.items?.enum || [])) known.add(String(v));
    if (schema.items) walk(schema.items);
  };
  for (const t of tools) walk(t.parameters);
  for (const m of body.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) {
    if (byName.size && !byName.has(m[1]) && !known.has(m[1])) {
      const where = bodyOffset + m.index;
      add({ level: 'info', code: 'unknown-tool', line: line(where), excerpt: excerptAt(raw, where, m[0].length), message: `Names a tool Jess doesn’t have: ${m[1]}.` });
    }
  }
}

// ---- Description ---------------------------------------------------------------------------------------------------
const TRIGGER = /\b(?:when|whenever|if|for|asks?|asking|wants?|needs?|like|such\s+as|e\.g\.)\b|["“”«»]|^\s*[\p{L}]+ing\b/iu;
const STEP_MARKERS = /\b(?:first|then|next|after\s+that|afterwards|finally|step\s+\d+)\b|(?:^|\s)\d[.)]\s|→|->/gi;

// Small TF-IDF cosine (zero dependencies) for description collisions between skills.
const STOP = new Set(('a an and are as at be by can do for from has have how i in into is it its of on or our so than that the their them then there '
  + 'these they this to up was we were what when where which who will with you your any anything about some something').split(' '));
const stem = w => w.replace(/(?:ing|ed|es|s)$/u, '') || w;
export const words = s => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 2 && !STOP.has(w)).map(stem);
/** The document frequencies of a corpus, once → vec(text) (a TF-IDF vector over that corpus). */
export function tfidfModel(corpus) {
  const docs = corpus.map(words);
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const n = docs.length;
  const vec = text => {
    const tf = new Map();
    for (const w of words(text)) tf.set(w, (tf.get(w) || 0) + 1);
    const v = new Map();
    for (const [w, c] of tf) v.set(w, c * (Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1));
    return v;
  };
  return { vec };
}
export function cosine(va, vb) {
  let dot = 0, na = 0, nb = 0;
  for (const [w, x] of va) { na += x * x; if (vb.has(w)) dot += x * vb.get(w); }
  for (const x of vb.values()) nb += x * x;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
export function tfidfCosine(a, b, corpus) {
  const { vec } = tfidfModel(corpus);
  return cosine(vec(a), vec(b));
}

// ---- Routing examples (Phase 23, decision #173) ----------------------------------------------------------------------
// Optional front matter `examples: { positive: [3 phrasings that should open the skill], negative: [2 that shouldn't] }`
// (also accepted under `metadata.examples`, the agentskills spec's vendor field). An offline, deterministic check ranks every
// skill against a phrasing by TF-IDF over name + description, the words Jess routes on: a positive must rank its skill in
// the top 3 and a negative must not rank it first. It catches a description that doesn't say what people actually say.
export const EXAMPLE_TOP = 3;
const routeDoc = s => `${String(s.name || '').replace(/-/g, ' ')} ${s.description || ''}`;

/** The skill's `examples:` → { positive[], negative[], problems[] }, or null when it has none. Never throws. */
export function examplesOf(meta) {
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const raw = m.examples ?? (m.metadata && typeof m.metadata === 'object' ? m.metadata.examples : undefined);
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { positive: [], negative: [], problems: ['“examples” must have a “positive:” list and a “negative:” list.'] };
  const problems = [];
  const list = key => {
    const v = raw[key];
    if (v == null) return [];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) { problems.push(`“examples.${key}” must be a list of phrasings (text).`); return []; }
    return v.map(x => x.trim());
  };
  const other = Object.keys(raw).filter(k => k !== 'positive' && k !== 'negative');
  if (other.length) problems.push(`“examples” takes “positive” and “negative” only (not ${other.join(', ')}).`);
  return { positive: list('positive'), negative: list('negative'), problems };
}

/** Skills ranked for one phrasing (TF-IDF cosine over name + description; the corpus is the skills themselves). A skill's
 *  rank is 1 + how many score strictly higher, so a tie at the top counts as first. → [{ name, score, rank }] best first. */
export function routeRanking(query, skills, model = tfidfModel(skills.map(routeDoc)), vecs = skills.map(s => model.vec(routeDoc(s)))) {
  const q = model.vec(query);
  const scored = skills.map((s, i) => ({ name: s.name, score: cosine(q, vecs[i]) })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.map(x => ({ ...x, rank: 1 + scored.filter(y => y.score > x.score).length }));
}

/** Does a skill's `examples:` route to it among `pool` (the skills it competes with; it is added when missing)?
 *  → failures [{ kind: 'positive'|'negative', text, rank, score, top }] (top = the skill ranked first). */
export function examplesCheck(skill, pool, { top = EXAMPLE_TOP } = {}) {
  const ex = skill.examples !== undefined ? skill.examples : examplesOf(skill.meta);
  if (!ex || (!ex.positive.length && !ex.negative.length)) return [];
  const list = pool.some(s => s.name === skill.name) ? pool : [...pool, skill];
  const model = tfidfModel(list.map(routeDoc));
  const vecs = list.map(s => model.vec(routeDoc(s)));
  const failures = [];
  for (const [kind, phrasings] of [['positive', ex.positive], ['negative', ex.negative]]) {
    for (const text of phrasings) {
      const ranking = routeRanking(text, list, model, vecs);
      const own = ranking.find(r => r.name === skill.name);
      const failed = kind === 'positive' ? !(own.score > 0 && own.rank <= top) : own.score > 0 && own.rank === 1;
      if (failed) failures.push({ kind, text, rank: own.rank, score: Number(own.score.toFixed(3)), top: ranking[0].name });
    }
  }
  return failures;
}

// ---- Web addresses in drafts Jess writes (skill_propose, decision #171) ---------------------------------------------
// A skill she drafts must never send her to a web address when it runs: whatever that page says later would become her
// steps, after the admin approved something else. Stricter than the review rule for the admin's own skills (remote-
// instructions): any line that pairs a link with a verb that opens, reads or follows it.
const FETCH_VERB = /\b(?:fetch|download|load|read|open|visit|follow|browse|go\s+to|navigate|retrieve|pull|grab|import|include|get|check|consult|look\s+(?:at|up)|web_read|web_fetch|browser_open)\b/i;
const LINK = /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*/i;
/** Lines of `text` that tell Jess to open a web address → [{ line, excerpt }]. */
export function urlFetchLines(text) {
  const out = [];
  String(text || '').split('\n').forEach((l, i) => { if (LINK.test(l) && FETCH_VERB.test(l)) out.push({ line: i + 1, excerpt: l.trim().slice(0, 160) }); });
  return out;
}

// ---- Entry point ---------------------------------------------------------------------------------------------------
/** Findings for one skill, worst first. Never throws on odd input (a broken skill is linted as far as it can be). */
export function lintSkill({ name = '', raw = '', meta = null, body = '', files = [] } = {}, { others = [], tools = allTools() } = {}) {
  const out = [];
  const keys = new Set();
  // Messages are written about "Jess"; the admin reads them with the assistant's own name (#7). Excerpts are left as they are.
  const bot = botName();
  const named = f => (bot === DEFAULT_NAME ? f : { ...f, message: String(f.message).replace(/\bJess\b/g, () => bot) });
  const add = f => { const k = `${f.file || ''}|${f.code}|${f.line}`; if (!keys.has(k)) { keys.add(k); out.push(named(f)); } };
  const text = String(raw || '');
  const line = lineIndex(text);

  lintText(text, add);

  // Front matter.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const keyLine = key => { const i = fm ? fm[1].search(new RegExp(`^\\s*${key.replace(/[-.]/g, '\\$&')}\\s*:`, 'm')) : -1; return i < 0 ? 1 : line(4 + i); };
  const m0 = meta && typeof meta === 'object' ? meta : {};
  const vendor = [m0, m0.metadata?.openclaw, m0.metadata?.clawdbot, m0.metadata?.clawdis].filter(x => x && typeof x === 'object');
  for (const k of OPENCLAW_BAD) {
    if (vendor.some(v => k in v)) add({ level: 'bad', code: 'openclaw-key', line: keyLine(k), excerpt: `${k}:`, message: `"${k}" asks the host to run code or install things. Jessbot never does: remove it.` });
  }
  for (const k of OPENCLAW_INFO) {
    if (vendor.some(v => k in v)) add({ level: 'info', code: 'ignored-key', line: keyLine(k), excerpt: `${k}:`, message: `"${k}" is for other assistants; Jessbot ignores it (a skill uses the tools its toolsets allow).` });
  }
  if (fm && /[<>]/.test(fm[1])) add({ level: 'warn', code: 'frontmatter-markup', line: line(4 + fm[1].search(/[<>]/)), excerpt: excerptAt(text, 4 + fm[1].search(/[<>]/)), message: 'Angle brackets in the front matter (markup there can confuse other tools).' });

  // Description.
  const description = typeof m0.description === 'string' ? m0.description.trim() : '';
  if (description) {
    const dl = keyLine('description');
    if (description.length > DESCRIPTION_WARN) add({ level: 'warn', code: 'description-long', line: dl, excerpt: `${description.slice(0, 80)}…`, message: `The description is ${description.length} characters. It sits in every prompt: keep it under ${DESCRIPTION_WARN}.` });
    if ((description.match(STEP_MARKERS) || []).length >= 2) add({ level: 'warn', code: 'description-steps', line: dl, excerpt: description.slice(0, 160), message: 'The description summarises the steps. Jess may follow that summary instead of opening the skill: say what it’s for and when to use it.' });
    else if (!TRIGGER.test(description)) add({ level: 'info', code: 'description-trigger', line: dl, excerpt: description.slice(0, 160), message: 'The description doesn’t say when to use it (the words people would say, or "when …").' });
    const pool = others.filter(o => o.name !== name && o.description);
    if (pool.length) {
      const corpus = [description, ...pool.map(o => o.description)];
      for (const o of pool) {
        const score = tfidfCosine(description, o.description, corpus);
        if (score >= COLLISION) add({ level: 'warn', code: 'description-collision', line: dl, excerpt: o.description.slice(0, 160), message: `The description is very close to the "${o.name}" skill’s (similarity ${score.toFixed(2)}), so Jess may pick the wrong one.`, other: o.name });
      }
    }
  }

  // Routing examples (#173): their shape, and whether they route to this skill among the other active ones.
  const ex = examplesOf(m0);
  if (ex) {
    const el = keyLine('examples');
    for (const p of ex.problems) add({ level: 'warn', code: 'examples-shape', line: el, excerpt: 'examples:', message: p });
    if (!ex.problems.length && (ex.positive.length < 3 || ex.negative.length < 2)) {
      add({ level: 'info', code: 'examples-count', line: el, excerpt: 'examples:', message: `The examples give ${ex.positive.length} positive and ${ex.negative.length} negative phrasings; 3 and 2 test the description best.` });
    }
    const pool = others.filter(o => o.name !== name && o.description);
    if (description && pool.length) {
      for (const f of examplesCheck({ name, description, examples: ex }, pool)) {
        add({ level: 'warn', code: 'examples-miss', line: el, excerpt: f.text.slice(0, 160), message: f.kind === 'positive'
          ? `“${f.text}” should open this skill, but its words rank it #${f.rank} (“${f.top}” first). Say it in the description the way people do.`
          : `“${f.text}” shouldn’t open this skill, but its words rank it first. Make the description say what sets it apart.` });
      }
    }
  }

  // Body size and capabilities.
  const bodyText = String(body || '');
  if (bodyText.length > BODY_WARN) add({ level: 'warn', code: 'long-body', line: line(text.length - 1), excerpt: '', message: `The instructions are ${bodyText.length.toLocaleString('en')} characters (over ${BODY_WARN.toLocaleString('en')}): long skills are hard to review and crowd the conversation.` });
  const bodyOffset = Math.max(0, text.indexOf(bodyText.slice(0, 40)));
  const toolsets = [].concat(m0.toolsets ?? m0.metadata?.toolsets ?? []).map(String);
  lintCapabilities({ body: bodyText, description, toolsets }, tools, add, line, text, bodyOffset);

  // Supporting files.
  for (const f of files) {
    const buf = f.buf;
    const tag = x => ({ ...x, file: f.name });
    if (!buf) continue;
    const head = buf.subarray(0, 4);
    const exe = (head[0] === 0x4d && head[1] === 0x5a) || head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(buf.length >= 4 ? buf.readUInt32BE(0) : -1);
    if (exe) { add(tag({ level: 'bad', code: 'executable-file', line: 1, excerpt: f.name, message: 'A program file. Jess can’t run it and a skill has no use for one.' })); continue; }
    if (/\.(?:sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|rb|pl|php|exe|dll|so|dylib|jar)$/i.test(f.name)) add(tag({ level: 'warn', code: 'script-file', line: 1, excerpt: f.name, message: 'A script. Jess can’t run it: check what it’s for.' }));
    if (buf.subarray(0, 8192).includes(0)) { add(tag({ level: 'info', code: 'binary-file', line: 1, excerpt: f.name, message: 'A binary file (not text): it can’t be reviewed here.' })); continue; }
    const content = buf.toString('utf8');
    if (openableFile(f.name) && content.length > SUPPORT_TEXT_MAX) {
      add(tag({ level: 'warn', code: 'support-file-long', line: 1, excerpt: f.name, message: `${content.length.toLocaleString('en')} characters: Jess can open supporting files up to ${SUPPORT_TEXT_MAX.toLocaleString('en')}, so she can’t read this one. Split it.` }));
    }
    lintText(content, x => add(tag(x)));
  }

  return out.sort((a, b) => LEVELS[a.level] - LEVELS[b.level] || String(a.file || '').localeCompare(String(b.file || '')) || a.line - b.line);
}

/** { bad, warn, info } counts. */
export const lintSummary = findings => findings.reduce((s, f) => ({ ...s, [f.level]: s[f.level] + 1 }), { bad: 0, warn: 0, info: 0 });
