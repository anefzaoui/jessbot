// Jessbot's website: the theme switch (guide and gallery), the home page's stage (Jess through a day, decision #249),
// the recorded run with its timetable, copy buttons and the install tabs. Everything reads without it; it adds motion
// and behaviour, and holds still when the visitor asks for less motion.
(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

  // Theme: the system's unless the visitor picked one here. The home page is the whole day, so it has no switch.
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const toggle = document.querySelector('[data-theme-toggle]');
  const label = () => toggle?.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  toggle?.addEventListener('click', () => { root.dataset.theme = isDark() ? 'light' : 'dark'; store.set('jb-site-theme', root.dataset.theme); label(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', label);
  label();

  // ---- The stage ----------------------------------------------------------------------------------------------------
  const stage = document.getElementById('stage');
  if (stage) {
    const CUE_MS = 6000;
    const cues = {
      night: { no: 'Q1', time: '02:10', name: 'Night', line: "You're asleep. I'm comparing the three venues you liked, so the draft is ready by seven.", state: 'Reading venue pages · nothing will be sent' },
      dawn: { no: 'Q2', time: '06:40', name: 'First light', line: 'Morning, Alex. Your feed is written: the rail strike, two book picks, and rain from five.', state: 'Done · 6 stories, 1 weather note' },
      day: { no: 'Q3', time: '12:30', name: 'Day', line: 'I found an easy hike near Lyon and wrote to Maya. Shall I send it?', state: 'Waiting for your OK · an email can’t be recalled once it’s sent', ask: true },
      dusk: { no: 'Q4', time: '18:40', name: 'Dusk', line: "Bins go out tonight. I'll nudge you again at eight unless you tell me it's done.", state: 'Reminder · nudge 1 of 3' },
    };
    const order = ['night', 'dawn', 'day', 'dusk'];
    const $ = s => stage.querySelector(s);
    const line = $('[data-line]'), state = $('[data-state]'), ask = $('[data-ask]'), wrap = $('.line-wrap');
    // Her line arrives like a message: restart the arrival (styles.css, .line-wrap.swap) on every change.
    const arrive = () => { if (reduce) return; wrap.classList.remove('swap'); void wrap.offsetWidth; wrap.classList.add('swap'); };
    const buttons = [...stage.querySelectorAll('[data-go]')];
    let current = stage.dataset.cue || 'night', timer = null, touched = false;

    const show = (name, fromUser, first) => {
      const c = cues[name]; if (!c) return;
      current = name; stage.dataset.cue = name;
      $('[data-cue-no]').textContent = c.no; $('[data-cue-time]').textContent = c.time; $('[data-cue-name]').textContent = c.name;
      line.textContent = c.line; state.textContent = c.state;
      ask.hidden = !c.ask;
      if (!first) arrive(); // the first cue is already on the page as it was painted
      buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.go === name)));
      if (fromUser) stop();
    };
    const play = () => {
      if (reduce || touched) return;
      stage.style.setProperty('--cue-ms', `${CUE_MS}ms`); stage.classList.add('playing');
      clearInterval(timer); timer = setInterval(() => show(order[(order.indexOf(current) + 1) % order.length]), CUE_MS);
    };
    const stop = () => { touched = true; clearInterval(timer); stage.classList.remove('playing'); };

    buttons.forEach(b => b.addEventListener('click', () => show(b.dataset.go, true)));
    ask.addEventListener('click', e => {
      const a = e.target.closest('[data-answer]'); if (!a) return;
      stop(); ask.hidden = true;
      if (a.dataset.answer === 'yes') { line.textContent = 'Sent to Maya at 12:31. It’s in Activity with the exact text.'; state.textContent = 'Approved by you · sent (in the app; nothing left this page)'; }
      else { line.textContent = "I won't send it. The draft stays in the chat if you change your mind."; state.textContent = 'Not sent'; }
      arrive();
    });
    stage.querySelector('.surtitles').addEventListener('focusin', stop);
    // The cues pause while the stage is off screen; once the visitor has taken over, they stay where they put them.
    new IntersectionObserver(([en]) => { if (en.isIntersecting) play(); else { clearInterval(timer); stage.classList.remove('playing'); } }, { threshold: 0.3 }).observe(stage);

    show(current, false, true);
    // The other three skies and portraits load once the page has; each is lit only once it has arrived.
    const rest = () => stage.querySelectorAll('img[data-src]:not([src])').forEach(img => {
      const ready = () => { img.dataset.ready = ''; };
      img.addEventListener('load', () => img.decode().then(ready, ready), { once: true });
      img.decoding = 'async'; img.src = img.dataset.src;
    });
    if (document.readyState === 'complete') rest(); else addEventListener('load', rest, { once: true });
  }

  // ---- The recorded run: loads when it comes near, plays while it's on screen, its timetable follows ---------------
  const video = document.querySelector('[data-video]');
  if (video) {
    const items = [...document.querySelectorAll('[data-timetable] li')];
    const btn = document.querySelector('[data-film-toggle]');
    const load = () => { const s = video.querySelector('source[data-src]'); if (s && !s.getAttribute('src')) { s.src = s.dataset.src; video.load(); } };
    if (reduce) { video.controls = true; new IntersectionObserver(([en], o) => { if (en.isIntersecting) { load(); o.disconnect(); } }, { rootMargin: '400px' }).observe(video); }
    else {
      btn.hidden = false;
      let paused = false;
      btn.addEventListener('click', () => { paused = !paused; btn.setAttribute('aria-pressed', String(paused)); btn.textContent = paused ? 'Play' : 'Pause'; if (paused) video.pause(); else video.play().catch(() => {}); });
      new IntersectionObserver(([en]) => { if (en.isIntersecting) { load(); if (!paused) video.play().catch(() => {}); } else video.pause(); }, { threshold: 0.35 }).observe(video);
    }
    video.addEventListener('timeupdate', () => {
      let on = 0; items.forEach((li, i) => { if (video.currentTime >= Number(li.dataset.at)) on = i; });
      items.forEach((li, i) => { li.classList.toggle('on', i === on); li.classList.toggle('past', i < on); });
    });
  }

  // ---- Copy buttons: the command in the field they point at ---------------------------------------------------------
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy]'); if (!btn) return;
    const src = document.querySelector(btn.dataset.copy);
    const text = src?.value ?? src?.textContent ?? '';
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; btn.dataset.done = ''; }
    catch { src?.select?.(); btn.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { btn.textContent = 'Copy'; delete btn.dataset.done; }, 2000);
  });

  // ---- Pictures, big: the gallery, the home page's screenshots and the guide's open over the page -------------------
  // SiteKit's lightbox (website/kit/, synced from Mister Download Manager's site, README there): it flies the picture
  // from where it is, goes through its group by arrows, keys and swipes, zooms by click, double tap, pinch or wheel,
  // and closes by Escape, Back, a click beside it or a swipe down. The site's English words; the theme's version of
  // each picture is the one shown. A gallery link still opens the full picture with no script.
  if (window.SiteKit && SiteKit.lightbox) {
    SiteKit.setStrings({ viewer: 'Screenshot viewer', close: 'Close', prev: 'Previous screenshot', next: 'Next screenshot',
      zoomIn: 'Zoom in', zoomOut: 'Zoom out', counter: '{n} of {total}' });
    SiteKit.lightbox.init({ auto: '.prose' });
  }

  // ---- Install tabs (arrow keys move between them, mirrored in right-to-left) ---------------------------------------
  for (const tabs of document.querySelectorAll('[data-tabs]')) {
    const list = [...tabs.querySelectorAll('[role="tab"]')];
    const show = tab => list.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    tabs.addEventListener('click', e => { const t = e.target.closest('[role="tab"]'); if (t) show(t); });
    tabs.addEventListener('keydown', e => {
      const i = list.indexOf(document.activeElement);
      if (i < 0 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const fwd = (e.key === 'ArrowRight') !== (getComputedStyle(tabs).direction === 'rtl');
      const next = list[(i + (fwd ? 1 : list.length - 1)) % list.length];
      show(next); next.focus();
    });
  }
})();
