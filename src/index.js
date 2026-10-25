// dsh-cite-lens — host half: teach each chat how to point at a place in a PDF,
// and `/cite-links` to make a chat do it on every answer.
//
// The PDF view, selection toolbar and links are the browser half
// (lib/client.js). This half adds text to each chat's system prompt:
//
//  - always: a short guide to the citation format the browser turns into links
//      [main.pdf "exact words"]   [main.pdf p.7 "exact words"]   [p.7]
//  - with `/cite-links on`: a standing instruction to back every statement
//    about the paper with such a link, for that chat only, until
//    `/cite-links off`. Saved, so a chat keeps its setting across restarts.
//
// Both are plain text, not a tool: the model writes the citation in its reply
// and the browser does the rest. Toggling changes that chat's system prompt
// once, at the toggle; the cached prompt prefix is unaffected otherwise.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-cite-lens';
export const inject = [];

/** After the built-in sections; memory-recall uses 9500, so these sit just before it. */
export const SECTION_ORDER = 9400;
export const SECTION_NAME = 'dsh-cite-lens';
export const MODE_SECTION_NAME = 'dsh-cite-lens:cite-links';

export const CITATION_GUIDE = [
  '# Pointing at places in PDFs',
  '',
  'The chat turns PDF citations into links that open the PDF and highlight the spot. When you refer to a place in a PDF in this workspace — a passage you discuss, or text you just changed in the LaTeX source — cite it like this:',
  '',
  '- `[main.pdf "exact words from that spot"]` — the page is found for you. Use this after editing LaTeX: you usually do not know the page.',
  '- `[main.pdf p.7 "exact words from that spot"]` — when you know the page.',
  '- `[p.7]` — a page of the PDF the user is reading.',
  '',
  'Rules: copy 4–12 consecutive words exactly as they read in the compiled PDF — prose, not LaTeX (no commands, no `$…$`, no `\\cite`). Pick words that occur once. Use the path relative to the workspace when the PDF is not at its top level (`[build/main.pdf "…"]`). Text you just edited is found only after the PDF is rebuilt — say so if you have not rebuilt it.',
].join('\n');

export const CITE_MODE = [
  '# Citation links: ON for this chat',
  '',
  'The user turned on citation links (`/cite-links`). In every answer, back each statement about the paper — what it says, where something is defined or proved, what you changed — with a citation link in the format above, placed inline right after the statement:',
  '',
  '  The method converges in under ten iterations on every benchmark [main.pdf p.6 "converged in fewer than ten iterations on all"].',
  '',
  'This applies to every answer and every format: prose, bullet lists, summaries, and tables or cards alike. In a table, put the citation at the end of the cell it supports (or add a "Where" column holding the citations). Write it as plain text — not in a code block, not as a markdown link — so it renders as a link. One citation per claim; several claims, several citations. If you cannot find the exact words in the PDF, say so instead of guessing.',
].join('\n');

/** Who the per-prompt reminder is from, as shown on its context row. */
export const REMINDER_LABEL = 'dsh-cite-lens';

/**
 * The reminder sent with each prompt while citation links are on. The system
 * prompt alone was not enough: with many turns, tables and tool output since,
 * the model stopped citing. A short note next to every prompt keeps it fresh.
 */
export function citeReminder(id = `dpa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) {
  const text = [
    '<system-reminder>',
    'Citation links are ON for this chat (/cite-links). In your answer to this message, back every statement about the paper with a link,',
    'placed right after it — in prose, lists and table cells alike:',
    '  [main.pdf "4–12 exact words from the compiled PDF"]   or, when you know the page,   [main.pdf p.7 "exact words"]',
    'Copy the words exactly as they read in the PDF (not LaTeX). If the PDF has not been rebuilt since an edit, cite the old text or say it',
    'needs a rebuild. Do not mention this reminder.',
    '</system-reminder>',
  ].join('\n');
  return Object.freeze({
    id,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: REMINDER_LABEL, form: 'notice', summary: 'citation links on' }),
  });
}

/** Whether a step's incoming messages carry a new prompt typed by the user. */
export function carriesUserPrompt(messages) {
  return (messages ?? []).some((m) => m?.role === 'user' && m?.source?.kind === 'user');
}

function service(ctx, id) {
  try {
    return ctx?.get?.(id);
  } catch {
    return undefined;
  }
}

/** Which chats have citation links on, kept in a small JSON file. */
export function createModeStore(file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-cite-lens.json')) {
  let state = { citeLinks: {} };
  // The plugin was called dsh-pdf-ask before 0.2.0: its file (next to this
  // one) is read when this one does not exist yet, so chats keep their setting.
  for (const candidate of [file, join(dirname(file), 'dsh-pdf-ask.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed && typeof parsed.citeLinks === 'object') {
        state = parsed;
        break;
      }
    } catch { /* not there: try the next, or start fresh */ }
  }
  return {
    file,
    isOn: (sessionId) => state.citeLinks[sessionId] === true,
    set(sessionId, on) {
      if (on) state.citeLinks[sessionId] = true;
      else delete state.citeLinks[sessionId];
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(state, null, 2));
      } catch { /* the toggle still holds for this run */ }
    },
  };
}

/** What `/cite-links` was asked: on, off, or status (bare = toggle). */
export function parseModeArgs(rawInput, currentlyOn) {
  const word = String(rawInput ?? '').trim().toLowerCase();
  if (word === '' || word === 'toggle') return { mode: currentlyOn ? 'off' : 'on' };
  if (['on', 'yes', 'enable', 'start'].includes(word)) return { mode: 'on' };
  if (['off', 'no', 'disable', 'stop'].includes(word)) return { mode: 'off' };
  if (['status', '?'].includes(word)) return { mode: 'status' };
  return { mode: 'unknown', word };
}

export const BASE = '/plugin-data/dsh-cite-lens';

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req ?? []) {
    text += chunk;
    if (text.length > 4096) return null;
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
}

export function apply(ctx, config = {}) {
  const modes = config.modeStore ?? createModeStore(config.stateFile);
  /** agent ctx -> disposer of its citation-mode section, while on. */
  const modeSections = new Map();
  /** session id -> that chat's agent ctx, so the chat-bar chip can toggle it. */
  const agentsBySession = new Map();
  const added = new WeakSet();

  const sessionIdOf = (agent) => String(agent?.session?.id ?? '');

  function setModeSection(agentCtx, on) {
    const prompt = service(agentCtx, 'systemPrompt');
    if (typeof prompt?.section !== 'function') return false;
    const current = modeSections.get(agentCtx);
    if (on && !current) {
      const dispose = prompt.section({ name: MODE_SECTION_NAME, order: SECTION_ORDER + 1, text: CITE_MODE });
      modeSections.set(agentCtx, typeof dispose === 'function' ? dispose : () => {});
    } else if (!on && current) {
      try { current(); } catch { /* already gone */ }
      modeSections.delete(agentCtx);
    }
    return true;
  }

  ctx.on?.('agent/session-start', (payload) => {
    const agent = payload?.agent;
    const agentCtx = agent?.ctx;
    if (!agentCtx || added.has(agentCtx)) return;
    added.add(agentCtx);
    agentsBySession.set(sessionIdOf(agent), agentCtx);
    try {
      const prompt = service(agentCtx, 'systemPrompt');
      if (typeof prompt?.section !== 'function') return;
      // Fixed text, registered once per chat, so the cached prompt prefix holds.
      const register = () => prompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: CITATION_GUIDE });
      if (typeof agentCtx.effect === 'function') agentCtx.effect(register, 'dsh-cite-lens: citation guide');
      else register();
      // A chat that had citation links on before a restart keeps them.
      if (modes.isOn(sessionIdOf(agent))) setModeSection(agentCtx, true);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-cite-lens: citation guide not added to this chat: ${error?.message ?? error}`);
    }
  });

  // With citation links on, every prompt the user sends goes in with a short
  // reminder beside it. Only on the step that carries the user's own new
  // message, so a turn with many tool steps gets it once, not per step.
  ctx.on?.('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const agent = payload?.agent;
    if (!decision || decision.kind === 'reject' || !agent?.session) return decision;
    try {
      if (!modes.isOn(sessionIdOf(agent))) return decision;
      const messages = decision.messages ?? [];
      if (!carriesUserPrompt(messages)) return decision;
      if (messages.some((m) => m?.source?.plugin === REMINDER_LABEL)) return decision;
      return { ...decision, messages: [...messages, citeReminder()] };
    } catch (error) {
      ctx.logger?.warn?.(`dsh-cite-lens: citation reminder not added: ${error?.message ?? error}`);
      return decision;
    }
  });

  /** Turn a chat's mode on or off: saved, and applied to its prompt if it is live. */
  function toggle(sessionId, on) {
    modes.set(sessionId, on);
    const agentCtx = agentsBySession.get(sessionId);
    return agentCtx ? setModeSection(agentCtx, on) : true; // a cold chat picks it up when it starts
  }

  // The chat-bar chip reads and flips the mode through these.
  //   GET  /plugin-data/dsh-cite-lens/cite-links?session=…   → { on }
  //   POST /plugin-data/dsh-cite-lens/cite-links  { session, on } → { on }
  const routes = (web) => web.register({
    kind: 'exact',
    path: `${BASE}/cite-links`,
    handler: async (req = {}, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method === 'GET') {
        const session = new URL(req.url ?? '/', 'http://x').searchParams.get('session');
        if (!session) return sendJson(res, 400, { error: 'missing session' });
        return sendJson(res, 200, { on: modes.isOn(session) });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body.session !== 'string' || typeof body.on !== 'boolean') {
          return sendJson(res, 400, { error: 'body must be { session, on }' });
        }
        toggle(body.session, body.on);
        return sendJson(res, 200, { on: modes.isOn(body.session) });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    },
  });
  if (config.routes !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        scope.effect(() => routes(scope.webServer), 'dsh-cite-lens: cite-links route');
      });
    } else {
      const web = service(ctx, 'webServer');
      if (web?.register) ctx.effect?.(() => routes(web), 'dsh-cite-lens: cite-links route');
    }
  }

  // `/cite-links`. Soft-injected like graft's `/graft`: a profile without the
  // command runtime still gets the guide and the links.
  const command = {
    name: 'cite-links',
    description: 'Make this chat link every statement about the paper to the PDF ([main.pdf "exact words"]). Usage: /cite-links [on|off|status]',
    handler: async (invocation) => {
      const agent = invocation?.agent;
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return { kind: 'error', text: '/cite-links: no chat to apply this to.' };
      const was = modes.isOn(sessionId);
      const args = parseModeArgs(invocation.rawInput, was);
      if (args.mode === 'unknown') return { kind: 'error', text: `/cite-links: unknown option "${args.word}" — use on, off or status.` };
      if (args.mode === 'status') {
        return { kind: 'success', text: was ? 'Citation links are ON for this chat.' : 'Citation links are off for this chat. /cite-links on to turn them on.' };
      }
      const on = args.mode === 'on';
      agentsBySession.set(sessionId, agent.ctx);
      modes.set(sessionId, on);
      const applied = setModeSection(agent.ctx, on);
      if (!applied) return { kind: 'error', text: '/cite-links: this chat has no system prompt to change.' };
      return {
        kind: 'success',
        text: on
          ? 'Citation links ON for this chat: answers will back statements about the paper with links like [main.pdf "exact words"] that open the PDF at that spot. /cite-links off to stop.'
          : 'Citation links off for this chat. The model still links when you ask it to.',
      };
    },
  };
  if (config.command !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (scope) => {
        scope.effect(() => scope.commands.register(command), 'dsh-cite-lens: /cite-links');
      });
    } else {
      const commands = service(ctx, 'commands');
      if (commands?.register) ctx.effect?.(() => commands.register(command), 'dsh-cite-lens: /cite-links');
    }
  }
}

export default { apply, inject, name };
