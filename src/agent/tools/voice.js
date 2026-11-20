// reply_by_voice (docs/VOICE.md): they asked to hear her ("send me a voice note", "say it", "read it to me", "tell me
// verbally"). The run is marked, the prompt tells her to write for the ear, and the finished reply becomes a voice note
// (agent/voice.js). She never needs it for a voice note from them — those are answered by voice already.
// make_audio (decision #142): a long read-aloud saved to the Library with a player. set_name_pronunciation (#143): how a
// person's own name is said.
import { registerTool } from './registry.js';
import { run as sql } from '../../db/index.js';
import { EAR } from '../prompt.js';
import { MAX_AUDIO_MINUTES, voiceOn } from '../../services/voice.js';
import { recordAloud } from '../../services/read-aloud.js';
import { itemForUser } from '../../services/library.js';
import { setNameSay } from '../../services/users.js';
import { projectOfThread } from '../../services/projects.js';
import { setActivity } from '../../services/runs.js';

registerTool({
  name: 'reply_by_voice', displayName: 'Voice notes', toolset: 'core', risk: 'read', activity: 'speaking', iconName: 'audio-lines',
  available: () => voiceOn(), // OpenRouter only (#11)
  description: 'Send your reply as a voice note in your own voice. Use it only when the person asks to HEAR you — "send me a voice '
    + 'note", "say it", "read it to me", "tell me verbally", "speak it out", "I want to listen". Not for ordinary questions. Call it '
    + 'once, before writing the reply; the reply you then write is spoken and also shown as text. Not needed when their message '
    + 'was a voice note — that is answered by voice already.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Answering with a voice note',
  run: (args, { run: r }) => {
    sql('UPDATE runs SET voice = 1 WHERE id = ? AND voice = 0', r.id);
    return { content: `Done — the reply you write now is sent as a voice note; no more tool calls are needed for that. ${EAR}`, step: { detail: 'Your reply will be spoken' } };
  },
});

// ---- make_audio (decision #142): a long read-aloud saved to the Library with a player ------------------------------------
registerTool({
  name: 'make_audio', displayName: 'Read aloud', toolset: 'library', risk: 'write', activity: 'speaking', iconName: 'volume-2', activityKind: 'file',
  description: 'Record a long read-aloud in your own voice and save it to their Library with a player: a Library item (library_id: a '
    + 'document, a PDF or Word file, a page) or text you pass (a story you wrote, an article you read). Up to 30 minutes. Use when they '
    + 'want to LISTEN to something long ("read me this document", "an audio version for the car", "a bedtime story I can play"). For '
    + 'a short spoken answer use reply_by_voice instead. It takes a while (the parts are recorded one after another) and uses the '
    + 'voice budget; tell them roughly how long it will be.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      library_id: { type: 'string', description: 'The Library item to read (its id).' },
      text: { type: 'string', description: 'Or the text to read, as written (markdown is fine; code and tables are skipped).' },
      title: { type: 'string', description: 'Title for the audio (default: the item’s title).' },
    },
  },
  label: args => `Recorded ${args.title ? `“${String(args.title).slice(0, 40)}”` : 'a read-aloud'}`,
  target: args => args.title || args.library_id || null,
  run: async (args, ctx) => {
    if (!args.library_id && !String(args.text || '').trim()) return 'Give library_id (a Library item) or the text to read.';
    let item = null;
    if (args.library_id) {
      item = itemForUser(ctx.user, args.library_id);
      if (item.type === 'image' || item.type === 'audio') return `“${item.title}” has no text to read (it’s ${item.type === 'image' ? 'an image' : 'audio already'}).`;
    }
    // The same recording and saving as the Library's Listen button (services/read-aloud.js, #196).
    const out = await recordAloud(ctx.user, {
      item, text: args.text, title: args.title, threadId: ctx.thread?.id ?? null, runId: ctx.run?.id ?? null,
      project: ctx.thread ? projectOfThread(ctx.thread.id) : null, signal: ctx.signal,
      onProgress: (i, n) => { if (ctx.run && n > 1) setActivity(ctx.run.id, 'speaking', `part ${i} of ${n}`); },
    });
    const { length, partial } = out;
    const saved = out.item;
    const why = { budget: 'this week’s budget ran out', error: `the voice model failed (${String(out.error || '').slice(0, 120)})`, length: `it reached the ${MAX_AUDIO_MINUTES}-minute limit` };
    return {
      content: `Saved “${saved.title}” to their Library: ${length} of audio (/library/${saved.public_id}).`
        + (partial ? ` Only the first ${out.made} of ${out.parts} parts were recorded: ${why[out.stopped] || 'it stopped early'}. Tell them plainly.` : ''),
      step: { detail: `${saved.title} · ${length}`, href: `/library/${saved.public_id}`, status: partial ? 'bad' : 'ok' },
    };
  },
});

// ---- How to say my name (decision #143) ----------------------------------------------------------------------------------
registerTool({
  name: 'set_name_pronunciation', displayName: 'Name pronunciation', toolset: 'memory', risk: 'write', activity: 'remembering', iconName: 'ear',
  activityKind: 'memory',
  description: 'Save how the person’s OWN name is said, as a phonetic spelling your voice reads instead of the written name ("Shi-vawn", '
    + '"Amara"). Use when they tell you how to say it, or that you say it wrong. Arabic or Hebrew vowel marks only if they give them. '
    + 'Empty text clears it.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['say'],
    properties: { say: { type: 'string', description: 'How it sounds, spelled out: letters, spaces, hyphens.' } },
  },
  label: args => (String(args.say || '').trim() ? 'Saved how to say your name' : 'Cleared how to say your name'),
  target: args => String(args.say || '').slice(0, 40) || null,
  run: (args, ctx) => {
    const u = setNameSay(ctx.user.id, args.say);
    return u.nameSay ? `Saved: when speaking, “${ctx.user.firstName}” is said as “${u.nameSay}”.` : 'Cleared: the written name is read as it is.';
  },
});
