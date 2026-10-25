// /cite-links: per-chat citation mode in the system prompt, saved across restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, createModeStore, parseModeArgs, CITATION_GUIDE, CITE_MODE, SECTION_NAME, MODE_SECTION_NAME } from '../src/index.js';

/** A host ctx with one chat whose system prompt records its sections. */
function harness(file) {
  const listeners = {};
  const routes = {};
  let command;
  const sections = new Map();
  const prompt = {
    section({ name, text }) {
      if (sections.has(name)) throw new Error(`duplicate section ${name}`);
      sections.set(name, text);
      return () => sections.delete(name);
    },
  };
  const agentCtx = { get: (id) => (id === 'systemPrompt' ? prompt : undefined), effect: (fn) => fn() };
  const agent = { ctx: agentCtx, session: { id: 'chat-1' } };
  const ctx = {
    on: (name, fn) => { listeners[name] = fn; },
    inject: (_names, fn) => fn({
      effect: (f) => f(),
      commands: { register: (c) => { command = c; return () => {}; } },
      webServer: { register: (r) => { routes[r.path] = r.handler; return () => {}; } },
    }),
    logger: {},
  };
  apply(ctx, { stateFile: file });
  return {
    start: () => listeners['agent/session-start']({ agent }),
    run: (rawInput) => command.handler({ agent, rawInput }),
    sections,
    routes,
    command: () => command,
  };
}

test('parseModeArgs: bare toggles, words set, unknown is an error', () => {
  assert.equal(parseModeArgs('', false).mode, 'on');
  assert.equal(parseModeArgs('', true).mode, 'off');
  assert.equal(parseModeArgs(' ON ', false).mode, 'on');
  assert.equal(parseModeArgs('off', true).mode, 'off');
  assert.equal(parseModeArgs('status', true).mode, 'status');
  assert.deepEqual(parseModeArgs('maybe', true), { mode: 'unknown', word: 'maybe' });
});

test('every chat gets the citation guide; /cite-links adds and removes the standing instruction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpa-'));
  try {
    const h = harness(join(dir, 'state.json'));
    assert.equal(h.command().name, 'cite-links');
    h.start();
    assert.equal(h.sections.get(SECTION_NAME), CITATION_GUIDE);
    assert.equal(h.sections.has(MODE_SECTION_NAME), false);

    const on = await h.run('');
    assert.equal(on.kind, 'success');
    assert.match(on.text, /ON for this chat/);
    assert.equal(h.sections.get(MODE_SECTION_NAME), CITE_MODE);
    assert.match((await h.run('status')).text, /ON/);

    const off = await h.run('off');
    assert.match(off.text, /off for this chat/);
    assert.equal(h.sections.has(MODE_SECTION_NAME), false);
    assert.equal((await h.run('nope')).kind, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a chat with citation links on keeps them after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpa-'));
  const file = join(dir, 'state.json');
  try {
    const before = harness(file);
    before.start();
    await before.run('on');
    assert.equal(createModeStore(file).isOn('chat-1'), true);

    // A fresh process: the chat starts again and gets its mode back.
    const after = harness(file);
    after.start();
    assert.equal(after.sections.get(MODE_SECTION_NAME), CITE_MODE);
    await after.run('off');
    assert.equal(createModeStore(file).isOn('chat-1'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Call a route handler the way the web server does. */
async function call(handler, { method = 'GET', url = '/', body } = {}) {
  const req = (async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); })();
  req.method = method;
  req.url = url;
  const res = { status: 0, text: '' };
  res.writeHead = (status) => { res.status = status; };
  res.end = (text) => { res.text = String(text ?? ''); };
  await handler(req, res);
  return { status: res.status, json: JSON.parse(res.text || '{}') };
}

test('the chat-bar chip reads and flips the mode through its route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpa-'));
  try {
    const h = harness(join(dir, 'state.json'));
    h.start();
    const route = h.routes['/plugin-data/dsh-cite-lens/cite-links'];
    assert.deepEqual((await call(route, { url: '/x?session=chat-1' })).json, { on: false });
    const on = await call(route, { method: 'POST', body: { session: 'chat-1', on: true } });
    assert.deepEqual(on.json, { on: true });
    assert.equal(h.sections.get(MODE_SECTION_NAME), CITE_MODE, 'the live chat gets the instruction at once');
    assert.deepEqual((await call(route, { url: '/x?session=chat-1' })).json, { on: true });
    await call(route, { method: 'POST', body: { session: 'chat-1', on: false } });
    assert.equal(h.sections.has(MODE_SECTION_NAME), false);
    assert.equal((await call(route, { method: 'POST', body: { session: 'chat-1' } })).status, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with citation links on, each user prompt goes in with the reminder — once per prompt, not per tool step', async () => {
  const { citeReminder, carriesUserPrompt, REMINDER_LABEL } = await import('../src/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'dpa-'));
  try {
    const listeners = {};
    const ctx = { on: (name, fn) => { listeners[name] = fn; }, inject: (_n, fn) => fn({ effect: (f) => f(), commands: { register: () => () => {} }, webServer: { register: () => () => {} } }), logger: {} };
    const { apply: applyFresh } = await import('../src/index.js');
    applyFresh(ctx, { stateFile: join(dir, 'state.json') });
    const agent = { ctx: { get: () => undefined }, session: { id: 'chat-9' } };
    const prompt = { role: 'user', content: [{ type: 'text', text: 'what changed?' }], source: { kind: 'user' } };
    const toolResult = { role: 'tool', content: [] };
    const step = (messages) => listeners['agent/pre-step']({ agent }, async () => ({ kind: 'enter', messages }));

    // Off: nothing added.
    assert.equal((await step([prompt])).messages.length, 1);

    createModeStore(join(dir, 'state.json')).set('chat-9', true);
    // apply() keeps its own store; turn it on through a fresh apply that reads the file.
    const listeners2 = {};
    applyFresh({ ...ctx, on: (name, fn) => { listeners2[name] = fn; } }, { stateFile: join(dir, 'state.json') });
    const step2 = (messages) => listeners2['agent/pre-step']({ agent }, async () => ({ kind: 'enter', messages }));

    const withPrompt = await step2([prompt]);
    assert.equal(withPrompt.messages.length, 2);
    assert.equal(withPrompt.messages[1].source.plugin, REMINDER_LABEL);
    assert.match(withPrompt.messages[1].content[0].text, /Citation links are ON/);
    assert.equal((await step2([toolResult])).messages.length, 1, 'a tool step gets no reminder');
    assert.equal((await step2([prompt, citeReminder()])).messages.length, 2, 'never twice in one step');
    assert.equal((await listeners2['agent/pre-step']({ agent }, async () => ({ kind: 'reject' }))).kind, 'reject');
    assert.equal(carriesUserPrompt([{ role: 'user', source: { kind: 'plugin' } }]), false, "another plugin's message is not a prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings saved under the old name (dsh-pdf-ask) carry over', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'dpa-'));
  try {
    writeFileSync(join(dir, 'dsh-pdf-ask.json'), JSON.stringify({ citeLinks: { 'old-chat': true } }));
    const store = createModeStore(join(dir, 'dsh-cite-lens.json'));
    assert.equal(store.isOn('old-chat'), true);
    store.set('new-chat', true); // writes the new file, keeping the old entries
    assert.equal(createModeStore(join(dir, 'dsh-cite-lens.json')).isOn('old-chat'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
