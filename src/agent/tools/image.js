// make_image (Phase 22, decisions #169–#170): a picture from the admin's image model, saved to the person's Library.
// Offered only when an image model is set (Admin → Models) AND the person's 'images' toolset is on (off by default; the admin
// turns it on per person or group in Admin → People / Groups). Cost, budget and the real-people rule: services/images.js.
import { registerTool } from './registry.js';
import { get } from '../../db/index.js';
import { makeImage, imageModel, imageSettings, IMAGE_SIZES, IMAGE_STYLES, DEPICTS } from '../../services/images.js';
import { itemView } from '../../services/library.js';
import { publish } from '../../lib/bus.js';
import { renderFragment } from '../../views/render.js';

const SHAPE_WORDS = { square: 'Square', portrait: 'Portrait (2:3)', landscape: 'Landscape (3:2)', wide: 'Wide (16:9)', tall: 'Tall (9:16)' };
// The picture a call works from, for the card: named and linked only when it is the requester's own.
function sourceFact(id, user) {
  const item = get(`SELECT public_id, title, owner_id FROM library_items WHERE public_id = ? AND deleted_at IS NULL AND type = 'image'`, String(id));
  if (!item || (user && item.owner_id !== user.id)) return { title: 'A picture that isn’t in your Library', meta: 'it won’t be made' };
  return { title: item.title, meta: 'your picture', href: `/library/${item.public_id}` };
}
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

registerTool({
  name: 'make_image', displayName: 'Pictures', toolset: 'images', risk: 'write', activity: 'creating', iconName: 'palette', activityKind: 'file',
  available: () => !!imageModel(),
  description: 'Make ONE picture with the image model and save it to their Library: an invitation or card picture, a colouring page, '
    + 'story art, a sticker, a poster image. Each picture costs money from their weekly budget (checked before it is made; refused '
    + 'when it would not fit). Write a full visual prompt: the subject, setting, composition, colours and mood. Keep words in the '
    + 'picture few and quoted exactly (image models misspell text; long text belongs in a page or document around the picture). style '
    + 'adds a preset (colouring_page makes clean black line art); size picks the shape (portrait for a printed page or an invitation). '
    + 'source_image_id: one of THEIR OWN Library pictures to edit or transform (a colouring page from their photo, a new background). '
    + 'depicts (required) says who is shown. Never make a likeness of a real, identifiable person unless it is the person asking and '
    + 'they said so (requester), or it is their own photo and they said the people in it agreed or it is their child '
    + '(consenting_people). A celebrity, public figure, classmate, neighbour or anyone else real is someone_else: that is always '
    + 'refused, so decline and offer a made-up character instead of calling. Made-up people, characters, animals and scenes are '
    + 'no_real_people (names written on a card are fine). If the image model refuses a prompt, tell them; never reword it to get '
    + 'around a safety filter. After it, link the picture for them.',
  parameters: {
    type: 'object', required: ['prompt', 'depicts'], additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: 'What the picture shows, in full visual detail (up to 2000 characters).' },
      depicts: { type: 'string', enum: DEPICTS, description: 'Who is shown: no_real_people · requester (the person asking, who said so) · '
        + 'consenting_people (their own photo; they said the people agreed, or it is their child) · someone_else (always refused).' },
      size: { type: 'string', enum: Object.keys(IMAGE_SIZES), description: 'Shape: square (default), portrait, landscape, wide (16:9), tall (9:16).' },
      style: { type: 'string', enum: Object.keys(IMAGE_STYLES), description: 'A preset, only when the picture is one of these kinds (leave out otherwise): colouring_page, cartoon, watercolour, storybook, photo, sticker, flat.' },
      source_image_id: { type: 'string', description: 'Optional: the id of one of their own Library pictures to work from.' },
      title: { type: 'string', description: 'Title in the Library (default: the start of the prompt).' },
    },
  },
  label: args => (args.style === 'colouring_page' ? 'Drew a colouring page' : args.source_image_id ? 'Made a picture from their photo' : 'Made a picture'),
  target: args => clip(args.title || args.prompt, 60) || null,
  approvalTitle: args => `Make a picture: “${clip(args.title || args.prompt, 70)}”`,
  approvalPreview: args => [
    `Prompt: ${String(args.prompt || '')}`,
    `Shape: ${args.size || 'square'}${args.style ? ` · style: ${args.style.replace(/_/g, ' ')}` : ''}`,
    args.source_image_id ? `Made from their Library picture ${args.source_image_id}` : null,
    `Model: ${imageModel() || 'none set'} (costs a little from the weekly budget)`,
  ].filter(Boolean).join('\n'),
  // The card's facts (#194): the shape and style, the photo it works from (theirs only), the model that makes it, and what a
  // picture costs as Admin → Models last worked it out (Phase 25 #212; no lookup while the card is built).
  approvalFacts: (args, ctx) => [
    { key: 'shape', label: 'Shape', value: `${SHAPE_WORDS[args.size] || SHAPE_WORDS.square}${args.style ? ` · ${String(args.style).replace(/_/g, ' ')}` : ''}` },
    args.source_image_id ? { key: 'source', label: 'From', items: [sourceFact(args.source_image_id, ctx?.user)] } : null,
    { key: 'model', label: 'Model', value: `${imageModel() || 'none set'}, from the weekly budget` },
    imageSettings().checked?.price?.label ? { key: 'price', label: 'Cost', value: imageSettings().checked.price.label } : null,
  ].filter(Boolean),
  undo: { possible: false, note: 'the picture’s cost can’t be taken back; you can delete the picture from the Library' },
  run: async (args, ctx) => {
    const out = await makeImage(ctx.user, {
      prompt: args.prompt, size: args.size || 'square', style: args.style || null, sourceImageId: args.source_image_id || null,
      depicts: args.depicts, title: args.title || null, threadId: ctx.thread?.id ?? null, runId: ctx.run?.id ?? null, signal: ctx.signal,
    });
    const { item } = out;
    const view = itemView(item);
    publish(ctx.user.id, 'library.created', { item: view, html: await renderFragment('library-card', view, ctx.user).catch(() => null) });
    const dims = out.width && out.height ? `${out.width}×${out.height}` : out.aspectRatio;
    return {
      content: `Saved the picture “${item.title}” in their Library (${item.ext.toUpperCase()}, ${dims}, cost ${out.costLabel}). `
        + `Link it for them as [${item.title}](/library/${item.public_id}). view_image shows it to you if you need to check it.`,
      step: { detail: `${item.ext.toUpperCase()} · ${dims} · ${out.costLabel}`, image: `/library/${item.public_id}/raw?v=${item.version}`, href: `/library/${item.public_id}` },
    };
  },
});
