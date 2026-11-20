// Central configuration. Every path Jessbot touches is resolved here so the
// whole install stays portable: move the folder, and everything moves with it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load .env (Node built-in, no dotenv dependency). Missing file is fine. JESSBOT_ENV_FILE points elsewhere (a second
// copy of the code sharing one install's .env, or a test's throwaway folder).
export const ENV_FILE = process.env.JESSBOT_ENV_FILE || path.join(ROOT, '.env');
const envFile = ENV_FILE;
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

// JESSBOT_HOME relocates all runtime data; defaults to ./data inside the install.
const DATA = path.resolve(ROOT, env.JESSBOT_HOME || 'data');
const TOOLS = path.resolve(ROOT, env.JESSBOT_TOOLS || 'tools');

export const paths = {
  root: ROOT,
  data: DATA,
  tools: TOOLS,
  db: path.join(DATA, 'jessbot.sqlite'),
  workspace: path.join(DATA, 'workspace'),      // SOUL.md, AGENTS.md, MEMORY.md
  users: path.join(DATA, 'users'),              // users/<id>/USER.md + memory/
  artifacts: path.join(DATA, 'artifacts'),
  uploads: path.join(DATA, 'uploads'),
  browserProfiles: path.join(DATA, 'browser-profiles'),
  shots: path.join(DATA, 'shots'),              // web screenshots shown in chat
  voice: path.join(DATA, 'voice'),              // voice notes and Jess's spoken replies (WAV, docs/VOICE.md)
  cloakbrowser: path.join(TOOLS, 'cloakbrowser'), // CloakBrowser binary + licence key (never committed, decision #15)
  logs: path.join(DATA, 'logs'),
  backups: path.join(DATA, 'backups'),
  skills: path.join(ROOT, 'skills'),
  views: path.join(ROOT, 'src', 'views'),
  public: path.join(ROOT, 'public'),
  migrations: path.join(ROOT, 'src', 'db', 'migrations'),
};

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  // Bind to loopback by default; exposing Jessbot is an explicit choice.
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT) || 3737,
  publicUrl: env.PUBLIC_URL || `http://localhost:${Number(env.PORT) || 3737}`,
  // Which proxies may tell us the client's address (X-Forwarded-For). Express's syntax: 'loopback' (default: a reverse
  // proxy on the same machine), 'false' (no proxy: the socket address is the client), a hop count, or addresses/CIDRs.
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  // The first admin account needs the one-time setup code printed in the server log. JESSBOT_SETUP_CODE=off turns that
  // off (only for an install nobody else can reach before you finish); any other value of 8+ characters is the code.
  setupCode: parseSetupCode(env.JESSBOT_SETUP_CODE),
  llm: {
    baseUrl: env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_KEY || env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'openai/gpt-6-luna',
  },
};

/** TRUST_PROXY → the value Express's 'trust proxy' setting takes. */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'loopback';
  if (/^(false|no|off|0)$/i.test(s)) return false;
  if (/^(true|yes|on)$/i.test(s)) throw new Error('TRUST_PROXY=true would trust any client’s X-Forwarded-For. Name the proxy (loopback, an address, a CIDR) or a hop count.');
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

/** JESSBOT_SETUP_CODE → { off } | { fixed } | {} (a random code each start). */
export function parseSetupCode(v) {
  const s = String(v ?? '').trim();
  if (!s) return {};
  if (/^(off|false|no|0)$/i.test(s)) return { off: true };
  if (s.length < 8) throw new Error('JESSBOT_SETUP_CODE must be at least 8 characters (or "off").');
  return { fixed: s.toUpperCase() };
}

// Create the runtime directory tree on first boot.
export function ensureDirs() {
  for (const key of ['data', 'tools', 'workspace', 'users', 'artifacts', 'uploads',
    'browserProfiles', 'shots', 'voice', 'logs', 'backups']) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
}
