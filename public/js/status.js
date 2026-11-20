// Live "what is Jessbot doing" — updates every avatar, the status strip, panel labels, the tab title
// and screen readers from one call. Fed by the event stream (Phase 3) via setActivity().
// Payload: { activity, target?, since?: ISO, doneToday?, upcomingCount? }  (keys: activities.js)
import { $$, icon, formatElapsed } from './core.js';
import { activityOf, describe } from './activities.js';
import { announce } from './shell.js';

const baseTitle = document.title;
let current = null;
let lastAnnounced = 0;

export function setActivity({ activity = 'resting', target, since, doneToday, upcomingCount } = {}) {
  const a = activityOf(activity);
  const label = activity === 'resting' ? 'Resting' : describe(activity, target);
  const changed = !current || current.activity !== activity || current.target !== target;
  current = { activity, target };

  for (const av of $$('[data-avatar]')) {
    av.dataset.state = a.avatar;
    av.dataset.activity = activity;
    const badge = av.querySelector('.avatar-badge');
    if (badge && changed) {
      badge.classList.add('is-swapping');
      setTimeout(() => {
        badge.innerHTML = icon(a.iconName, 'size-full');
        badge.dataset.tone = a.tone;
        badge.classList.remove('is-swapping');
      }, 150);
    }
  }

  for (const strip of $$('[data-status-strip]')) {
    strip.dataset.tone = a.tone;
    strip.dataset.panelOpen = activity === 'waiting' ? 'approvals' : 'activity';
    strip.querySelector('[data-status-icon]').innerHTML = icon(a.iconName, 'size-3.5');
    strip.querySelector('[data-status-label]').textContent = label;
    const elapsed = strip.querySelector('[data-status-elapsed]');
    if (since && activity !== 'resting') {
      elapsed.hidden = false;
      elapsed.dataset.elapsedSince = since;
      elapsed.textContent = formatElapsed(Date.now() - new Date(since));
    } else {
      elapsed.hidden = true;
      delete elapsed.dataset.elapsedSince;
    }
    if (doneToday != null) strip.querySelector('[data-status-done]').textContent = doneToday;
    if (upcomingCount != null) strip.querySelector('[data-status-next]').textContent = upcomingCount;
  }

  for (const el of $$('[data-live-agent-label]')) el.textContent = label;

  // The living presence (presence.js) follows the activity with the matching expression.
  if (changed) document.dispatchEvent(new CustomEvent('jb:activity', { detail: { activity, target } }));

  // Background tabs show what's happening in the title.
  document.title = activity === 'resting' ? baseTitle : `${a.tone === 'wait' ? '✋ ' : '● '}${label} | ${baseTitle}`;

  // Announce meaningful changes, at most every 4s so screen readers aren't flooded.
  if (changed && Date.now() - lastAnnounced > 4000) {
    lastAnnounced = Date.now();
    announce(label);
  }
}

export const getActivity = () => current;
