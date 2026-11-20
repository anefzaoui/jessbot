// Client entry: wires every in-house module. Each init is safe on pages without its markup.
import { on, startClocks, icon, initBidi } from './core.js';
import { initTheme } from './theme.js';
import { initModals } from './modal.js';
import { initMenus } from './menu.js';
import { initTooltips } from './tooltip.js';
import { initTabs } from './tabs.js';
import { initShell } from './shell.js';
import { initCmdk } from './cmdk.js';
import { initAsk } from './ask.js';
import { initComposer, scrollToEnd } from './composer.js';
import { initApprovals } from './approvals.js';
import { initForms } from './forms.js';
import { initFeed } from './feed.js';
import { initIdeas } from './ideas.js';
import { initGoals } from './goals.js';
import { initLightbox } from './lightbox.js';
import { initHandover } from './handover.js';
import { initLibrary } from './library.js';
import { initMemory } from './memory.js';
import { initLists } from './lists.js';
import { initYou } from './you.js';
import { initPresence } from './presence.js';
import { initRealtime } from './ws.js';
import { initRuns, focusRunAnchor } from './run.js';
import { initLive } from './live.js';
import { initAlarms } from './alarms.js';
import { initNotify } from './notify.js';
import { initPlaces } from './places.js';
import { initDeleteMessage } from './delete-message.js';
import { initCodeCopy } from './code-copy.js';
import { initMeTabs } from './me-tabs.js';
import { initAdminSystem } from './admin-system.js';
import { initConnections } from './connections.js';
import { initAdminSkills } from './admin-skills.js';
import { initFeedSources } from './feed-sources.js';
import { initProjects } from './projects.js';
import { initProjectSoul } from './project-soul.js';
import { initAdminFeed } from './admin-feed.js';
import { initModelTest } from './model-test.js';
import { initVoice } from './voice.js';
import { initAdminVoice } from './admin-voice.js';
import { initMdEditors } from './md-editor.js';
import { initAdminDecide } from './admin-decide.js';
// Phase 25 part C (#203–#205): Admin → Models / Usage / System / Lessons, You → Memory lessons and tidy, Feed extras, reminder cards.
import { initAdminModels } from './admin-models.js';
import { initAdminUsage } from './admin-usage.js';
import { initAdminWishes } from './admin-wishes.js';
import { initAdminLessons } from './admin-lessons.js';
import { initMeLessons } from './me-lessons.js';
import { initFeedTools } from './feed-tools.js';
import { initReminderCards } from './reminder-card.js';
// Phase 25 part D (#211–#213): What's new, overnight prep, the self-review.
import { initWhatsNew } from './whats-new.js';
import { initPrep } from './prep.js';
import { initAdminReview } from './admin-review.js';
import { toast } from './toast.js';

initTheme();
initBidi();
initModals();
initMenus();
initTooltips();
initTabs();
initShell();
initCmdk();
initAsk();
initComposer();
initApprovals();
initForms();
initFeed();
initFeedSources();
initProjects();
initProjectSoul();
initAdminFeed();
initIdeas();
initGoals();
initLightbox();
initHandover();
initLibrary();
initMemory();
initLists();
initYou();
initPresence();
initRuns();
initLive();
initAlarms();
initNotify();
initPlaces();
initDeleteMessage();
initCodeCopy();
initMeTabs();
initAdminSystem();
initConnections();
initAdminSkills();
initModelTest();
initVoice();
initAdminVoice();
initMdEditors();
initAdminDecide();
initAdminModels();
initAdminUsage();
initAdminWishes();
initAdminLessons();
initMeLessons();
initFeedTools();
initReminderCards();
initWhatsNew();
initPrep();
initAdminReview();
initRealtime();
startClocks();
// Boot is done: allow transitions again (the head script disabled them so the first paint doesn't "settle").
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('no-transitions')));
if (!focusRunAnchor()) scrollToEnd(false); // /chat/<thread>#run-<id> opens at that reply (#212)

// Fill timezone fields with the browser's zone; select-all on focus for copyable fields.
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
document.querySelectorAll('[data-tz-default]').forEach(el => { if (!el.value) el.value = tz; });
on(document, 'focusin', '[data-select-on-focus]', (e, el) => el.select());

// Activity page filter chips.
on(document, 'click', '[data-activity-filter]', (e, chip) => {
  document.querySelectorAll('[data-activity-filter]').forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
  const kind = chip.dataset.activityFilter;
  document.querySelectorAll('[data-activity-list] [data-activity-id]').forEach(li => { li.hidden = kind !== 'all' && li.dataset.kind !== kind; });
  document.querySelectorAll('[data-activity-list]').forEach(ol => { ol.closest('section').hidden = !ol.querySelector('[data-activity-id]:not([hidden])'); });
});

// Character counters: <textarea data-counter> + [data-counter-out] in the same form.
const count = ta => { const out = ta.form?.querySelector('[data-counter-out]'); if (out) out.textContent = ta.value.length; };
document.querySelectorAll('textarea[data-counter]').forEach(count);
on(document, 'input', 'textarea[data-counter]', (e, ta) => count(ta));

// Fill an input from a chip: <button data-fill="text" data-fill-target="input-id">
on(document, 'click', '[data-fill]', (e, btn) => {
  const target = document.getElementById(btn.dataset.fillTarget);
  if (!target) return;
  target.value = btn.dataset.fill;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.focus();
});

// Copy: [data-copy="text"] or [data-copy-message] (copies the message body as plain text).
on(document, 'click', '[data-copy], [data-copy-message]', async (e, btn) => {
  const text = btn.dataset.copy ?? btn.closest('[data-message-id]')?.querySelector('[data-message-body]')?.innerText ?? '';
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.innerHTML;
    btn.innerHTML = icon('check', 'size-3.5 text-ok');
    setTimeout(() => { btn.innerHTML = original; }, 1400);
  } catch {
    toast.error("Couldn't copy. Your browser blocked clipboard access.");
  }
});
