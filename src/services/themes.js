// One theme table for everything Jess makes (decision #132): Word, Excel, PowerPoint and PDF read their colours and
// fonts from here, by role, so a deck and the PDF handout made from it match.
//
// Palettes adapted from Anthropic's theme-factory skill (Apache-2.0, Copyright 2026 Anthropic, PBC; licence in
// themes-LICENSE.txt next to this file). Modified: each four-colour palette is re-cast into roles, colours that failed
// WCAG contrast were darkened (Tech Innovation's neon cyan on white, Arctic Frost's silver on ice, the light oranges and
// mustards used as text), and the Linux-only fonts (DejaVu, FreeSans, FreeSerif) are mapped to fonts Office has
// everywhere for office files and to the bundled Noto fonts for PDFs. 'jess' is our own: the Harbor look (DESIGN.md).
//
// Roles (6-digit hex, no '#', as pptxgenjs and docx want them):
//   paper    page / slide background          ink      body text on paper (>= 4.5:1)
//   muted    secondary text on paper (>= 4.5:1) accent  headings, links, rules on paper (>= 4.5:1)
//   accent2  large numbers, chart series, quote bars (>= 3:1 on paper: large text / graphics only)
//   tint     light fill behind ink (table headers, cards; ink >= 4.5:1 on it)   line  hairlines and borders
//   dark     title and closing slides           onDark / onDarkMuted  text on dark (>= 4.5:1)
//   headFont / bodyFont  PDF fonts (bundled: 'Noto Sans' or 'Noto Serif', see services/fonts.js)
//   officeFonts { head, body }  fonts every Office install has (and Google Docs maps)

export const THEMES = {
  jess: { name: 'Jess (Harbor)', suits: 'anything; calm slate with a deep sea-teal accent',
    paper: 'FFFFFF', ink: '0F171E', muted: '464E55', accent: '00717C', accent2: '33969B', tint: 'E0F5F7', line: 'DBE2E7',
    dark: '0A232C', onDark: 'F4F8FA', onDarkMuted: 'B7C9CF', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Calibri', body: 'Calibri' } },
  ocean: { name: 'Ocean Depths', suits: 'finance, reports, consulting, anything that should feel trustworthy',
    paper: 'FFFFFF', ink: '1A2332', muted: '4A5568', accent: '1F6E6E', accent2: '2D8B8B', tint: 'E4F4F4', line: 'CFE3E4',
    dark: '1A2332', onDark: 'F1FAEE', onDarkMuted: 'A8DADC', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Calibri', body: 'Calibri' } },
  sunset: { name: 'Sunset Boulevard', suits: 'events, invitations, creative pitches, lifestyle',
    paper: 'FFFFFF', ink: '264653', muted: '4F5D63', accent: 'A8432A', accent2: 'D9603F', tint: 'FBEEE2', line: 'F0D9C4',
    dark: '264653', onDark: 'FDF6EC', onDarkMuted: 'F4C9A0', headFont: 'Noto Serif', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Georgia', body: 'Calibri' } },
  forest: { name: 'Forest Canopy', suits: 'nature, gardening, wellness, sustainability',
    paper: 'FAF9F6', ink: '1F2A1E', muted: '4E5645', accent: '2D4A2B', accent2: '6B7560', tint: 'ECEEE3', line: 'D8DCC8',
    dark: '2D4A2B', onDark: 'FAF9F6', onDarkMuted: 'C9CFB2', headFont: 'Noto Serif', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Cambria', body: 'Calibri' } },
  minimal: { name: 'Modern Minimalist', suits: 'work documents, proposals, data, anything plain',
    paper: 'FFFFFF', ink: '222B31', muted: '505C66', accent: '36454F', accent2: '708090', tint: 'EFF1F3', line: 'D3D3D3',
    dark: '36454F', onDark: 'FFFFFF', onDarkMuted: 'CDD4DA', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Arial', body: 'Arial' } },
  golden: { name: 'Golden Hour', suits: 'food, recipes, hospitality, autumn, cosy family things',
    paper: 'FFFFFF', ink: '4A403A', muted: '675B52', accent: '9C4449', accent2: 'B07A00', tint: 'F7EFE4', line: 'E6D5BE',
    dark: '4A403A', onDark: 'FBF6EE', onDarkMuted: 'E8CFA6', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Calibri', body: 'Calibri' } },
  arctic: { name: 'Arctic Frost', suits: 'health, school, science, clean technical documents',
    paper: 'FAFAFA', ink: '1E2A3A', muted: '4B5768', accent: '3F6395', accent2: '5B7FB0', tint: 'E6EEF8', line: 'C9D6E6',
    dark: '24364F', onDark: 'F3F7FC', onDarkMuted: 'C3D3E8', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Calibri', body: 'Calibri' } },
  rose: { name: 'Desert Rose', suits: 'weddings, celebrations, fashion, interiors',
    paper: 'FFFFFF', ink: '3D1F2E', muted: '634A55', accent: '5D2E46', accent2: 'A0635A', tint: 'F6ECE6', line: 'E8D5C4',
    dark: '5D2E46', onDark: 'FBF3EE', onDarkMuted: 'E6C3C0', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Georgia', body: 'Calibri' } },
  tech: { name: 'Tech Innovation', suits: 'technology, product launches, bold modern decks',
    paper: 'FFFFFF', ink: '1E1E1E', muted: '4D4D4D', accent: '0057D9', accent2: '00879A', tint: 'E6F0FF', line: 'CCDDF5',
    dark: '1E1E1E', onDark: 'FFFFFF', onDarkMuted: '8FE3F0', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Arial', body: 'Arial' } },
  garden: { name: 'Botanical Garden', suits: 'gardens, food, farms, natural and fresh topics',
    paper: 'FFFDF8', ink: '26352A', muted: '4F5A50', accent: '3D6B4B', accent2: 'B7472A', tint: 'F2EFE4', line: 'E0DACB',
    dark: '2F4F3A', onDark: 'F5F3ED', onDarkMuted: 'F2C98A', headFont: 'Noto Serif', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Georgia', body: 'Calibri' } },
  galaxy: { name: 'Midnight Galaxy', suits: 'games, parties, night events, entertainment',
    paper: 'FFFFFF', ink: '2B1E3E', muted: '514763', accent: '4A4E8F', accent2: '7A64A8', tint: 'EEEBF6', line: 'D9D3EA',
    dark: '2B1E3E', onDark: 'F2F2FC', onDarkMuted: 'C3B6DD', headFont: 'Noto Sans', bodyFont: 'Noto Sans',
    officeFonts: { head: 'Calibri', body: 'Calibri' } },
};

export const THEME_IDS = Object.keys(THEMES);
export const DEFAULT_THEME = 'jess';

/** A theme by id (unknown or missing → the default), with its id attached. */
export const themeOf = id => ({ id: THEMES[id] ? id : DEFAULT_THEME, ...(THEMES[id] || THEMES[DEFAULT_THEME]) });

/** Chart / series colours for a theme: its two accents first, then quieter roles. */
export const seriesColors = t => [t.accent2, t.accent, t.muted, t.dark, t.onDarkMuted, t.line];

/** One line per theme for tool descriptions ("jess: anything; …"). */
export const themeMenu = () => THEME_IDS.map(id => `${id} (${THEMES[id].suits})`).join('; ');

// ---- WCAG 2.x contrast (relative luminance of sRGB) ----------------------------------------------------------------
const channel = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = hex => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
