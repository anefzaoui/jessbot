// The agent's editable workspace files in data/workspace: SOUL.md (persona + identity), AGENTS.md (operating
// rules), MEMORY.md (shared notes). Defaults come from src/content/workspace/*.hbs. The identity block inside
// SOUL.md is managed by setup/Identity settings and replaced in place, preserving any admin edits around it.
import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { paths, ROOT } from '../config/index.js';
import { get as dbGet, all as dbAll, run as dbRun } from '../db/index.js';
import { pictureChoices } from './assistant-pictures.js';

const TEMPLATES = path.join(ROOT, 'src', 'content', 'workspace');
const START = '<!-- jessbot:identity:start — managed by Settings → Identity; edit it there -->';
const END = '<!-- jessbot:identity:end -->';

export const VARIANTS = {
  female: { label: 'Female', pronouns: 'she/her', look: 'a woman' },
  male: { label: 'Male', pronouns: 'he/him', look: 'a man' },
  neutral: { label: 'Gender-neutral', pronouns: 'they/them', look: 'an androgynous person' },
};

export const TONES = {
  warm: { label: 'Warm & playful', text: 'warm, upbeat and a little playful — like a capable friend' },
  calm: { label: 'Calm & professional', text: 'calm, polished and professional — like an excellent chief of staff' },
  direct: { label: 'Concise & direct', text: 'concise and direct — no fluff, just what matters' },
  cheerful: { label: 'Cheerful & encouraging', text: 'cheerful and encouraging — celebrates progress, keeps spirits up' },
};

const file = name => path.join(paths.workspace, name);
const render = (tpl, data) => Handlebars.compile(fs.readFileSync(path.join(TEMPLATES, tpl), 'utf8'), { noEscape: true })(data);

// Atomic write: temp file + rename.
function writeAtomic(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

export function identityBlock(bot) {
  const v = VARIANTS[bot.variant] || VARIANTS.female;
  const t = TONES[bot.tone] || TONES.warm;
  return [
    START,
    '## Identity',
    '',
    `- **Name:** ${bot.name}`,
    `- **What I am:** a Jessbot — a personal AI agent. The original Jessbot is called Jess; this instance is ${bot.name}.`,
    `- **Pronouns:** ${bot.pronouns || v.pronouns}`,
    // The avatar is presentation, not identity: never volunteered (the owner didn't want "android" in introductions).
    `- **Avatar:** the app shows me as ${pictureChoices().avatar.kind === 'upload' ? 'a picture the admin chose' : `a portrait of ${v.look}`}. That's just how I'm drawn — I don't bring it up unless someone asks.`,
    bot.description ? `- **In a sentence:** ${bot.description}` : null,
    `- **Tone:** ${t.text}.`,
    END,
  ].filter(l => l !== null).join('\n');
}

// Create or update SOUL.md's identity block; create AGENTS.md / MEMORY.md if missing.
export function writeIdentity(bot) {
  const soul = file('SOUL.md');
  const block = identityBlock(bot);
  if (fs.existsSync(soul)) {
    const text = fs.readFileSync(soul, 'utf8');
    const s = text.indexOf(START.slice(0, 30)), e = text.indexOf(END);
    writeAtomic(soul, s >= 0 && e > s ? text.slice(0, s) + block + text.slice(e + END.length) : `${block}\n\n${text}`);
  } else {
    writeAtomic(soul, render('SOUL.md.hbs', { identityBlock: block, botName: bot.name }));
  }
  if (!fs.existsSync(file('AGENTS.md'))) writeAtomic(file('AGENTS.md'), render('AGENTS.md.hbs', { botName: bot.name }));
  if (!fs.existsSync(file('MEMORY.md'))) writeAtomic(file('MEMORY.md'), '# MEMORY\n\nShared notes everyone may benefit from. Private facts live per person.\n');
}

export const readWorkspaceFile = name => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
export const writeWorkspaceFile = (name, text) => writeAtomic(file(name), text);

// ---- Admin → Personality: edit the workspace files with full history (decision #53) --------------------------

export const EDITABLE = {
  'SOUL.md': { label: 'Soul', hint: 'Who she is: personality, values, how she carries herself. The identity block is managed in Identity.' },
  'AGENTS.md': { label: 'Rules', hint: 'How she works: operating rules, proactivity, safety, when to ask first.' },
  'MEMORY.md': { label: 'Shared notes', hint: 'Household/team facts everyone’s conversations may use (private facts live per person).' },
};
export const WORKSPACE_MAX = 60_000;

/** Save a workspace file, keeping the previous text as a version. SOUL.md's identity block is always the managed one. */
export function saveWorkspaceFile(name, text, { authorId = null, note = 'saved', bot = null } = {}) {
  if (!EDITABLE[name]) throw Object.assign(new Error('Unknown file.'), { status: 404 });
  let body = String(text ?? '').replace(/\r\n/g, '\n');
  if (body.length > WORKSPACE_MAX) throw Object.assign(new Error(`Keep it under ${WORKSPACE_MAX.toLocaleString()} characters.`), { status: 422, field: 'body' });
  if (name === 'SOUL.md' && bot) {
    const block = identityBlock(bot);
    const s = body.indexOf(START.slice(0, 30)), e = body.indexOf(END);
    body = s >= 0 && e > s ? body.slice(0, s) + block + body.slice(e + END.length) : `${block}\n\n${body}`;
  }
  const before = readWorkspaceFile(name);
  if (before === body) return { changed: false };
  // First edit ever: keep the original too, so "restore" can always go back to the start.
  if (!dbGet('SELECT 1 FROM workspace_versions WHERE file = ?', name) && before) {
    dbRun(`INSERT INTO workspace_versions (file, body, author_id, note) VALUES (?, ?, NULL, 'original')`, name, before);
  }
  writeWorkspaceFile(name, body);
  dbRun('INSERT INTO workspace_versions (file, body, author_id, note) VALUES (?, ?, ?, ?)', name, body, authorId, note);
  return { changed: true };
}

export const workspaceVersions = (name, limit = 30) => dbAll(
  `SELECT v.id, v.note, v.created_at, length(v.body) AS size, u.name AS author FROM workspace_versions v
   LEFT JOIN users u ON u.id = v.author_id WHERE v.file = ? ORDER BY v.id DESC LIMIT ?`, name, limit);
export const workspaceVersion = id => dbGet('SELECT * FROM workspace_versions WHERE id = ?', Number(id)) || null;
