// First-run setup: owner account → model connection → browser → identity → invite people → done.
// Progress lives in settings('setup'); the wizard can be resumed after a refresh or restart.
import crypto from 'node:crypto';
import { settings } from '../db/index.js';
import { countUsers } from './users.js';
import { config } from '../config/index.js';

export const STEPS = [
  { key: 'account', label: 'Your account' },
  { key: 'model', label: 'Brain' },
  { key: 'browser', label: 'Internet' },
  { key: 'identity', label: 'Identity' },
  { key: 'people', label: 'People' },
];

export const setupState = () => settings.get('setup', { done: [], completedAt: null });
export const isSetupComplete = () => !!setupState().completedAt;

export function markStep(key) {
  const s = setupState();
  if (!s.done.includes(key)) s.done.push(key);
  settings.set('setup', s);
}

export function completeSetup() {
  settings.set('setup', { ...setupState(), completedAt: new Date().toISOString() });
}

// The first step the owner still has to do (account must exist before anything else).
export function currentStep() {
  if (!countUsers()) return 'account';
  const { done } = setupState();
  return STEPS.find(s => s.key !== 'account' && !done.includes(s.key))?.key || 'people';
}

// One-time claim code for a fresh install (printed to the server console). It is needed to create the first admin from
// ANY device: whether a request is "local" can't be told behind a reverse proxy on the same machine, where every request
// arrives from 127.0.0.1. The operator can turn it off (JESSBOT_SETUP_CODE=off) or fix it (JESSBOT_SETUP_CODE=<code>).
let claimCode = null;
export function claimCodeIfNeeded() {
  if (countUsers() || config.setupCode.off) return null;
  claimCode ??= config.setupCode.fixed || crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-');
  return claimCode;
}
const norm = s => String(s || '').trim().toUpperCase();
const sameCode = (a, b) => { const x = Buffer.from(norm(a)), y = Buffer.from(norm(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/** True when the code matches (or the operator turned the code off). */
export const checkClaimCode = code => (config.setupCode.off ? true : !!claimCodeIfNeeded() && sameCode(code, claimCode));
