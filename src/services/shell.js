// App shell data for a signed-in person (contract: middleware/locals.js emptyShell()).
import { NAV_ITEMS } from '../middleware/locals.js';
import { agentState } from './runs.js';
import { sideThreads } from './threads.js';
import { listProjects, projectView } from './projects.js';
import { weeklyUsage } from './usage.js';
import { effectivePolicy } from './policy.js';
import { pendingCount, pendingFor } from './approvals.js';
import { activityDays } from './activity.js';
import { upcomingPanel } from './upcoming.js';
import { ringingFor, alarmView } from './alarms.js';
import { get } from '../db/index.js';

// Badges: ideas nobody has looked at yet; goals waiting on an answer or a yes/no on a suggestion.
const navCounts = user => ({
  ideas: get(`SELECT COUNT(*) AS n FROM ideas WHERE user_id = ? AND state = 'new'`, user.id).n,
  goals: get(`SELECT COUNT(*) AS n FROM goals WHERE user_id = ? AND (state = 'suggested' OR (state = 'active' AND stage = 'intake' AND intake IS NOT NULL))`, user.id).n,
});

export function shellFor(user, { activeThreadId = null } = {}) {
  const usage = weeklyUsage(user.id, effectivePolicy(user).weeklyBudget);
  const counts = navCounts(user);
  return {
    navItems: NAV_ITEMS.map(n => ({ ...n, count: counts[n.key] || 0 })),
    agent: agentState(user.id),
    counts: { approvals: pendingCount(user.id) },
    projects: listProjects(user.id).map(p => ({ ...projectView(p), active: p.thread_id === activeThreadId })),
    sideChats: sideThreads(user.id).map(t => ({ ...t, active: t.id === activeThreadId })),
    panel: { activity: activityDays(user, { days: 2, limit: 40 }), approvals: pendingFor(user), upcoming: upcomingPanel(user) },
    ringing: ringingFor(user).map(a => alarmView(a)),
    usage: { pct: usage.pct, label: usage.label, limited: usage.limited, spentLabel: usage.spentLabel },
  };
}
