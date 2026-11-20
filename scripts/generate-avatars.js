// Generates the Jessbot android avatar set and the scene backgrounds via OpenRouter (OpenAI image model).
//
// Avatars (transparent PNG cut-outs):
//   node scripts/generate-avatars.js --variant all --state all          # fill in anything missing
//   node scripts/generate-avatars.js --variant male --state happy --force
//   node scripts/generate-avatars.js --variant female --state neutral --force --ref path/to/identity.png
//
// Backgrounds (opaque square 1:1 skyscapes composed for a circle crop, assets/backgrounds/<time>-<weather>.png):
//   node scripts/generate-avatars.js --backgrounds --time all --weather all
//   node scripts/generate-avatars.js --backgrounds --time night --weather rain --force
//
// Options:
//   --variant female|male|neutral|all   (default all)
//   --state   <name>|all|life            (default all = the 13 expressions; "neutral" is always generated first: it is the
//                                        reference; "life" = the 4 same-pose idle-animation frames life-blink/-glance-left/...)
//   --ref <png>                          identity reference for a variant's neutral base (e.g. an approved earlier pilot)
//   --backgrounds                        scene mode; with --time dawn|day|dusk|night|all and --weather <name>|all
//   --covers                             dev-feed cover images (3:2) into assets/covers/; with --cover <name>|all
//   --force                              regenerate even if the PNG exists
//   --extra "<text>"                     extra prompt text appended for this run (recorded in the manifest)
//   --model <id> / --quality low|medium|high   override the defaults below
//
// Avatars are requested with a transparent background; the raw output is kept as <state>.orig.png and
// <state>.png gets the deterministic matte cleanup from scripts/clean-avatar-alpha.js.
// The key is read from .env (OPENROUTER_KEY) and is never printed.
// Non-neutral states send the variant's neutral.png as a reference image so the identity stays the same.
// Non-anchor scenes send day-clear.png as a reference so the camera, horizon height and silhouette stay the same.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { cleanAvatarFile, origPathFor } from './clean-avatar-alpha.js';

// ---- Config ----------------------------------------------------------------
const MODEL = 'openai/gpt-image-2.5-flare';
const QUALITY = 'high';
const ENDPOINT = 'https://openrouter.ai/api/v1/images';
const DELAY_MS = 1500;           // pause between requests
const MAX_ATTEMPTS = 5;          // per request, for 429 / 5xx / network errors
const MAX_COST_PER_IMAGE = 0.25; // abort the run if a single image costs more than this (USD)
const MAX_TOTAL_COST = 12;       // abort if avatars + backgrounds spend would pass this (USD)

// ---- Avatar prompts ----------------------------------------------------------
// Art direction v5: the v4 character (distinctive original face, luminous aperture irises) with visible,
// elegant construction lines on the skin: forehead/hairline, temple seam + indicator, neck panel lines,
// collarbone/shoulder joint lines. Transparent background and neutral lighting so it sits on any scene.
// Every face is a deliberately distinctive, original character; never name or reference a real person here.
const ART_DIRECTION = 'v5-lines';

const BASE_PROMPT = [
  'Photorealistic head-and-shoulders portrait of a breathtakingly beautiful humanoid android: the flagship model of a luxury consumer-robotics brand.',
  'Refined, elegant, magazine-cover quality; a premium product its owner would be proud of.',
  'An original character with a distinctive, original face that does not resemble any real person or celebrity.',
  'The eyes are a hero feature: a subtle luminous ring glowing around the edge of each iris, and a fine mechanical aperture detail in the pupils,',
  'like the delicate blades of a tiny camera iris diaphragm, with precise radial detail in the irises. Beautiful and captivating, not scary.',
  'Flawless, realistic skin with a subtle satin smoothness, clearly showing elegant robotic construction lines, like finely machined seams on a luxury product:',
  'fine, precise seam lines tracing across the forehead and running along the hairline;',
  'a panel seam at the temple with one tiny soft-glowing indicator light set into it;',
  'two or three clean vertical and diagonal panel lines running down each side of the neck;',
  'subtle articulation seams at the collarbones and around the shoulder joint where the neckline shows skin;',
  'and a faint seam along the jawline.',
  'The seams are crisp, thin and clearly readable even at small avatar size, with a whisper of pearl-white material visible inside some of them.',
  'The lines are on the skin only: no white chassis plates, no robotic ears, no exposed machinery, no wires, no chrome.',
  'Lighting: soft, neutral, cinematic studio lighting: a soft key light from the front-left, a gentle neutral fill, and a subtle neutral-white rim light; no coloured light spill.',
  'Background: fully transparent. An isolated cut-out portrait with no backdrop, no floor, no cast shadow behind the subject, and clean, precise hair edges.',
  'Composition: square image, subject centered and facing the camera directly, head and shoulders filling about 70% of the frame, eyes on the upper third line, medium close-up.',
  'The whole head is inside the frame, with a clear margin above the top of the head (the top of the hair sits roughly one tenth of the image height below the top edge); the head is not cropped.',
].join(' ');

const VARIANTS = {
  female:
    'The android is woman-presenting, appearing around 30, with fair, warm-toned skin and a light dusting of freckles across the nose and cheeks, and a small beauty mark high on her left cheekbone. ' +
    'Striking amber-gold eyes (matching the luminous iris rings), slightly wide-set and gently upturned; a soft oval face with a rounded chin, a delicate slightly upturned nose, softly defined natural brows and naturally full lips in a soft coral-rose tone. ' +
    'Glossy deep copper-auburn hair in a sleek, polished chin-length bob with a soft side part and a gentle inward curve at the ends. ' +
    'She wears an elegant, minimal ivory silk top with a clean, simple rounded neckline that shows the collarbones.',
  male:
    'The android is man-presenting, appearing in his mid-30s, with rich, warm deep-brown skin and a small beauty mark just below his right eye. ' +
    'Striking pale green-grey eyes (matching the luminous iris rings), straight strong brows, high cheekbones, a broad calm mouth and a defined jaw; clean-shaven. ' +
    'Short, neat black twists on top with tapered, clean-cut sides. ' +
    'He wears an elegant, minimal dark charcoal fine-knit sweater with a clean, open crew neckline that shows the collarbones.',
  neutral:
    'The android is gender-neutral and truly androgynous, appearing in their late 20s, with light warm-beige skin and faint freckles across the nose. ' +
    'Striking pale violet-grey eyes (matching the luminous iris rings), straight, fairly strong brows set low over the eyes, a balanced face with a squarer defined jaw and a slightly stronger chin, a straight nose, thin natural lips, short natural lashes, no makeup; ' +
    'a truly androgynous face in the space between masculine and feminine, which reads as neither clearly male nor female. ' +
    'Sleek silvery-platinum hair in a precise, softly asymmetric short crop. ' +
    'They wear an elegant, minimal deep slate-grey fine-knit top with a clean, wide neckline that shows the collarbones.',
};

const STATES = {
  neutral: 'a calm, composed, serene resting expression, mouth closed, eyes looking directly into the camera with a poised, gentle warmth',
  happy: 'a warm, genuine smile with the eyes slightly crinkled, looking into the camera',
  focused: 'concentrating intently: a slight brow furrow, lips gently pressed together, eyes looking straight ahead with focus, as if busy working on a task',
  thinking: 'pondering: eyes looking up and off to one side, lips slightly pursed, a thoughtful, contemplative expression',
  curious: 'curious and interested: head slightly tilted to one side, eyebrows gently raised, a small intrigued half-smile, looking into the camera',
  reading: 'reading: eyes looking down as if reading a page or screen just below the frame, eyelids lowered, a calm attentive expression, head angle almost unchanged',
  confused: 'puzzled: one eyebrow raised and the other slightly lowered, mouth slightly skewed to one side, a perplexed look',
  surprised: 'surprised: eyebrows raised high, eyes wide open, mouth slightly open in a small "oh"',
  concerned: 'gently worried and caring: inner eyebrows slightly raised and drawn together, a soft slight frown, looking into the camera as if asking for input',
  proud: 'satisfied and accomplished: a confident closed-mouth smile, chin very slightly raised, bright eyes, looking into the camera',
  apologetic: 'sheepish and apologetic: an awkward small smile with pressed lips, eyebrows tilted up in the middle, gaze slightly lowered',
  excited: 'bright, energetic and excited: a big open smile showing teeth, eyes wide and sparkling, eyebrows raised',
  sleepy: 'drowsy and sleepy: heavy eyelids half-closed, a relaxed soft mouth, a peaceful resting look',
};

// "Life frames": same pose as neutral.png, for idle animation by crossfading (blinks, glances, listening).
// Selected with --state life (or by name); not part of --state all.
const LIFE_FRAMES = {
  'life-blink': 'the eyes fully closed in a natural, relaxed blink (upper eyelids down, lashes resting), everything else identical',
  'life-glance-left': "the eyes glancing to the character's own left (toward the viewer's right side of the image); only the irises move, the head does not turn",
  'life-glance-right': "the eyes glancing to the character's own right (toward the viewer's left side of the image); only the irises move, the head does not turn",
  'life-listening': 'an attentive, warm listening look: eyes on the viewer, a very slight head tilt, lips softly closed, a gentle hint of warmth',
};

function basePrompt(variant, extra, identityRef) {
  const pre = identityRef
    ? 'The attached reference image shows this exact original android character. Keep the same face and identity, the same hair, skin, freckles and beauty mark, the same eyes and the same top, ' +
      'but render the portrait according to the full description below, including the robotic construction lines, the lighting and the transparent background. '
    : '';
  return `${pre}${BASE_PROMPT} ${VARIANTS[variant]} Facial expression: ${STATES.neutral}.${extra ? ' ' + extra : ''}`;
}

function lifePrompt(variant, frame, extra) {
  return [
    'The attached reference image shows an original android character on a transparent background.',
    'Reproduce this exact image as closely as possible, as the next frame of an animation: the identical head position, pose, size and angle, identical framing and camera distance,',
    'the identical hair (every strand in the same place), skin, freckles, beauty mark, seam lines, glowing temple indicator, top, lighting and fully transparent background (isolated cut-out, clean hair edges).',
    `Change ONLY this: ${LIFE_FRAMES[frame]}.`,
    'Nothing else may move or change. Photorealistic, in exactly the same style as the reference.',
    extra || '',
  ].join(' ').trim();
}

function statePrompt(variant, state, extra) {
  if (LIFE_FRAMES[state]) return lifePrompt(variant, state, extra);
  return [
    'The attached reference image shows an original android character on a transparent background.',
    'Create a new portrait of the same exact android character: same face and identity, same skin, freckles and beauty marks, same hair and hairstyle,',
    'same eyes with the luminous iris ring and fine aperture detail in the pupils, the same robotic seam lines on the forehead, hairline, temple, jaw, neck, collarbones and shoulders,',
    'the same tiny glowing temple indicator, the same top, the same square framing and camera distance, the same soft neutral lighting,',
    'and the same fully transparent background (isolated cut-out, clean hair edges, no backdrop).',
    `Change ONLY the facial expression to: ${STATES[state]}.`,
    'Keep it photorealistic, beautiful and polished, in exactly the same style as the reference.',
    extra || '',
  ].join(' ').trim();
}

// ---- Background prompts --------------------------------------------------------
// Square, fully outdoor skyscapes composed for a circular avatar crop. The UI stacks: sky background,
// then the transparent square portrait, then a circle mask; the low horizon silhouette peeks out under
// the shoulders. Same camera, horizon height and framing in all 24, so scenes crossfade smoothly.
const BG_CONCEPT = 'sky-square';
const BG_ANCHOR = 'day-clear'; // generated first; every other scene uses it as the composition reference

const BG_BASE_PROMPT = [
  'A cinematic, photorealistic open skyscape that fills the entire square frame: almost all sky, seen from a fixed camera looking straight ahead with a very slight upward tilt.',
  'Only a very low, soft, location-neutral horizon silhouette of gentle rolling hills and a distant treeline runs along the very bottom of the frame (the bottom 12% of the image), softly out of focus.',
  'Composed for a circular crop: the mood of the sky sits inside the inscribed circle; the centre and upper centre of the frame stay calm, soft and uncluttered, because a portrait head will cover them.',
  'No key details in the centre or in the corners: any sun, moon, glow, lightning or bright highlight sits off-centre in the upper-left or upper-right area, still inside the circle.',
  'Calm, premium, cinematic colour grading with a gentle, soft focus.',
  'Strictly outdoor sky: no interior, no room, no window, no window frame, no glass, no buildings, no people, no animals, no text, no logos, no landmarks. Square 1:1 image.',
].join(' ');

const TIMES = {
  dawn: 'Time: dawn. A soft pastel gradient of peach, apricot and lilac, the first light glowing low near the horizon and fading to pale blue higher up.',
  day: 'Time: daytime. A luminous blue sky, paler and brighter toward the horizon.',
  dusk: 'Time: dusk. A warm amber, coral and magenta sunset glow low along the horizon, deepening to violet and indigo higher up.',
  night: 'Time: night. A deep indigo-to-navy night sky with a soft, off-centre moon glow and, where the weather allows, a scattering of fine stars.',
};

const WEATHERS = {
  clear: 'Weather: clear. An open, clean sky with only a few soft, small wisps of cloud.',
  cloudy: 'Weather: cloudy. Layered, soft, voluminous clouds drifting across the sky, catching the light of the time of day.',
  rain: 'Weather: rain. Soft grey rain clouds with visible rain curtains falling from them and fine rain streaks in the air, a moist, muted atmosphere (rain in the open air only; nothing on glass or on the lens).',
  storm: 'Weather: storm. Dramatic, towering dark storm clouds with a distant lightning flash glowing inside the clouds low near the horizon, off to one side.',
  snow: 'Weather: snow. A pale, soft sky with gentle snowflakes drifting through the air, and the horizon silhouette dusted with white.',
  fog: 'Weather: fog. Hazy, diffused light; soft fog and mist veil the sky, and the horizon silhouette almost disappears.',
};

function bgPrompt(time, weather, extra, useRef) {
  const pre = useRef
    ? 'The attached reference image shows the scene. Keep the exact same camera angle, square framing and horizon height, and the same low hill and treeline silhouette along the bottom. ' +
      'Change ONLY the sky, the light and the weather as described. '
    : '';
  return `${pre}${BG_BASE_PROMPT} ${TIMES[time]} ${WEATHERS[weather]}${extra ? ' ' + extra : ''}`;
}

// ---- Cover prompts (dev demo feed) -----------------------------------------------
// Editorial story images for the demo feed: landscape 3:2, opaque, photographic.
const COVER_STYLE =
  'Editorial cover photograph for a news and stories feed: photographic, magazine quality, natural light, shallow depth of field, rich but natural colour, clean composition. ' +
  'Landscape 3:2 image. No text, no lettering, no logos, no brand marks, no real book covers, and no identifiable people.';

const COVERS = {
  markets: 'An elegant, abstract close-up of a softly glowing financial market line chart reflected on a pane of glass, calm green tones, bokeh highlights.',
  'ai-gpu': 'A sleek, modern graphics card and chip in a macro shot, precise heatsink fins and circuitry, cool blue-violet light, dark background.',
  running: 'A forest trail at dawn with a single runner seen from behind, small in the distance, soft mist between the trees, warm golden light.',
  voice: 'An abstract, soft sound-wave light sculpture: flowing luminous ribbons shaped like an audio waveform, violet and teal light in a dark space.',
  savings: 'A glass jar filled with coins on a wooden table, soft morning window light, gentle shadows, calm and hopeful.',
  'book-weeks': 'An hourglass beside an open book with blank-looking pages on a desk, warm evening lamp light, cosy and reflective.',
  'book-money': 'A plain notebook, a pen and a few coins arranged on natural linen, understated and minimal, soft daylight.',
  'book-run': 'A pair of worn running sandals resting on red desert rock, warm late-afternoon sun, textured stone.',
  'book-range': "A craftsman's wooden workbench with a varied set of hand tools neatly arranged, warm workshop light.",
};

const coverPrompt = (name, extra) => `${COVER_STYLE} Subject: ${COVERS[name]}${extra ? ' ' + extra : ''}`;

// ---- Paths / CLI ----------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVATAR_DIR = path.join(ROOT, 'assets', 'avatars');
const BG_DIR = path.join(ROOT, 'assets', 'backgrounds');
const COVER_DIR = path.join(ROOT, 'assets', 'covers');
const manifestPath = (dir) => path.join(dir, 'manifest.json');

function parseArgs(argv) {
  const args = { variant: 'all', state: 'all', time: 'all', weather: 'all', force: false, backgrounds: false, covers: false, cover: 'all', extra: '', ref: '', model: MODEL, quality: QUALITY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--backgrounds') args.backgrounds = true;
    else if (a === '--covers') args.covers = true;
    else if (['--variant', '--state', '--time', '--weather', '--cover', '--extra', '--ref', '--model', '--quality'].includes(a)) args[a.slice(2)] = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]); process.exit(0); }
    else fail(`Unknown argument: ${a}`);
  }
  const pick = (value, table, label) => {
    const list = value === 'all' ? Object.keys(table) : [value];
    for (const x of list) if (!table[x]) fail(`Unknown ${label}: ${x}`);
    return list;
  };
  args.variants = pick(args.variant, VARIANTS, 'variant');
  args.states = args.state === 'life' ? Object.keys(LIFE_FRAMES) : pick(args.state, { ...STATES, ...LIFE_FRAMES }, 'state');
  args.states.sort((a, b) => (a === 'neutral' ? -1 : b === 'neutral' ? 1 : 0)); // neutral is the reference
  args.times = pick(args.time, TIMES, 'time');
  args.weathers = pick(args.weather, WEATHERS, 'weather');
  args.coverNames = pick(args.cover, COVERS, 'cover');
  if (args.ref && !fs.existsSync(path.resolve(ROOT, args.ref))) fail(`Reference not found: ${args.ref}`);
  return args;
}

function fail(msg) { console.error(msg); process.exit(1); }

// ---- Manifest ----------------------------------------------------------------
function loadManifest(dir, extra = {}) {
  const p = manifestPath(dir);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return { model: MODEL, endpoint: ENDPOINT, ...extra, created: new Date().toISOString(), updated: null, totalCost: 0, images: [], history: [] };
}

function saveManifest(dir, m) {
  m.updated = new Date().toISOString();
  m.totalCost = Number(m.history.reduce((sum, h) => sum + (h.cost || 0), 0).toFixed(6));
  fs.writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + '\n');
}

function totalSpend() {
  let sum = 0;
  for (const dir of [AVATAR_DIR, BG_DIR, COVER_DIR]) {
    const p = manifestPath(dir);
    if (fs.existsSync(p)) sum += JSON.parse(fs.readFileSync(p, 'utf8')).totalCost || 0;
  }
  return sum;
}

// ---- PNG alpha check (no dependencies) ----------------------------------------------
// Decodes an 8-bit non-interlaced PNG far enough to report whether it has a real alpha channel,
// the alpha of the four corners, and the share of fully transparent pixels.
function inspectPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return { format: 'not-png' };
  let pos = 8, width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ({ width, height, bitDepth, colorType, interlace } = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] });
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const info = { width, height, bitDepth, colorType, hasAlphaChannel: colorType === 4 || colorType === 6 };
  if (!info.hasAlphaChannel || bitDepth !== 8 || interlace) return info;
  const bpp = colorType === 6 ? 4 : 2, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x], a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = y && x >= bpp ? px[dst - stride + x - bpp] : 0;
      let v;
      if (f === 0) v = r; else if (f === 1) v = r + a; else if (f === 2) v = r + b; else if (f === 3) v = r + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[dst + x] = v & 255;
    }
  }
  const alphaAt = (x, y) => px[y * stride + x * bpp + bpp - 1];
  info.cornerAlpha = [alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)];
  let clear = 0;
  for (let i = bpp - 1; i < px.length; i += bpp) if (px[i] === 0) clear++;
  info.transparentShare = Number((clear / (width * height)).toFixed(3));
  info.trueTransparency = info.cornerAlpha.slice(0, 2).every((a) => a === 0) && info.transparentShare > 0.05;
  return info;
}

// ---- API ---------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestImage(key, body) {
  for (let attempt = 1; ; attempt++) {
    let res, text;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/jessbot',
          'X-Title': 'Jessbot avatar generator',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      text = await res.text();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  network error (${err.name}); retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (res.ok) {
      const json = JSON.parse(text);
      return { json, generationId: json.id || res.headers.get('x-generation-id') || null };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1);
    console.warn(`  HTTP ${res.status}; retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}

function extractImage(json) {
  const item = json.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  const url = item?.url || json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (url?.startsWith('data:')) return Buffer.from(url.split(',')[1], 'base64');
  throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 500)}`);
}

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

// ---- Jobs --------------------------------------------------------------------------
// Each job: { dir, rel, file, prompt, refFile, refLabel, aspect, background, meta }
function avatarJobs(args) {
  const jobs = [];
  for (const variant of args.variants) {
    const neutralFile = path.join(AVATAR_DIR, variant, 'neutral.png');
    for (const state of args.states) {
      const isBase = state === 'neutral';
      const identityRef = isBase && args.ref ? path.resolve(ROOT, args.ref) : null;
      jobs.push({
        dir: AVATAR_DIR, rel: `${variant}/${state}.png`, file: path.join(AVATAR_DIR, variant, `${state}.png`),
        prompt: () => (isBase ? basePrompt(variant, args.extra, !!identityRef) : statePrompt(variant, state, args.extra)),
        refFile: isBase ? identityRef : neutralFile,
        refLabel: isBase ? (identityRef ? path.relative(AVATAR_DIR, identityRef).replaceAll('\\', '/') : null) : `${variant}/neutral.png`,
        needsRef: !isBase,
        aspect: '1:1', background: 'transparent', checkAlpha: true,
        meta: { variant, state, artDirection: ART_DIRECTION },
      });
    }
  }
  return jobs;
}

function coverJobs(args) {
  return args.coverNames.map((name) => ({
    dir: COVER_DIR, rel: `${name}.png`, file: path.join(COVER_DIR, `${name}.png`),
    prompt: () => coverPrompt(name, args.extra), refFile: null, refLabel: null, needsRef: false,
    aspect: '3:2', background: 'opaque', checkAlpha: false, meta: { name },
  }));
}

function backgroundJobs(args) {
  const jobs = [];
  const anchorFile = path.join(BG_DIR, `${BG_ANCHOR}.png`);
  const names = [];
  for (const time of args.times) for (const weather of args.weathers) names.push([time, weather]);
  const isAnchorName = ([t, w]) => (`${t}-${w}` === BG_ANCHOR ? 1 : 0);
  names.sort((a, b) => isAnchorName(b) - isAnchorName(a)); // anchor first
  for (const [time, weather] of names) {
    const name = `${time}-${weather}`;
    const isAnchor = name === BG_ANCHOR;
    jobs.push({
      dir: BG_DIR, rel: `${name}.png`, file: path.join(BG_DIR, `${name}.png`),
      prompt: () => bgPrompt(time, weather, args.extra, !isAnchor),
      refFile: isAnchor ? null : anchorFile, refLabel: isAnchor ? null : `${BG_ANCHOR}.png`, needsRef: !isAnchor,
      aspect: '1:1', background: 'opaque', checkAlpha: false,
      meta: { timeOfDay: time, weather, concept: BG_CONCEPT },
    });
  }
  return jobs;
}

// ---- Main ----------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.loadEnvFile(path.join(ROOT, '.env'));
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY is not set in .env');

  const mode = args.covers ? 'covers' : args.backgrounds ? 'backgrounds' : 'avatars';
  const dir = { covers: COVER_DIR, backgrounds: BG_DIR, avatars: AVATAR_DIR }[mode];
  fs.mkdirSync(dir, { recursive: true });
  const manifest = loadManifest(dir, mode === 'backgrounds' ? { anchor: `${BG_ANCHOR}.png` } : {});
  const jobs = { covers: coverJobs, backgrounds: backgroundJobs, avatars: avatarJobs }[mode](args);
  let first = true;

  for (const job of jobs) {
    if (fs.existsSync(job.file) && !args.force) { console.log(`skip ${job.rel} (exists)`); continue; }
    if (job.needsRef && !fs.existsSync(job.refFile)) { console.error(`skip ${job.rel}: reference ${job.refLabel} is missing`); continue; }
    const spent = totalSpend();
    if (spent + MAX_COST_PER_IMAGE > MAX_TOTAL_COST) {
      console.error(`Budget guard: total spend $${spent.toFixed(2)} is near the $${MAX_TOTAL_COST} cap. Stopping.`);
      return;
    }
    if (!first) await sleep(DELAY_MS);
    first = false;

    const prompt = job.prompt();
    const body = {
      model: args.model, prompt, n: 1,
      aspect_ratio: job.aspect, quality: args.quality, background: job.background, output_format: 'png',
    };
    if (job.refFile) body.input_references = [{ type: 'image_url', image_url: { url: dataUrl(job.refFile) } }];

    console.log(`gen  ${job.rel}${job.refLabel ? ` (ref: ${job.refLabel})` : ''} ...`);
    const t0 = Date.now();
    const { json, generationId } = await requestImage(key, body);
    const png = extractImage(json);
    fs.mkdirSync(path.dirname(job.file), { recursive: true });
    const cost = json.usage?.cost ?? null;
    const img = inspectPng(png);
    let alphaCleanup = null;
    if (job.checkAlpha && img.trueTransparency) {
      // keep the raw model output as <state>.orig.png, write the matte-cleaned version as <state>.png
      fs.writeFileSync(origPathFor(job.file), png);
      alphaCleanup = cleanAvatarFile(job.file);
    } else {
      fs.writeFileSync(job.file, png);
    }
    console.log(`  ok  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${img.width}x${img.height}  cost $${cost ?? '?'}  id ${generationId ?? '-'}` +
      (job.checkAlpha ? `  alpha: ${img.trueTransparency ? 'yes' : 'NO'} (colorType ${img.colorType}, corners ${img.cornerAlpha ?? '-'}, clear ${img.transparentShare ?? 0})` : ''));
    if (job.checkAlpha && !img.trueTransparency) console.warn('  WARNING: the image has no real transparent background.');

    const entry = {
      ...job.meta, file: job.rel, prompt, referenceUsed: job.refLabel, cost, generationId, model: args.model, quality: args.quality,
      size: `${img.width}x${img.height}`, background: job.background,
      ...(job.checkAlpha ? { alpha: { colorType: img.colorType, cornerAlpha: img.cornerAlpha, transparentShare: img.transparentShare, trueTransparency: img.trueTransparency }, alphaCleanup } : {}),
      usage: json.usage ?? null, createdAt: new Date().toISOString(),
    };
    manifest.history.push(entry);
    manifest.images = manifest.images.filter((e) => e.file !== job.rel);
    manifest.images.push(entry);
    manifest.images.sort((a, b) => a.file.localeCompare(b.file));
    manifest.model = args.model;
    if (mode === 'avatars') manifest.artDirection = ART_DIRECTION;
    saveManifest(dir, manifest);

    if (cost != null && cost > MAX_COST_PER_IMAGE) {
      console.error(`Cost guard: $${cost} for one image is above $${MAX_COST_PER_IMAGE}. Stopping.`);
      return;
    }
  }
  console.log(`done. ${mode} manifest: $${manifest.totalCost.toFixed(4)}  |  total spend: $${totalSpend().toFixed(4)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
