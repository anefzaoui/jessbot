// Who the assistant is, for code that speaks about it (#7): the name and pronouns the admin set in setup or Admin →
// Identity. Copy, prompts, notifications and errors take the name from here instead of writing "Jess", and never assume
// "she": a sentence that needs the assistant names it. Every Jessbot starts as Jess (DEFAULT_NAME), so an install that
// hasn't finished setup still reads naturally.
import { settings } from '../db/index.js';

export const DEFAULT_NAME = 'Jess';

/** The assistant's name as the admin set it, else "Jess". */
export const botName = () => String(settings.get('bot', {})?.name ?? '').trim() || DEFAULT_NAME;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regular-expression fragment matching the assistant's name, and "Jess" too (every Jessbot answers to its origin). */
export function nameAlternation() {
  const name = botName();
  return name.toLowerCase() === DEFAULT_NAME.toLowerCase() ? DEFAULT_NAME : `${escapeRe(name)}|${DEFAULT_NAME}`;
}
