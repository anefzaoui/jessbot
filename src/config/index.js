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
  llm: {
    baseUrl: env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_KEY || env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'openai/gpt-6-luna',
  },
};

// Create the runtime directory tree on first boot.
export function ensureDirs() {
  for (const key of ['data', 'tools', 'workspace', 'users', 'artifacts', 'uploads',
    'browserProfiles', 'shots', 'voice', 'logs', 'backups']) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
}
