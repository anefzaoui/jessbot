// Tool registry (decision #17). A tool is a plain object:
//   { name, description, parameters (JSON Schema), toolset, risk: read|write|spend|external,
//     activity (activities.js key), label(args) → step label, target?(args) → activity target,
//     run(args, ctx) → string | { content, pause?: true },
//     available?(user) → false hides it for this person (e.g. email tools before they connect a mailbox),
//     origins?: [run origins] → only offered and allowed in those kinds of task (delegate: chats; leave_note: unattended work),
//     precheck?(args, { user, run }) → a refusal line, checked by the loop before the approval gate (never a card for a call
//       that can't run),
//     handsOver?: true → when it's the task's last successful step, the next step is the person's (a card they press, like
//       project_propose's Create): the goal gate doesn't push the task back to work (#217) }
// Phase 4 filters by each person's policy BEFORE the schema reaches the model; Phase 3 exposes the core set.
const tools = new Map();

export function registerTool(def) {
  for (const k of ['name', 'description', 'parameters', 'toolset', 'risk', 'run']) {
    if (!def[k]) throw new Error(`tool ${def.name || '?'} is missing ${k}`);
  }
  tools.set(def.name, def);
}

export const getTool = name => tools.get(name);
/** What people see instead of a tool's code name ("clicks on websites", not "browser_click"). */
export const displayNameOf = name => tools.get(name)?.displayName || String(name || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
export const allTools = () => [...tools.values()];

// Default toolsets every person gets until Phase 4 policies exist.
export const CORE_TOOLSETS = new Set(['core', 'memory']);

export function toolSchemasFor(user, { toolsets = CORE_TOOLSETS } = {}) {
  return [...tools.values()]
    .filter(t => toolsets.has(t.toolset) && (!t.available || t.available(user)))
    .sort((a, b) => a.name.localeCompare(b.name)) // stable order → stable prompt prefix → cache hits
    .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
