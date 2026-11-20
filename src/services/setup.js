// First-run setup: owner account → model connection → browser → identity → invite people → done.
// Progress lives in settings('setup'); the wizard can be resumed after a refresh or restart.
import crypto from 'node:crypto';
import { settings } from '../db/index.js';
import { countUsers } from './users.js';

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

// One-time claim code for a fresh install reached from another machine (printed to the server console).
let claimCode = null;
export function claimCodeIfNeeded() {
  if (countUsers()) return null;
  claimCode ??= crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');
  return claimCode;
}
export const checkClaimCode = code => !!claimCode && String(code || '').trim().toUpperCase() === claimCode;
