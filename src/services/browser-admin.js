// Admin → Browser's second half (Phase 25, decision #195): what Jess's browser has learned and switched off on its own, and the
// office previews setting. Ad blocking's per-site switch (browser/adblock.js), which deep-link recipes still work (the
// `npm run links:check` state, browser/links.js), the results-page recipes learned from her own searches (browser/recipes.js),
// and where LibreOffice is (services/office-render.js). Each can be undone here; nothing here reaches the web.
import fs from 'node:fs';
import { all, get, run, settings } from '../db/index.js';
import { sitesSwitchedOff, switchOnFor } from '../browser/adblock.js';
import { browserSettings } from '../browser/index.js';
import { loadLinkState } from '../browser/links.js';
import { shapeOf } from '../browser/recipes.js';
import { SITES, SITE_KEYS } from '../lib/deeplinks.js';
import { officeRenderStatus, findSoffice } from './office-render.js';
import { invalid, notFound } from '../lib/errors.js';
import { toIso } from './chatview.js';

const LINK_STATUS = { ok: 'Works', broken: 'Switched off', blocked: 'Blocked here', error: 'Couldn’t check' };
const AREA_LABEL = { flights: 'Flights', flight_deals: 'Flight deals', stays: 'Stays', places: 'Maps', shopping: 'Shops', jobs: 'Jobs', events: 'Events',
  parcels: 'Parcels', scholarly: 'Papers' };

/** Everything the second half of the page shows (contract: partials/admin/browser-extras.hbs). */
export function browserExtras() {
  const state = loadLinkState();
  const links = SITE_KEYS.map(key => {
    const s = state.sites?.[key];
    return { key, label: SITES[key].label, area: AREA_LABEL[SITES[key].area] || SITES[key].area, status: s?.status || 'unchecked',
      statusLabel: s ? LINK_STATUS[s.status] || s.status : 'Not checked yet', at: s?.at || null, detail: s?.detail || null };
  });
  const recipes = all('SELECT * FROM site_recipes ORDER BY host, ok_count DESC').map(r => ({
    id: r.id, host: r.host.replace(/^www\d*\./, ''), shape: shapeOf(r), okCount: r.ok_count, failCount: r.fail_count, lastOkAt: toIso(r.last_ok_at),
  }));
  const office = officeRenderStatus();
  const cfg = settings.get('office', {}) || {};
  return {
    blockAds: !!browserSettings().blockAds, adblockOff: sitesSwitchedOff(),
    links: { checkedAt: state.checkedAt || null, sites: links, counts: {
      ok: links.filter(l => l.status === 'ok').length, broken: links.filter(l => l.status === 'broken').length,
      blocked: links.filter(l => l.status === 'blocked').length, unchecked: links.filter(l => l.status === 'unchecked').length } },
    recipes,
    office: { ...office, previews: cfg.previews !== false, soffice: cfg.soffice || '' },
  };
}

/** Forget one learned recipe (Jess falls back to the site's own search form there). → the removed row's host. */
export function deleteRecipe(id) {
  const r = get('SELECT * FROM site_recipes WHERE id = ?', Number(id));
  if (!r) throw notFound('That recipe is already gone.');
  run('DELETE FROM site_recipes WHERE id = ?', r.id);
  return r.host;
}

/** Turn ad blocking back on for a site it was switched off for. */
export function allowBlockingAgain(host) {
  if (!switchOnFor(String(host || ''))) throw notFound('Blocking is already on for that site.');
}

/** Office previews: { previews: bool, soffice: path | '' }. A path must be a file that exists (a wrong one isn't saved). */
export function saveOfficeSettings({ previews, soffice } = {}) {
  const path = String(soffice ?? '').trim();
  if (path) {
    let st = null;
    try { st = fs.statSync(path); } catch { /* checked below */ }
    if (!st?.isFile()) throw invalid({ soffice: 'There’s no file at that path. Point it at soffice (soffice.exe on Windows), or leave it empty to find it.' });
  }
  const next = { ...(settings.get('office', {}) || {}), previews: previews !== false && previews !== 'false' };
  if (path) next.soffice = path; else delete next.soffice;
  settings.set('office', next);
  findSoffice({ refresh: true });
  return { ...officeRenderStatus(), previews: next.previews, soffice: next.soffice || '' };
}
