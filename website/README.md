# The website

Jessbot's public site: the home page, the user guide (`docs/guide/`) rendered as pages, and a screenshot gallery. It is
static, with no framework: `scripts/build-site.js` puts it together into `_site/` (git-ignored), and GitHub Pages
publishes it from `.github/workflows/pages.yml`.

| File | What it is |
|---|---|
| `layout.html` | the page frame every page shares: head, header, footer |
| `index.html` | the home page's content |
| `styles.css` | every style, on the app's own tokens (Harbor colours, Geist; see `docs/DESIGN.md`) |
| `site.js` | the theme switch, the sky that follows the visitor's clock, the demo approval card, copy buttons, install tabs |

Everything else comes from the repository, so the site can't drift from it: the docs pages from `docs/guide/*.md`,
`docs/INSTALL.md` and `docs/SECURITY-MODEL.md`; the screenshots and the recorded run from `docs/images/` (made by
`scripts/docs-shots.js`); the logo and icons from `docs/images/brand/` (`scripts/build-brand.js`); Jess and her sky from
`public/img/`; the Geist font and the Phosphor icons from `node_modules`, as in the app. Links between docs pages are
rewritten to the site's pages, and links to other files in the repository point at them on GitHub.

## Build and preview

```bash
npm ci
node scripts/build-site.js --serve     # http://127.0.0.1:8790
```

Check a change at 360, 768 and 1280 pixels wide, in light and dark (the moon and sun button in the header switches
the theme; the hero's sky depends on your clock). Every link inside the site is relative, so the same build works at
`https://<owner>.github.io/jessbot/` and at the root of a domain.

## Publishing

Pushes to `main` that touch the site, the docs or the images publish it; pull requests that touch them only build it.
The first time, the repository's Pages source has to be set once: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The site is then at `https://<owner>.github.io/jessbot/`.

## A custom domain later

1. **DNS.** For a subdomain such as `www.example.org` or `jessbot.example.org`, add a `CNAME` record pointing to
   `<owner>.github.io`. For the bare domain `example.org`, add `A` records to `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153` and `185.199.111.153` (and, for IPv6, `AAAA` records to `2606:50c0:8000::153`, `2606:50c0:8001::153`,
   `2606:50c0:8002::153` and `2606:50c0:8003::153`). Check GitHub's current list in its Pages documentation first.
2. **GitHub.** Settings → Pages → Custom domain: enter the domain and save. GitHub checks the DNS; then tick **Enforce
   HTTPS** once the certificate is ready. Verifying the domain for your account (Settings → Pages under your profile)
   stops anyone else from claiming it.
3. **The site's address.** Set a repository variable `SITE_URL` (Settings → Secrets and variables → Actions →
   Variables) to the new address, such as `https://jessbot.example.org/`, so canonical links, the sitemap and link
   previews use it. Then run the Pages workflow again.

With a workflow-published site, the domain lives in the repository's Pages settings; a `CNAME` file in the repository
is not needed (GitHub reads one only when publishing from a branch). If you'd like one anyway, as a record, put it in
`website/` and copy it to `_site/` in the build.
