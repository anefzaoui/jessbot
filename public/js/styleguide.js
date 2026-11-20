// DEV styleguide demos: activity playback, toasts, busy buttons, confirm.
import { on, withBusy } from './core.js';
import { setActivity } from './status.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

on(document, 'click', '[data-sg-activity]', (e, b) => {
  const activity = b.dataset.sgActivity;
  const targets = { searching: 'best Greek restaurants near me', reading: 'opentable.com/taverna-mykonos',
    editing: 'Budget 2027.xlsx', creating: 'Chess analysis dashboard', fetching: '12 feeds', waiting: '1 approval' };
  setActivity({ activity, target: targets[activity], since: new Date().toISOString(), doneToday: 5, upcomingCount: 4 });
});

on(document, 'click', '[data-sg-play]', async (e, btn) => {
  await withBusy(btn, async () => {
    const steps = [
      ['thinking'], ['searching', 'Resident Evil showtimes Palo Alto'], ['reading', 'amctheatres.com'],
      ['browsing', 'fandango.com/seat-map'], ['writing'], ['waiting', 'your OK to pay $39.98'],
      ['remembering', 'likes center seats'], ['resting'],
    ];
    for (const [activity, target] of steps) {
      setActivity({ activity, target, since: new Date().toISOString(), doneToday: 5, upcomingCount: 4 });
      await sleep(activity === 'waiting' ? 2600 : 1600);
    }
    toast.success('Run finished. Tickets booked.');
  }, 'Playing…');
});

on(document, 'click', '[data-sg-toast]', (e, b) => {
  const kind = b.dataset.sgToast;
  if (kind === 'success') toast.success('Saved to your library.');
  if (kind === 'error') toast.error('The model provider timed out.', { title: 'Message not sent', action: { label: 'Retry', onClick: () => toast('Retrying…') } });
  if (kind === 'undo') toast('Idea dismissed.', { action: { label: 'Undo', onClick: () => toast.success('Restored.') } });
});

on(document, 'click', '[data-sg-busy]', (e, b) => withBusy(b, () => sleep(1500), 'Saving…'));

on(document, 'click', '[data-sg-confirm]', async () => {
  const ok = await confirmDialog({ title: 'Forget this memory?', body: 'Likes grilled octopus; prefers Greek restaurants.', confirmLabel: 'Forget', danger: true });
  toast(ok ? 'Forgotten.' : 'Kept it.');
});
