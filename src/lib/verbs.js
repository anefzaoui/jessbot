// Step labels while they run (owner: "more verbs in the loading card"). Tools label a step in the past tense
// ("Typed “Lisbon” in From"); while it runs the same label reads in the present ("Typing “Lisbon” in From…").
// One table instead of a second label per tool; a tool may still give its own `doing(args)`.
const PRESENT = {
  accepted: 'Accepting', added: 'Adding', answered: 'Answering', asked: 'Asking', built: 'Building', cancelled: 'Cancelling',
  changed: 'Changing', checked: 'Checking', chose: 'Choosing', clicked: 'Clicking', closed: 'Closing', compared: 'Comparing',
  created: 'Creating', dismissed: 'Dismissing', downloaded: 'Downloading', drafted: 'Drafting', filled: 'Filling in', found: 'Finding',
  forgot: 'Forgetting', listed: 'Listing', looked: 'Looking', made: 'Making', moved: 'Moving', noted: 'Noting', opened: 'Opening',
  paused: 'Pausing', picked: 'Picking', planned: 'Planning', pressed: 'Pressing', read: 'Reading', remembered: 'Remembering',
  removed: 'Removing', saved: 'Saving', scheduled: 'Scheduling', scrolled: 'Scrolling', searched: 'Searching', sent: 'Sending',
  set: 'Setting', started: 'Starting', suggested: 'Suggesting', switched: 'Switching', took: 'Taking', typed: 'Typing',
  updated: 'Updating', waited: 'Waiting', went: 'Going', wrote: 'Writing',
};

/** "Typed “Lisbon” in From" → "Typing “Lisbon” in From…" (unknown verbs: the label as is, with an ellipsis). */
export function progressive(label) {
  const text = String(label || '').trim();
  const m = /^(\p{L}+)(.*)$/su.exec(text);
  const verb = m && PRESENT[m[1].toLowerCase()];
  const out = verb ? `${verb}${m[2]}` : text;
  return /[.…!?]$/.test(out) ? out : `${out}…`;
}
