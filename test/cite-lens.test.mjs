import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { formatQuote, appendToDraft, insertIntoChat, findPageCitations, cleanSelection, CITE_HINT } from '../src/client/chat.js';
import { ViewerRegistry } from '../src/client/pagelinks.js';

const here = dirname(fileURLToPath(import.meta.url));

/* ---- quoting -------------------------------------------------------------- */

test('cleanSelection rejoins hyphenated line breaks and collapses whitespace', () => {
  assert.equal(cleanSelection('per-target eval-\nuation   records\nwill  be'), 'per-target evaluation records will be');
  assert.equal(cleanSelection('soft­hyphen'), 'softhyphen');
});

test('formatQuote tags the passage with file and page, and asks for [p.N] citations', () => {
  const quote = formatQuote({ file: 'main.pdf', page: 17, text: 'Code will be released.', action: 'quote' });
  assert.match(quote, /^> \*\*main\.pdf · p\.17:\*\* "Code will be released\."/);
  assert.ok(quote.includes(CITE_HINT));
  assert.match(formatQuote({ file: 'a.pdf', page: 2, text: 'x', action: 'ask' }), /Question: $/);
  assert.match(formatQuote({ file: 'a.pdf', page: 2, text: 'x', action: 'check' }), /^> .*\n\nCheck this passage:.*Cite places in the PDF as \[file\.pdf p\.N "exact words"\]\.$/s);
});

test('appendToDraft keeps what is already typed', () => {
  assert.equal(appendToDraft('', 'Q'), 'Q');
  assert.equal(appendToDraft('my note  \n\n', 'Q'), 'my note\n\nQ');
});

/* ---- the chat ------------------------------------------------------------- */

function fakeCtx({ current = 's1', phase = 'plain', draft = 'typed so far' } = {}) {
  const writes = [];
  const scope = { id: 'scope-of-s1' };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ current }) },
      scope: (id) => (id === 's1' ? scope : undefined),
    },
    conversation: {
      input: {
        for(actx) {
          if (actx !== scope) throw new Error('conversation.input.for requires a session scope');
          return { state: { getSnapshot: () => ({ draft, phase }) }, setDraft: (text) => writes.push(text) };
        },
      },
    },
  };
  return { ctx, writes };
}

test('insertIntoChat appends under the current chat draft', () => {
  const { ctx, writes } = fakeCtx();
  assert.deepEqual(insertIntoChat(ctx, '> quote'), { ok: true });
  assert.deepEqual(writes, ['typed so far\n\n> quote']);
});

test('insertIntoChat explains why it could not', () => {
  assert.match(insertIntoChat(fakeCtx({ current: null }).ctx, 'x').reason, /open a chat first/);
  assert.match(insertIntoChat(fakeCtx({ current: 's2' }).ctx, 'x').reason, /still loading/);
  const busy = fakeCtx({ phase: 'submitting' });
  assert.match(insertIntoChat(busy.ctx, 'x').reason, /busy/);
  assert.equal(busy.writes.length, 0, 'never writes over a message that is being sent');
});

/* ---- page citations ------------------------------------------------------- */

test('findPageCitations reads the citation forms models write', () => {
  const text = 'see [p.17], [p. 3], [pp.4-5], [main.pdf p.9], [p.12, p.20] but not [x] or [page] or p.7';
  const hits = findPageCitations(text);
  assert.deepEqual(hits.map((h) => h.page), [17, 3, 4, 9, 12]);
  assert.equal(hits[3].file, 'main.pdf');
  for (const hit of hits) assert.equal(text.slice(hit.index, hit.index + hit.length).startsWith('['), true);
});

test('the viewer registry sends a citation to the named PDF, else the last one used', async () => {
  const registry = new ViewerRegistry();
  registry.add('a', 'main.pdf', { id: 'A' });
  await new Promise((r) => setTimeout(r, 5));
  registry.add('b', 'supplementary.pdf', { id: 'B' });
  assert.equal(registry.target('main.pdf').view.id, 'A');
  assert.equal(registry.target(undefined).view.id, 'B', 'no file named: the most recent');
  await new Promise((r) => setTimeout(r, 5));
  registry.touch('a');
  assert.equal(registry.target(undefined).view.id, 'A');
  assert.equal(registry.target('other.pdf').view.id, 'A', 'an unknown file falls back to the most recent');
});

/* ---- the bundle, loaded the way dsh loads it ------------------------------- */

function loadClient() {
  const code = readFileSync(join(here, '../lib/client.js'), 'utf8');
  let loaded;
  const React = { createElement: () => null, useEffect() {}, useRef: () => ({}), useState: (v) => [v, () => {}], useCallback: (f) => f };
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, exports: factory((n) => (n === 'react' ? React : undefined)) }; } } },
    console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder, Intl, encodeURIComponent, decodeURIComponent,
    structuredClone, queueMicrotask, Promise,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;
  vm.runInNewContext(code, sandbox);
  return loaded;
}

test('the bundle registers an external-band .pdf preview with a body, using only declared services', () => {
  const client = loadClient();
  assert.equal(client.id, 'dsh-cite-lens');
  const registered = [];
  const slots = [];
  const ctx = {
    effect: (fn) => fn(),
    documentPreviews: { register: (entry) => { registered.push(entry); return () => {}; } },
    slots: { inject: (_n, fn) => fn(), register: (meta, component) => { slots.push({ meta, component }); return () => {}; } },
    sessions: {},
    conversation: {},
  };
  const declared = new Set(client.exports.inject);
  const guarded = new Proxy(ctx, {
    get(target, key) {
      if (key !== 'effect' && !declared.has(key)) throw new Error(`cannot get property "${String(key)}" without inject`);
      return target[key];
    },
  });
  client.exports.apply(guarded);
  assert.equal(registered.length, 1);
  assert.equal(JSON.stringify(registered[0].extensions), '["pdf"]');
  // dsh ranks the external band above its own 'builtin' renderers, which is
  // what takes the PDF over from the built-in view.
  assert.equal(registered[0].priority, 'extension', 'ranks above the built-in PDF view');
  assert.equal(JSON.stringify(registered[0].binaryExtensions), '["pdf"]', 'a PDF is never the text fallback');
  assert.equal(registered[0].loading, 'bytes-complete');
  assert.equal(slots[0].meta.name, 'sidebar.right.tab.document');
  assert.equal(slots[0].meta.key, registered[0].id);
  assert.ok(client.exports.inject.includes('sessions') && client.exports.inject.includes('conversation'));
});

test('a named citation finds its chat on both dsh lines, and says so when there is none', () => {
  const client = loadClient();
  const opened = [];
  const withChat = (snapshot, mounted) => ({
    sessions: { list: { getSnapshot: () => snapshot } },
    sidebarRight: { openResource: (address) => opened.push(address), ...(mounted ? { mounted: { getSnapshot: () => mounted } } : {}) },
  });

  // dsh 0.1.x: the sessions list carries the selected session.
  assert.equal(client.exports.openPdf(withChat({ current: 's-old' }), 'main.pdf'), true);
  assert.match(opened.at(-1), /^dsh-resource:\/\/file\/session\/s-old\/main\.pdf$/);

  // dsh 0.2.x: the snapshot is { ids, byId, phase } with no selection at all —
  // the session on screen is what a click has to resolve against.
  assert.equal(client.exports.openPdf(withChat({ ids: [], byId: {}, phase: 'ready' }, 's-screen'), 'paper/main.pdf'), true);
  assert.equal(opened.at(-1), 'dsh-resource://file/session/s-screen/paper/main.pdf', 'subpaths survive');

  // An absolute path needs no chat at all.
  assert.equal(client.exports.openPdf(withChat({ ids: [], byId: {}, phase: 'ready' }), 'C:/papers/main.pdf'), true);
  assert.equal(opened.at(-1), 'dsh-resource://file/absolute/C%3A/papers/main.pdf');

  // No chat anywhere: false, so the click can explain itself instead of opening nothing.
  assert.equal(client.exports.openPdf(withChat({ ids: [], byId: {}, phase: 'ready' }), 'main.pdf'), false);
  assert.equal(opened.length, 3);
});

/* ---- pdf.js reads text, as the text layer will ------------------------------ */

/** A one-page PDF with two lines of text, built by hand. */
function tinyPdf() {
  const content = 'BT /F1 18 Tf 72 720 Td (Code will be released upon publication.) Tj 0 -30 Td (Second line on page one.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

test('pdf.js (the bundled version) extracts the text the selection layer is built from', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: tinyPdf(), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  assert.equal(doc.numPages, 1);
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map((item) => item.str).join(' ');
  assert.match(text, /Code will be released upon publication\./);
  assert.match(text, /Second line on page one\./);
  await task.destroy();
});
