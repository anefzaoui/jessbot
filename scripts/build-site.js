// Build the public website into _site/ (GitHub Pages publishes it: .github/workflows/pages.yml). No framework:
// website/ holds the page layout, the home page, the styles and one small script; everything else comes from the
// repository itself so the site never drifts from it: docs/guide/*.md (+ docs/INSTALL.md, docs/SECURITY-MODEL.md)
// become the docs pages, docs/images/ the screenshots and the gallery, docs/images/brand/ the icons, public/img/ Jess's
// portraits and her skies (the home page is "Jess's day", decision #249), the fonts (Anybody, Hanken Grotesk, Big Shoulders
// Stencil) and the Phosphor icons come from node_modules.
//   node scripts/build-site.js             build _site/
//   node scripts/build-site.js --serve     build, then serve it on http://127.0.0.1:8790 (local preview)
// SITE_URL (default https://anefzaoui.github.io/jessbot/) is the address pages give as canonical and in link previews;
// set it to the custom domain once there is one (see website/README.md). Every link inside the site is relative, so
// the same build works under /jessbot/ and at a domain's root.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'website');
const OUT = path.join(ROOT, '_site');
const REPO = 'https://github.com/anefzaoui/jessbot';
const SITE_URL = (process.env.SITE_URL || 'https://anefzaoui.github.io/jessbot/').replace(/\/?$/, '/');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The docs pages: source → output name, in the order the docs menu lists them.
const DOCS = [
  ['docs/guide/README.md', 'index'], ['docs/guide/getting-started.md', 'getting-started'], ['docs/INSTALL.md', 'install'],
  ['docs/guide/providers.md', 'providers'], ['docs/guide/name-and-look.md', 'name-and-look'],
  ['docs/guide/approvals-and-safety.md', 'approvals-and-safety'], ['docs/guide/people-and-admin.md', 'people-and-admin'],
  ['docs/guide/mail-and-calendar.md', 'mail-and-calendar'], ['docs/guide/feed.md', 'feed'], ['docs/guide/library.md', 'library'],
  ['docs/guide/backups-and-updates.md', 'backups-and-updates'], ['docs/guide/troubleshooting.md', 'troubleshooting'],
  ['docs/guide/faq.md', 'faq'], ['docs/SECURITY-MODEL.md', 'security-model'],
];
const DOC_OF = new Map(DOCS.map(([src, name]) => [path.normalize(src), name]));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'docs'), { recursive: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true }); fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to)); };

// ---- Assets -------------------------------------------------------------------------------------------------------
copy('website/styles.css', 'assets/styles.css');
copy('website/site.js', 'assets/site.js');
// The lightbox: Vitrine (https://github.com/anefzaoui/vitrine), vendored in website/vitrine/ at the commit its
// vitrine.lock.json pins, checked by scripts/vitrine-check.mjs (tests/site-vitrine.test.js).
for (const f of ['vitrine-core.js', 'vitrine.js', 'vitrine.css']) copy(`website/vitrine/${f}`, `assets/vitrine/${f}`);
copy('website/run-poster.webp', 'images/run-poster.webp'); // the recorded run's poster: its frame at 11.5 s, a still
copy('node_modules/@fontsource-variable/anybody/files/anybody-latin-standard-normal.woff2', 'assets/anybody.woff2');
copy('node_modules/@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2', 'assets/hanken-grotesk.woff2');
copy('node_modules/@fontsource-variable/big-shoulders-stencil/files/big-shoulders-stencil-latin-wght-normal.woff2', 'assets/big-shoulders-stencil.woff2');
for (const f of fs.readdirSync(path.join(ROOT, 'docs/images'))) if (/\.(webp|mp4)$/.test(f)) copy(`docs/images/${f}`, `images/${f}`);
for (const f of ['favicon.ico', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'social-preview.png', 'mark-128.webp', 'mark-256.webp']) copy(`docs/images/brand/${f}`, f.startsWith('favicon.') ? f : `images/${f}`);
for (const t of ['dawn', 'day', 'dusk', 'night']) copy(`public/img/scenes/${t}-clear.webp`, `images/sky-${t}.webp`);
copy('public/img/avatars/female/neutral.webp', 'images/jess.webp');
// Her portrait for each cue of the home page's day, and asleep for the curtain and the 404.
for (const [face, file] of [['reading', 'reading'], ['happy', 'happy'], ['listening', 'life-listening'], ['proud', 'proud'], ['sleepy', 'sleepy']])
  copy(`public/img/avatars/female/${file}.webp`, `images/jess-${face}.webp`);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(path.join(OUT, 'site.webmanifest'), JSON.stringify({
  name: 'Jessbot', short_name: 'Jessbot', start_url: './', display: 'browser', background_color: '#05060a', theme_color: '#05060a',
  icons: [{ src: 'images/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'images/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'images/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
}, null, 2));

// ---- Icons (Phosphor, the app's set): {{icon:name}} in templates and pages ----------------------------------------
const icon = name => fs.readFileSync(path.join(ROOT, 'node_modules/@phosphor-icons/core/assets/regular', `${name}.svg`), 'utf8')
  .replace('<svg ', '<svg class="icon" aria-hidden="true" focusable="false" ').trim();
const icons = html => html.replace(/\{\{icon:([a-z0-9-]+)\}\}/g, (_, n) => icon(n));

// A WebP's width and height from its header (VP8X, VP8L or VP8), so a picture keeps its place while it loads and the
// lightbox knows its size before it arrives.
function webpSize(file) {
  const b = fs.readFileSync(file);
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === 'VP8L') { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  return null;
}
const sizeOf = name => fs.existsSync(path.join(ROOT, 'docs/images', name)) ? webpSize(path.join(ROOT, 'docs/images', name)) : null;
const sizeAttrs = name => { const s = sizeOf(name); return s ? ` width="${s[0]}" height="${s[1]}"` : ''; };

// ---- Markdown → HTML, with links rewritten for the site ------------------------------------------------------------
const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
const slug = s => s.toLowerCase().replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');
md.core.ruler.push('anchors', state => {
  const seen = new Map();
  state.tokens.forEach((t, i) => {
    if (t.type !== 'heading_open') return;
    const base = slug(state.tokens[i + 1].content);
    const n = seen.get(base) || 0; seen.set(base, n + 1);
    t.attrSet('id', n ? `${base}-${n}` : base);
  });
});
// A link in a docs source file → where it goes on the site: another docs page, an image, or the file on GitHub.
function rewrite(href, srcFile) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [p, hash = ''] = href.split('#');
  const target = path.normalize(path.join(path.dirname(srcFile), p));
  const anchor = hash ? `#${hash}` : '';
  if (DOC_OF.has(target)) return `${DOC_OF.get(target)}.html${anchor}`;
  if (target.startsWith(path.normalize('docs/images/'))) return `../images/${path.basename(target)}`;
  const isDir = fs.existsSync(path.join(ROOT, target)) && fs.statSync(path.join(ROOT, target)).isDirectory();
  return `${REPO}/${isDir ? 'tree' : 'blob'}/main/${target.split(path.sep).join('/')}${anchor}`;
}
function renderDoc(srcFile) {
  const env = {};
  const tokens = md.parse(read(srcFile), env);
  for (const t of tokens) {
    for (const c of [t, ...(t.children || [])]) {
      if (c.type === 'link_open') c.attrSet('href', rewrite(c.attrGet('href'), srcFile));
      if (c.type === 'image') {
        c.attrSet('src', rewrite(c.attrGet('src'), srcFile)); c.attrSet('loading', 'lazy'); c.attrSet('decoding', 'async');
        const m = c.attrGet('src').match(/^\.\.\/images\/([\w.-]+\.webp)$/), s = m && sizeOf(m[1]);
        if (s) { c.attrSet('width', String(s[0])); c.attrSet('height', String(s[1])); }
      }
      if (c.type === 'link_open' && /^https?:/.test(c.attrGet('href')) && !c.attrGet('href').startsWith(SITE_URL)) c.attrSet('rel', 'noopener');
    }
  }
  let html = md.renderer.render(tokens, md.options, env);
  // A screenshot pair: the light picture is the one written; the dark one is shown instead in dark mode when it exists.
  html = html.replace(/<img src="\.\.\/images\/([\w-]+)-light\.webp"([^>]*)>/g, (m, base, rest) =>
    fs.existsSync(path.join(ROOT, 'docs/images', `${base}-dark.webp`))
      ? `<img class="only-light" src="../images/${base}-light.webp"${rest}><img class="only-dark" src="../images/${base}-dark.webp"${rest}>` : m);
  const title = (tokens.find((t, i) => t.type === 'inline' && tokens[i - 1]?.tag === 'h1')?.content) || 'Jessbot';
  const firstPara = tokens.find((t, i) => t.type === 'inline' && tokens[i - 1]?.type === 'paragraph_open' && !t.content.startsWith('!'));
  const description = (firstPara?.content || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`]/g, '').slice(0, 300);
  const toc = tokens.filter((t, i) => t.type === 'heading_open' && t.tag === 'h2').map(t => {
    const i = tokens.indexOf(t); return { id: t.attrGet('id'), text: tokens[i + 1].content.replace(/[*`]/g, '') };
  });
  return { html, title, description, toc };
}

// ---- Layout -------------------------------------------------------------------------------------------------------
const LAYOUT = fs.readFileSync(path.join(WEB, 'layout.html'), 'utf8');
function page({ file, title, description, body, root, current, bodyClass = '', head = '' }) {
  const url = SITE_URL + file.replace(/(^|\/)index\.html$/, '$1');
  const nav = (key, href, label, keep) => `<a href="${root}${href}"${current === key ? ' aria-current="page"' : ''}${keep ? ' data-keep' : ''}>${label}</a>`;
  const html = LAYOUT
    .replaceAll('{{title}}', esc(title)).replaceAll('{{description}}', esc(description)).replaceAll('{{url}}', esc(url))
    .replaceAll('{{site}}', esc(SITE_URL)).replaceAll('{{root}}', root).replaceAll('{{repo}}', REPO)
    .replace('{{bodyClass}}', bodyClass).replace('{{preload}}', () => head)
    .replace('{{nav}}', [nav('day', 'index.html#day', 'Her day'), nav('safety', 'index.html#safety', 'Safety'),
      nav('docs', 'docs/index.html', 'Docs', true), nav('gallery', 'gallery.html', 'Screenshots')].join(''))
    .replace('{{body}}', () => body);
  fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
  fs.writeFileSync(path.join(OUT, file), icons(html));
  return url;
}
const urls = [];

// Home page.
urls.push(page({ file: 'index.html', title: 'Jessbot: a self-hosted AI agent for your household',
  description: 'Jess keeps working after you close the app, day and night, and asks before she sends, spends or books anything. Free software you run on your own computer.',
  body: fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), root: '', current: 'home', bodyClass: 'home',
  // The sky and portrait for the visitor's hour start downloading with the stylesheet (the page's largest paint).
  head: `
<script>(function () { var q = (location.search.match(/[?&]cue=(night|dawn|day|dusk)/) || [])[1], h = new Date().getHours();
  var c = q || (h < 5 || h >= 21 ? 'night' : h < 9 ? 'dawn' : h < 17 ? 'day' : 'dusk');
  var f = { night: 'reading', dawn: 'happy', day: 'listening', dusk: 'proud' }[c];
  ['images/sky-' + c + '.webp', 'images/jess-' + f + '.webp'].forEach(function (u) { var l = document.createElement('link'); l.rel = 'preload'; l.as = 'image'; l.href = u; l.fetchPriority = 'high'; document.head.appendChild(l); });
})();</script>` }));

// The docs menu's short names.
const menuLabel = t => ({ 'Installing Jessbot': 'Install', 'Jessbot guide': 'Overview' })[t] || t.split(':')[0];
// Docs pages, with the docs menu and the page's own contents.
const docsMenu = (current) => `<nav class="docs-menu" aria-label="Guide pages"><p class="docs-menu-h">Guide</p><ul role="list">${DOCS.map(([src, name]) =>
  `<li><a href="${name}.html"${name === current ? ' aria-current="page"' : ''}>${esc(menuLabel(renderDoc(src).title))}</a></li>`).join('')}</ul></nav>`;
for (const [src, name] of DOCS) {
  const d = renderDoc(src);
  const toc = d.toc.length > 2 ? `<nav class="doc-toc" aria-label="On this page"><p class="docs-menu-h">On this page</p><ul role="list">${d.toc.map(t => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : '';
  const edit = `<p class="doc-source"><a href="${REPO}/blob/main/${src}">${icon('github-logo')} This page on GitHub</a></p>`;
  urls.push(page({ file: `docs/${name}.html`, title: `${d.title} · Jessbot`, description: d.description || `${d.title}: the Jessbot guide.`,
    body: `<div class="docs-wrap">${docsMenu(name)}<article class="doc prose" id="main">${d.html}${edit}</article>${toc}</div>`, root: '../', current: 'docs', bodyClass: 'docs' }));
}

// Gallery: every screenshot, desktop then phone, in the visitor's theme.
const LABELS = { chat: 'Chat', 'chat-background': 'Work in the background', 'chat-real': 'Answers with their sources (real install)', approvals: 'Approvals',
  'approval-real': 'An approval from a real run', feed: 'Feed', ideas: 'Ideas', goals: 'Goals', goal: 'A goal and its plan', library: 'Library',
  'library-item': 'A Library page', lists: 'Lists', list: 'A shared list', upcoming: 'Upcoming', projects: 'Projects', project: 'A project',
  activity: 'Activity', you: 'You', 'you-memory': 'You → Memory', 'admin-people-real': 'Admin → People (real install)', 'admin-overview': 'Admin → Overview',
  'admin-models': 'Admin → Models', 'admin-skills': 'Admin → Skills', 'admin-usage': 'Admin → Usage', 'setup-account': 'Setup: your account',
  'setup-model': 'Setup: the model', 'setup-browser': 'Setup: the internet', 'setup-identity': 'Setup: who your agent is', 'setup-people': 'Setup: people' };
const shots = fs.readdirSync(path.join(ROOT, 'docs/images')).filter(f => /-(desktop|phone)-light\.webp$/.test(f) && !f.includes('-main-')); // -main-: the home page's crops
const fig = f => {
  const [, base, device] = f.match(/^(.+)-(desktop|phone)-light\.webp$/);
  const dark = fs.existsSync(path.join(ROOT, 'docs/images', `${base}-${device}-dark.webp`));
  const label = LABELS[base] || base;
  const img = (t, cls) => `<a href="images/${base}-${device}-${t}.webp"${cls}><img src="images/${base}-${device}-${t}.webp"${sizeAttrs(`${base}-${device}-${t}.webp`)} alt="${esc(label)}, ${device === 'phone' ? 'on a phone' : 'on a desktop'}, ${t} theme" loading="lazy" decoding="async"></a>`;
  return `<figure class="shot shot-${device}">${dark ? img('light', ' class="only-light"') + img('dark', ' class="only-dark"') : img('light', '')}<figcaption>${esc(label)}</figcaption></figure>`;
};
const order = Object.keys(LABELS);
const sorted = device => shots.filter(f => f.includes(`-${device}-`)).sort((a, b) => order.indexOf(a.replace(/-(desktop|phone)-light\.webp$/, '')) - order.indexOf(b.replace(/-(desktop|phone)-light\.webp$/, '')));
urls.push(page({ file: 'gallery.html', title: 'Screenshots · Jessbot', description: 'Every screen of Jessbot, on a desktop and on a phone, in your light or dark theme.',
  body: `<main id="main" class="gallery-page"><header class="page-head"><h1>Screenshots</h1>
    <p>Every main screen, shown in your theme (switch it at the top). The setup wizard, Admin → People and the approval run come from a real install with made-up people; the other screens are the app's own pages with its built-in demo household, because a new install has no weeks of history to show. Click any picture for the full size.</p></header>
    <h2>On a desktop</h2><div class="shots shots-desktop" data-lightbox>${sorted('desktop').map(fig).join('')}</div>
    <h2>On a phone</h2><div class="shots shots-phone" data-lightbox>${sorted('phone').map(fig).join('')}</div></main>`, root: '', current: 'gallery', bodyClass: 'gallery' }));

// 404, sitemap, robots.
page({ file: '404.html', title: 'Not found · Jessbot', description: 'This page does not exist.', root: './', current: '', bodyClass: 'lost',
  body: `<main id="main" class="page-head notfound"><img class="sleeping" src="./images/jess-sleepy.webp" alt="" width="1024" height="1024"><h1>That page isn't here</h1><p>Jess looked everywhere. It may have moved when the guide was reorganized.</p><p><a class="btn btn-primary" href="./index.html">Go to the home page</a> <a class="btn" href="./docs/index.html">Open the guide</a></p></main>` });
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`);
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);

let files = 0, bytes = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } })(OUT);
console.log(`site: ${urls.length} pages, ${files} files, ${(bytes / 1048576).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`);

if (process.argv.includes('--serve')) {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.xml': 'application/xml', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
  const port = Number(process.env.PORT_SITE || 8790);
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(OUT, path.normalize(p).replace(/^([\\/]\.\.)+/, ''));
    if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': TYPES['.html'] }); return res.end(fs.readFileSync(path.join(OUT, '404.html'))); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${port}/`));
}
