// End-to-end: installs the packaged extension into a throwaway VS Code profile, opens a
// workspace holding a schema split over two files in a git repository (released as v0.9.0
// and v1.0.0, changed since), and uses the extension the way a person would: shortcuts,
// menus (the Explorer's too), quick picks, git, the diff editor, the report's controls,
// release notes and the Problems panel. Then it opens a copy of the workspace again,
// untrusted, to check Restricted Mode. Linux, with `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [graphql-breaking-changes-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;
const graphql = createRequire(import.meta.url)('graphql');

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'graphql-breaking-changes-e2e-')));
const ws = path.join(root, 'bookshop');
const out = path.join(root, 'shots');
mkdirSync(path.join(ws, 'api', 'types'), { recursive: true });
mkdirSync(out);

// The sample schemas, with the Review type and Book.reviews moved to a file of their own,
// so that the other files of a split schema are read at the right version too.
const REVIEW = /\ntype Review[^{]*\{[^}]*\}\n/;
const split = (text) => text.replace(REVIEW, '\n').replace(/^  reviews\(.*\n/m, '');
const sibling = (text) => {
  const review = text.match(REVIEW)[0].trim();
  const reviews = text.match(/^  reviews\(.*$/m)[0];
  return `${review}\n\nextend type Book {\n${reviews}\n}\n`;
};
const sample = (f) => readFileSync(`samples/${f}`, 'utf8');
const v1 = split(sample('bookshop-v1.graphql'));
const v2 = split(sample('bookshop-v2.graphql'));
const schema = path.join(ws, 'api', 'schema.graphql');
const reviews = path.join(ws, 'api', 'types', 'reviews.graphql');
writeFileSync(schema, v1);
writeFileSync(reviews, sibling(sample('bookshop-v1.graphql')));
writeFileSync(path.join(ws, 'broken.graphql'), 'type Query {\n  x: Int\n}\n');
writeFileSync(path.join(ws, 'notes.graphql'), 'query Books {\n  books(first: 3) {\n    edges { node { title } }\n  }\n}\n');
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const git = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
git('init', '-q');
// An older release without updateOrder and the loyalty tiers, to write release notes between two tags.
const v09 = v1
  .replace(/^  updateOrder.*\n/m, '')
  .replace(/^  loyalty: LoyaltyTier\n/m, '')
  .replace(/\nenum LoyaltyTier \{[^}]*\}\n/, '\n')
  .replace('version 1.', 'version 0.9.');
writeFileSync(schema, v09);
git('add', '.');
git('commit', '-qm', 'Bookshop 0.9');
git('tag', 'v0.9.0');
writeFileSync(schema, v1);
git('add', '.');
git('commit', '-qm', 'Bookshop 1.0');
git('tag', 'v1.0.0');
git('branch', 'release/1.x');
// Since the release: version 2 in the working copy, not committed.
writeFileSync(schema, v2);
writeFileSync(reviews, sibling(sample('bookshop-v2.graphql')));
writeFileSync(path.join(ws, 'broken.graphql'), 'type Query {\n  x: Int\n  y:\n}\n');
// The released schema as an introspection result, named like anything else: found by content.
const introspection = JSON.stringify({ data: graphql.introspectionFromSchema(graphql.buildSchema(sample('bookshop-v1.graphql')), { descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true, inputValueDeprecation: true }) }, null, 2);
writeFileSync(path.join(ws, 'api', 'schema.json'), introspection);
// Pairs for the Explorer: told apart by their names, and not at all.
const explorerFiles = (dir) => {
  writeFileSync(path.join(dir, 'bookshop.graphql'), sample('bookshop-v1.graphql'));
  writeFileSync(path.join(dir, 'bookshop-v2.graphql'), sample('bookshop-v2.graphql'));
  writeFileSync(path.join(dir, 'left.graphql'), sample('bookshop-v1.graphql'));
  writeFileSync(path.join(dir, 'right.graphql'), sample('bookshop-v2.graphql'));
};
explorerFiles(ws);

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'git.openRepositoryInParentFolders': 'never',
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'editor.autoClosingQuotes': 'never',
  'editor.autoClosingBrackets': 'never',
  'editor.formatOnType': false,
  'editor.autoIndent': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  // Menus in the page, so the Explorer's context menu can be clicked; a click only selects.
  'window.menuStyle': 'custom',
  'workbench.list.openMode': 'doubleClick',
};
let vs = new VSCode(root);
vs.install(vsix, settings);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-')}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// In the webview.
const W = {
  counts: `Object.fromEntries([...document.querySelectorAll('.chip')].map((c) => [c.dataset.level, +c.querySelector('b').textContent]))`,
  sides: `[...document.querySelectorAll('#sides .label')].map((e) => e.textContent)`,
  rows: `document.querySelectorAll('.change').length`,
  groups: `[...document.querySelectorAll('.group .ghead')].map((g) => g.querySelector('.path').textContent)`,
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
  row: (text) => `[...document.querySelectorAll('.change')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`,
};
let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });

/** Moves keyboard focus out of a webview, back to the workbench. */
async function focusWorkbench() {
  await vs.clickElement(`document.querySelector('.part.sidebar .composite.title')`);
}
async function openFile(name) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await focusWorkbench();
  await vs.key('p', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
  await vs.type(name);
  await sleep(700);
  await vs.key('Enter');
  const base = name.split('/').pop();
  await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith(base)), { what: `${name} to open` });
  await sleep(400);
  await focusEditor();
}
/** A real click into the active text editor, so typing and shortcuts land there. */
async function focusEditor() {
  await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-instance .monaco-editor .view-lines')`);
  await sleep(150);
}
async function shotOfEditor(file) {
  const r = await vs.eval(`(() => { const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  await focusWorkbench();
  await vs.key('k', { ctrl: true });
  await vs.key('w', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).length === 0, { what: 'editors to close' });
}
async function chord(key, mods = {}) {
  await vs.key('k', { ctrl: true });
  await vs.key(key, mods);
}
/** Runs a command that opens a quick pick or input of its own: doesn't wait for it to close. */
async function paletteRun(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'quick input to close' });
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(500);
  await vs.key('Enter');
  await sleep(600);
}
async function goToLine(n) {
  await vs.key('g', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'go to line' });
  await vs.type(String(n));
  await sleep(200);
  await vs.key('Enter');
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'go to line to close' });
  await sleep(300);
}
/** Errors and warnings in the status bar. */
async function problemCounts() {
  const t = await vs.eval(`document.querySelector('[id="status.problems"]')?.textContent ?? ''`);
  const [errors = 0, warnings = 0] = (t.match(/\d+/g) ?? []).map(Number);
  return { errors, warnings };
}
async function statusBarSelection() {
  return vs.eval(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
}
async function setClipboard(text) {
  // Through an untitled editor, as a user would: VS Code's own clipboard, not the page's.
  await newUntitled();
  await vs.type(text);
  await vs.key('a', { ctrl: true });
  await vs.key('c', { ctrl: true });
  await sleep(200);
  await vs.command('View: Revert and Close Editor');
}
async function newUntitled() {
  await focusWorkbench();
  await vs.key('n', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).some((t) => /^Untitled-\d+$/.test(t)), { what: 'untitled editor' });
  await sleep(300);
}
async function editorText() {
  return vs.eval(`[...document.querySelectorAll('.editor-group-container.active .editor-instance .view-lines .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((l) => l.textContent).join('\\n').replace(/\\u00a0/g, ' ')`);
}
async function quickItems() {
  return vs.eval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map((r) => (r.getAttribute('aria-label') || r.textContent).trim())`);
}
async function writeWorkspaceSettings(obj) {
  mkdirSync(path.join(ws, '.vscode'), { recursive: true });
  writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify(obj, null, 2));
}
async function reportTab() {
  await vs.showTab('Schema changes');
}
/** Selects two files at the top of the Explorer and runs Compare Schemas from its context menu. */
async function explorerCompare(a, b) {
  await vs.command('View: Show Explorer');
  const row = (n) => `[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((r) => r.textContent.trim() === ${JSON.stringify(n)})`;
  await waitFor(() => vs.eval(`!!${row(a)} && !!${row(b)}`), { what: `${a} and ${b} in the Explorer` });
  await vs.clickElement(row(a));
  const box = await vs.eval(`(() => { const r = ${row(b)}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await vs.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 2 });
  await waitFor(async () => (await vs.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row.selected')].length`)) === 2, { what: 'two files selected' });
  await vs.clickElement(row(b), 'right');
  const item = `[...document.querySelectorAll('.context-view .action-item')].find((x) => x.textContent.includes('Compare Schemas for Breaking Changes'))`;
  await waitFor(() => vs.eval(`!!${item}`), { what: 'Compare Schemas in the context menu' });
  await vs.clickElement(item);
}

try {
  console.log(`VS Code profile: ${root}`);
  await vs.launch(ws);
  // Startup: the Explorer lists the workspace and the extensions have settled.
  await waitFor(() => vs.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].some((r) => r.textContent.trim() === 'api')`), { what: 'the workspace in the Explorer', timeout: 30000 });
  await sleep(3000);

  await step('Ctrl+K B on a schema offers branches and tags, and compares with the pick', async () => {
    await openFile('api/schema.graphql');
    await chord('b');
    await waitFor(() => vs.quickInputVisible(), { what: 'ref picker' });
    await waitFor(async () => (await quickItems()).some((i) => i.includes('v1.0.0')), { what: 'tags in the picker' });
    const items = await quickItems();
    ok(items.some((i) => i.includes('release/1.x')), `branches listed: ${items.join(' | ')}`);
    ok(items.some((i) => i.includes('HEAD')), 'HEAD listed');
    await vs.pickQuickItem('v1.0.0');
    ctx = await vs.webview('schema.graphql (v1.0.0)');
    eq(await w(W.sides), ['schema.graphql (v1.0.0)', 'schema.graphql'], 'sides');
    await until(`document.querySelectorAll('.change').length > 0`, 'changes');
    const counts = await w(W.counts);
    eq(counts, { error: 12, warning: 8, info: 19 }, 'counts');
    eq(await w(`document.getElementById('cards').textContent`), '', 'no notes: other files and other versions of the schema in the folders are left out');
    ok((await vs.editorTabs()).some((t) => t.includes('Schema changes: schema.graphql (v1.0.0) → schema.graphql')), 'panel title');
    ok(await w(`[...document.querySelectorAll('#sides .ver')].every((v) => /SDL · \\d+ types/.test(v.textContent))`), 'SDL and type counts shown');
  });

  await step('the report groups changes by type, the schema first, with kind badges and the field of each row', async () => {
    const groups = await w(W.groups);
    eq(groups[0], 'Schema', 'first group');
    ok(groups.includes('Book') && groups.includes('Query') && groups.includes('@auth'), `groups: ${groups.join(', ')}`);
    eq(groups[groups.length - 1], '@auth', 'directives last');
    ok(await w(`!!document.querySelector('.kind.k-enum') && !!document.querySelector('.kind.k-input') && !!document.querySelector('.kind.k-directive')`), 'kind badges');
    eq(await w(`${W.row('Book.isbn')}.querySelector('.fld').textContent`), 'isbn', 'field chip');
  });

  await step('a type in another file of the split schema is read at the same version', async () => {
    // reviews.graphql changed Book.reviews' default since v1.0.0; v1.0.0's copy was read from git, not the disk.
    const row = await w(`${W.row('Book.reviews')}?.textContent ?? ''`);
    ok(row.includes('argument-default-changed'), `Book.reviews row: ${row}`);
    ok(/old reviews\.graphql:\d+/.test(row), `points into reviews.graphql: ${row}`);
    ok(await w(`!!${W.row('Review now implements Node')}`), 'Review implements Node, from the split file');
  });

  await step('screen readers: a status line instead of a live list, labelled counts, focus kept', async () => {
    ok(await w(`!document.querySelector('[aria-live]:not(#status)')`), 'no live region around the list');
    const status = await w(`document.getElementById('status').textContent`);
    ok(/^\d+ of \d+ changes shown, on \d+ types$/.test(status), `status: ${status}`);
    ok(await w(`[...document.querySelectorAll('.ghead')].some((g) => /\\d+ breaking,/.test(g.textContent))`), 'counts say what they count');
    await w(`(() => { const c = document.querySelector('.chip.info'); c.focus(); c.click(); })()`);
    eq(await w(`document.activeElement?.dataset?.level`), 'info', 'focus on the chip after hiding');
    await until(`/^\\d+ of \\d+ changes shown/.test(document.getElementById('status').textContent)`, 'status updated');
    await w(`document.activeElement.click()`);
    eq(await w(`document.activeElement?.dataset?.level`), 'info', 'focus on the chip after showing');
  });

  if (shotsFor) {
    mkdirSync(shotsFor, { recursive: true });
    await w(`window.scrollTo(0, 0)`);
    await sleep(400);
    await shotOfEditor(path.join(shotsFor, 'report-dark.png'));
  }

  await step('level chips hide and show levels', async () => {
    const before = await w(W.rows);
    await w(W.click('.chip.info'));
    const after = await w(W.rows);
    ok(after < before, `rows ${before} → ${after}`);
    ok(!(await w(`[...document.querySelectorAll('.change')].some((r) => r.classList.contains('info'))`)), 'no info rows');
    eq(await w(`document.querySelector('.chip.info').getAttribute('aria-pressed')`), 'false', 'pressed state');
    await w(W.click('.chip.info'));
    eq(await w(W.rows), before, 'all back');
  });

  await step('search filters by type, field, id or text', async () => {
    await w(`(() => { const s = document.getElementById('search'); s.value = 'publishedAt'; s.dispatchEvent(new Event('input')); })()`);
    await until(`document.querySelectorAll('.change').length === 1`, 'one match');
    ok(await w(`${W.row('publishedAt')}.textContent.includes('input-field-added-required')`), 'the match');
    await w(`(() => { const s = document.getElementById('search'); s.value = 'nothing-like-this'; s.dispatchEvent(new Event('input')); })()`);
    await until(`!!document.getElementById('clearFilter')`, 'empty state');
    await w(W.click('#clearFilter'));
    await until(`document.querySelectorAll('.change').length > 10`, 'filter cleared');
    eq(await w(`document.activeElement?.id`), 'search', 'focus on the search box, not lost');
  });

  await step('groups collapse and expand', async () => {
    await w(`document.querySelector('.group[data-key="type Book"] .ghead').click()`);
    ok(await w(`document.querySelector('.group[data-key="type Book"]').classList.contains('collapsed')`), 'collapsed');
    await w(`document.querySelector('.group[data-key="type Book"] .ghead').click()`);
    ok(await w(`!document.querySelector('.group[data-key="type Book"]').classList.contains('collapsed')`), 'expanded');
  });

  await step('keyboard: one tab stop for the rows, arrows reach every header, folded ones too', async () => {
    eq(await w(`document.querySelectorAll('.change[tabindex="0"]').length`), 1, 'rows in the tab order');
    eq(await w(`[...document.querySelectorAll('.change[tabindex="-1"] button')].filter((b) => b.tabIndex !== -1).length`), 0, "other rows' buttons out of the tab order");
    await w(`document.querySelector('.group[data-key="type Book"] .ghead').click()`);
    const key = (k) => `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`;
    // The last row before the folded group, then down: its header.
    await w(`(() => { const g = document.querySelector('.group[data-key="type Book"]'); let p = g.previousElementSibling; const rows = p.querySelectorAll('.change'); rows[rows.length - 1].focus(); })()`);
    eq(await w(`document.activeElement.tabIndex`), 0, 'the focused row is the tab stop');
    await w(key('ArrowDown'));
    ok(await w(`document.activeElement === document.querySelector('.group[data-key="type Book"] .ghead')`), 'ArrowDown lands on the folded header');
    await w(`document.activeElement.click()`);
    ok(await w(`!document.querySelector('.group[data-key="type Book"]').classList.contains('collapsed')`), 'opened from the keyboard');
    await w(key('ArrowDown'));
    ok(await w(`document.activeElement.closest('.group')?.dataset.key === 'type Book' && document.activeElement.classList.contains('change')`), 'then its first row');
  });

  await step('clicking a change opens the new schema at its line', async () => {
    const line = await w(`(() => { const r = ${W.row('publishedAt')}; return r.querySelector('.loc.new').textContent; })()`);
    await w(`${W.row('publishedAt')}.querySelector('.msg').click()`);
    const n = line.match(/(\d+)$/)[1];
    await waitFor(async () => (await statusBarSelection()).includes(`Ln ${n},`), { what: `cursor on line ${n}` });
    await reportTab();
    ctx = await vs.webview('schema.graphql (v1.0.0)');
  });

  await step('the old side opens the file as of the ref', async () => {
    await w(`${W.row('Query.author removed')}.querySelector('.loc.old').click()`);
    await waitFor(async () => (await vs.editorTabs()).some((t) => /schema\.graphql.*v1\.0\.0/.test(t)), { what: 'schema.graphql at v1.0.0' });
    await waitFor(async () => /Ln \d+,/.test(await statusBarSelection()), { what: 'cursor' });
    await reportTab();
    ctx = await vs.webview('schema.graphql (v1.0.0)');
  });

  await step('Copy as Markdown puts a changelog on the clipboard', async () => {
    await w(W.click('#copy'));
    await sleep(400);
    await newUntitled();
    try {
      await vs.key('v', { ctrl: true });
      await sleep(400);
      await vs.key('Home', { ctrl: true });
      await sleep(300);
      const md = await editorText();
      ok(md.startsWith('### Schema changes: schema.graphql (v1.0.0) → schema.graphql'), md.slice(0, 200));
      ok(md.includes('#### Breaking changes'), 'breaking heading');
      ok(md.includes('- `type Query`') && md.includes('  - Field `Query.author` removed'), `grouped by type: ${md.slice(0, 1500)}`);
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
    await reportTab();
    ctx = await vs.webview('schema.graphql (v1.0.0)');
  });

  await step('Release Notes in the report opens release notes for clients', async () => {
    await w(W.click('#releaseNotes'));
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('## Schema changes')), { what: 'release notes editor' });
    try {
      await sleep(600);
      const md = await editorText();
      ok(md.startsWith('## Schema changes in the working copy'), md.slice(0, 300));
      ok(md.includes('Changes since `v1.0.0`') && md.includes('### Breaking changes') && md.includes('### Dangerous changes'), md.slice(0, 1200));
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
    await reportTab();
    ctx = await vs.webview('schema.graphql (v1.0.0)');
  });

  await step('Ignore… writes a rule to the workspace settings and the report dims the change', async () => {
    const before = await w(W.counts);
    await w(`${W.row('OrderStatus.REFUNDED')}.querySelector('.ign').click()`);
    await waitFor(() => vs.quickInputVisible(), { what: 'ignore picker' });
    await vs.pickQuickItem('Every enum-value-added');
    const file = path.join(ws, '.vscode', 'settings.json');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('enum-value-added'), { what: 'workspace settings' });
    await until(`(${W.counts}).ignored > 0`, 'ignored count');
    const after = await w(W.counts);
    ok(after.warning < before.warning, `warnings ${before.warning} → ${after.warning}`);
    ok(await w(`!!document.querySelector('.change.is-ignored')`), 'dimmed row');
    ok(await w(`document.querySelector('.change.is-ignored').getAttribute('aria-label').startsWith('dangerous, ignored:')`), 'announced as ignored');
    await w(W.click('.chip.ignored'));
    ok(!(await w(`!!document.querySelector('.change.is-ignored')`)), 'ignored hidden');
    await w(W.click('.chip.ignored'));
  });

  await step('warnings as errors moves dangerous changes into breaking', async () => {
    const before = await w(W.counts);
    const file = path.join(ws, '.vscode', 'settings.json');
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    await writeWorkspaceSettings({ ...cur, 'graphqlBreakingChanges.treatWarningsAsErrors': true });
    await until(`(${W.counts}).warning === 0`, 'no warnings left');
    eq((await w(W.counts)).error, before.error + before.warning, 'errors include warnings');
    ok(await w(`document.querySelector('.summary .note')?.textContent.includes('Dangerous changes count as breaking')`), 'note');
    await writeWorkspaceSettings({});
    await until(`(${W.counts}).warning > 0 && !(${W.counts}).ignored`, 'settings cleared');
  });

  await step('schemaFiles "" compares the one file, without the split', async () => {
    await writeWorkspaceSettings({ 'graphqlBreakingChanges.schemaFiles': '' });
    await until(`!${W.row('Book.reviews')} && !${W.row('Review now implements')}`, 'the other file left out');
    await writeWorkspaceSettings({});
    await until(`!!${W.row('Book.reviews')}`, 'merged again');
  });

  await step('the report follows edits to the schema', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await chord('b');
    await vs.pickQuickItem('v1.0.0');
    ctx = await vs.webview('schema.graphql (v1.0.0)');
    await until(`(${W.counts}).error > 0`, 'report');
    const before = (await w(W.counts)).error;
    await openFile('api/schema.graphql');
    try {
      // The removed enum value put back, pasted into the editor so it isn't indented.
      const lines = readFileSync(schema, 'utf8').split('\n');
      await setClipboard('  CHILDREN\n');
      await openFile('api/schema.graphql');
      await goToLine(`${lines.findIndex((l) => l === '  POETRY') + 1}:1`);
      await vs.key('v', { ctrl: true });
      await sleep(300);
      await vs.screenshot(path.join(out, 'edit-typed.png'));
      await reportTab();
      ctx = await vs.webview('schema.graphql (v1.0.0)');
      await until(`(${W.counts}).error === ${before - 1}`, 'one breaking change fewer', 8000).catch(async (e) => {
        throw new Error(`${e.message}; counts ${JSON.stringify(await w(W.counts))}, before ${before}, notes: ${await w(`document.getElementById('cards').textContent`)}`);
      });
      ok(!(await w(`!!${W.row('Genre.CHILDREN removed')}`)), 'the removal is gone');
    } finally {
      await openFile('api/schema.graphql');
      await vs.command('File: Revert File');
    }
    await reportTab();
    ctx = await vs.webview('schema.graphql (v1.0.0)');
    await until(`(${W.counts}).error === ${before}`, 'back after revert', 8000);
  });

  await step('swap turns the comparison around', async () => {
    await w(W.click('#swap'));
    await until(`${W.sides}[0] === 'schema.graphql'`, 'swapped');
    ok((await w(W.counts)).error > 0, 'still has changes');
    await w(W.click('#swap'));
    await until(`${W.sides}[0] === 'schema.graphql (v1.0.0)'`, 'swapped back');
  });

  await step('Compare with HEAD from the Command Palette', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await vs.command('GraphQL Breaking Changes: Compare with HEAD');
    ctx = await vs.webview('schema.graphql (HEAD)');
    await until(`document.querySelectorAll('.change').length > 0`, 'changes');
  });

  await step('files that are not schemas: no shortcut and no commands for them', async () => {
    await closeAll();
    await openFile('notes.graphql');
    await chord('b');
    await sleep(1200);
    ok(!(await vs.quickInputVisible()), 'the shortcut does nothing on a query document');
    await vs.key('F1');
    await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
    await vs.type('GraphQL Breaking Changes: Compare with');
    await sleep(700);
    const items = await quickItems();
    await vs.key('Escape');
    ok(!items.some((i) => /Compare with (HEAD|Git Branch|Another Schema)/.test(i)), `palette: ${items.join(' | ')}`);
  });

  await step('Explorer: two schemas, the old one told by the names', async () => {
    await closeAll();
    await explorerCompare('bookshop-v2.graphql', 'bookshop.graphql');
    ctx = await vs.webview('bookshop.graphql');
    eq(await w(W.sides), ['bookshop.graphql', 'bookshop-v2.graphql'], 'old, then new');
    await until(`(${W.counts}).error > 0`, 'breaking changes');
  });

  await step('Explorer: when nothing says which is older, it asks', async () => {
    await closeAll();
    await explorerCompare('left.graphql', 'right.graphql');
    await waitFor(async () => (await vs.eval(`document.querySelector('.quick-input-widget .quick-input-title')?.textContent ?? ''`)).includes('Which is the old version?'), { what: 'which is older' });
    await vs.pickQuickItem('right.graphql');
    ctx = await vs.webview('right.graphql');
    eq(await w(W.sides), ['right.graphql', 'left.graphql'], 'as picked');
  });

  await step('Explorer: a file that is not a schema gets a clear message', async () => {
    await closeAll();
    await explorerCompare('notes.graphql', 'bookshop.graphql');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes("doesn't look like a GraphQL schema")), { what: 'not a schema message' });
    await vs.clearNotifications();
  });

  await step('Compare with Another Schema finds schemas by content, introspection JSON included', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await paletteRun('GraphQL Breaking Changes: Compare with Another Schema');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('schema.json')), { what: 'schema.json listed' });
    const items = await quickItems();
    ok(!items.some((i) => i.includes('notes.graphql')), `query document not listed: ${items.join(' | ')}`);
    await vs.pickQuickItem('schema.json');
    ctx = await vs.webview('schema.json');
    eq(await w(W.sides), ['schema.json', 'schema.graphql'], 'sides');
    await until(`(${W.counts}).error > 0`, 'changes');
    ok(await w(`[...document.querySelectorAll('#sides .ver')].some((v) => v.textContent.startsWith('introspection'))`), 'introspection side marked');
    // A change on the introspection side opens the JSON at the type.
    await w(`${W.row('Query.author removed')}.querySelector('.loc.old').click()`);
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('schema.json')), { what: 'schema.json opened' });
    await waitFor(async () => /Ln \d+,/.test(await statusBarSelection()), { what: 'cursor' });
    const text = await editorText();
    ok(text.includes('"name": "author"'), `the JSON at the field: ${text.slice(0, 200)}`);
  });

  await step('a schema that does not parse says where', async () => {
    await closeAll();
    await openFile('broken.graphql');
    await vs.command('GraphQL Breaking Changes: Compare with HEAD');
    ctx = await vs.webview('broken.graphql (HEAD)');
    await until(`!!document.querySelector('.card.error')`, 'error card');
    const text = await w(`document.querySelector('.card.error').textContent`);
    ok(text.includes("Couldn't read the new schema") && /line \d+/.test(text), text);
    ok(await w(`document.getElementById('copy').disabled && document.getElementById('releaseNotes').disabled`), 'nothing to copy');
    await w(W.click('.card.error .open-error'));
    // The editor opens beside the report; its cursor is on the line the error names.
    const line = String(Number(text.match(/line (\d+)/)[1]));
    await waitFor(() => vs.eval(`[...document.querySelectorAll('.editor-group-container')].some((g) => g.querySelector('.line-numbers.active-line-number')?.textContent.trim() === ${JSON.stringify(line)})`), { what: `cursor at line ${line}` });
  });

  await step('the diff editor title button checks a Source Control diff, split schema and all', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Changes"]')`);
    await waitFor(async () => await vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(800);
    const btn = `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Check This Diff for Breaking Changes"]')`;
    await waitFor(() => vs.eval(`!!${btn}`), { what: 'title button' });
    await vs.clickElement(btn);
    ctx = await vs.webview('schema.graphql (index)');
    eq(await w(W.sides), ['schema.graphql (index)', 'schema.graphql'], 'sides');
    await until(`(${W.counts}).error > 0`, 'breaking changes');
    ok(await w(`!!${W.row('Book.reviews')}`), 'the other file of the split, read from the index');
  });

  await step('Ctrl+K B in a diff editor does the same', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Changes"]')`);
    await waitFor(async () => await vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(800);
    await vs.clickElement(`document.querySelector('.editor-group-container.active .monaco-diff-editor .editor.modified .view-lines')`);
    await chord('b');
    ctx = await vs.webview('schema.graphql (index)');
  });

  await step('a staged diff reads the index with its split schema too', async () => {
    await closeAll();
    git('add', 'api');
    try {
      await openFile('api/schema.graphql');
      // Fully staged: Open Changes shows HEAD against the index.
      const open = `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Changes"]')`;
      await waitFor(async () => {
        await vs.command('Git: Refresh');
        await sleep(500);
        await vs.clickElement(open);
        await sleep(800);
        return (await vs.editorTabs()).some((t) => t.includes('(Index)'));
      }, { what: 'the staged diff', timeout: 20000 });
      const btn = `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Check This Diff for Breaking Changes"]')`;
      await waitFor(() => vs.eval(`!!${btn}`), { what: 'title button' });
      await vs.clickElement(btn);
      ctx = await vs.webview('schema.graphql (HEAD)');
      await until(`(${W.counts}).error > 0`, 'breaking changes');
      ok(await w(`!!${W.row('Book.reviews')}`), 'Book.reviews compared');
      ok(!(await w(`!!${W.row('type Review removed')}`)), 'the other file of the split is read from the index, not reported removed');
    } finally {
      git('reset', '-q');
    }
  });

  await step('Write Release Notes… from the latest tag to the working copy', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await paletteRun('GraphQL Breaking Changes: Write Release Notes');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('latest tag')), { what: 'latest tag offered' });
    const items = await quickItems();
    ok(items[0].includes('v1.0.0') && items[0].includes('latest tag'), `first: ${items[0]}`);
    ok(items.findIndex((i) => i.includes('v1.0.0') && !i.includes('latest')) < 0, 'not listed twice');
    await vs.pickQuickItem('latest tag');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('Working copy')), { what: 'the new side' });
    await vs.pickQuickItem('Working copy');
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('## Schema changes')), { what: 'release notes editor' });
    try {
      await sleep(600);
      const md = await editorText();
      ok(md.startsWith('## Schema changes in the working copy\n\nChanges since `v1.0.0`, in `schema.graphql`.'), md.slice(0, 300));
      ok(md.includes('### Breaking changes') && md.includes('Field `Query.author` removed'), md.slice(0, 1500));
      if (shotsFor) {
        await vs.command('Markdown: Open Preview to the Side');
        await sleep(2500);
        await shotOfEditor(path.join(shotsFor, 'release-notes-dark.png'));
        await vs.command('View: Close Editor');
      }
    } finally {
      await vs.showTab('## Schema');
      await vs.command('View: Revert and Close Editor');
    }
  });

  await step('Write Release Notes… between two tags', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await paletteRun('GraphQL Breaking Changes: Write Release Notes');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('v0.9.0')), { what: 'tags' });
    await vs.pickQuickItem('v0.9.0');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('Working copy')), { what: 'the new side' });
    await waitFor(async () => (await quickItems()).some((i) => i.includes('v1.0.0')), { what: 'tags on the new side' });
    ok(!(await quickItems()).some((i) => i.includes('v0.9.0')), 'the old side is not offered again');
    await vs.pickQuickItem('v1.0.0');
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('## Schema changes')), { what: 'release notes editor' });
    await sleep(600);
    const md = await editorText();
    try {
      ok(md.startsWith('## Schema changes in `v1.0.0`\n\nChanges since `v0.9.0`, in `schema.graphql`. 3 additions, 1 other change.'), md.slice(0, 300));
      ok(md.includes('### Added') && md.includes('Field `Mutation.updateOrder` added') && md.includes('Enum `LoyaltyTier` added') && !md.includes('### Breaking'), md);
    } finally {
      await vs.command('View: Revert and Close Editor');
    }
  });

  await step('baseRef puts breaking changes in the Problems panel', async () => {
    await closeAll();
    await writeWorkspaceSettings({ 'graphqlBreakingChanges.baseRef': 'v1.0.0' });
    await openFile('api/schema.graphql');
    await waitFor(async () => (await problemCounts()).errors > 0, { what: 'errors in the status bar', timeout: 15000 });
    await vs.command('View: Focus Problems (Errors, Warnings, Infos)');
    await waitFor(() => vs.eval(`[...document.querySelectorAll('.markers-panel .monaco-list-row')].some((r) => r.textContent.includes('field-became-nullable'))`), { what: 'problem rows' });
    const rows = await vs.eval(`[...document.querySelectorAll('.markers-panel .monaco-list-row')].map((r) => r.textContent)`);
    ok(rows.some((r) => r.includes('since v1.0.0')), `source shown: ${rows.slice(0, 3).join(' | ')}`);
    ok(rows.some((r) => r.includes("Field 'Book.isbn' can now be 'null'")), `message: ${rows.slice(0, 6).join(' | ')}`);
    // A removal has no place in the new schema: it shows on what is left of it.
    ok(rows.some((r) => r.includes("Field 'Query.author' removed")), `removal: ${rows.join(' | ')}`);
    if (shotsFor) {
      await openFile('api/schema.graphql');
      const lines = readFileSync(schema, 'utf8').split('\n');
      await goToLine(lines.findIndex((l) => l.includes('isbn: String')) - 4);
      await vs.command('View: Focus Problems (Errors, Warnings, Infos)');
      await sleep(1200);
      await vs.screenshot(path.join(shotsFor, 'problems-dark.png'));
    }
  });

  await step('a change in another file of the split schema is a problem in that file', async () => {
    // reviews.graphql, merged with the schema, changed Book.reviews' default since v1.0.0.
    await openFile('api/types/reviews.graphql');
    await waitFor(() => vs.eval(`!!document.querySelector('.editor-group-container.active .squiggly-warning, .editor-group-container.active .squiggly-error')`), { what: 'a problem underlined in reviews.graphql', timeout: 15000 });
  });

  await step('a part of a split schema open on its own is checked as the whole schema', async () => {
    // Only reviews.graphql open: it is checked through api/schema.graphql, the main file
    // whose split brings it in, so Book (defined there) is not taken for removed.
    await closeAll();
    await openFile('api/types/reviews.graphql');
    await waitFor(() => vs.eval(`!!document.querySelector('.editor-group-container.active .squiggly-warning, .editor-group-container.active .squiggly-error')`), { what: 'a problem underlined in reviews.graphql', timeout: 15000 });
    await vs.command('View: Focus Problems (Errors, Warnings, Infos)');
    await sleep(800);
    const rows = await vs.eval(`[...document.querySelectorAll('.markers-panel .monaco-list-row')].map((r) => r.textContent)`);
    // The whole schema was checked: the main file's own problems are listed too.
    ok(rows.some((r) => r.includes("Field 'Book.isbn' can now be 'null'")), `the main file's problems: ${rows.join(' | ')}`);
    ok(!rows.some((r) => r.includes('type-removed') || r.includes('not-checked')), `no false removals: ${rows.join(' | ')}`);
    // Its quick fix opens the whole schema's report.
    const lines = readFileSync(reviews, 'utf8').split('\n');
    await openFile('api/types/reviews.graphql');
    const at = lines.findIndex((l) => l.includes('reviews('));
    await goToLine(`${at + 1}:${lines[at].indexOf('first') + 2}`);
    await vs.command('Quick Fix...');
    await waitFor(() => vs.eval(`!!document.querySelector('.action-widget')`), { what: 'quick fix menu' });
    await vs.clickElement(`[...document.querySelectorAll('.action-widget .monaco-list-row')].find((r) => r.textContent.includes('Show all schema changes'))`);
    ctx = await vs.webview('schema.graphql (v1.0.0)');
    await until(`(${W.counts}).error > 0`, 'report of the whole schema');
    await closeAll();
    await openFile('api/schema.graphql');
  });

  await step('the quick fix opens the report since the baseline', async () => {
    await openFile('api/schema.graphql');
    const lines = readFileSync(schema, 'utf8').split('\n');
    await goToLine(`${lines.findIndex((l) => l === '  isbn: String') + 1}:3`);
    await vs.command('Quick Fix...');
    await waitFor(() => vs.eval(`!!document.querySelector('.action-widget')`), { what: 'quick fix menu' });
    const items = await vs.eval(`[...document.querySelectorAll('.action-widget .monaco-list-row')].map((r) => r.textContent)`);
    ok(items.some((t) => t.includes('Ignore field-became-nullable')), `items: ${items.join(' | ')}`);
    await vs.clickElement(`[...document.querySelectorAll('.action-widget .monaco-list-row')].find((r) => r.textContent.includes('Show all schema changes'))`);
    ctx = await vs.webview('schema.graphql (v1.0.0)');
    await until(`(${W.counts}).error > 0`, 'report');
    await writeWorkspaceSettings({});
    await openFile('api/schema.graphql');
    await waitFor(async () => (await problemCounts()).errors === 0, { what: 'problems cleared', timeout: 10000 });
  });

  await step('a baseRef that names nothing says so instead of showing no problems', async () => {
    await closeAll();
    await writeWorkspaceSettings({ 'graphqlBreakingChanges.baseRef': 'v1.0.O' });
    await openFile('api/schema.graphql');
    const toast = `[...document.querySelectorAll('.notification-list-item-message')].some((t) => t.textContent.includes('"v1.0.O" in graphqlBreakingChanges.baseRef is not a branch, tag or commit'))`;
    await waitFor(() => vs.eval(toast), { what: 'a warning about the ref', timeout: 15000 });
    await vs.command('Notifications: Clear All Notifications');
    await writeWorkspaceSettings({});
  });

  if (shotsFor) {
    await step('light theme screenshot', async () => {
      await vs.command('View: Close Panel');
      await closeAll();
      await openFile('api/schema.graphql');
      await chord('b');
      await vs.pickQuickItem('v1.0.0');
      ctx = await vs.webview('schema.graphql (v1.0.0)');
      const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
      writeFileSync(userSettings, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
      await sleep(2000);
      for (const l of ['warning', 'info']) await w(`(() => { const c = document.querySelector('.chip.${l}'); if (c.getAttribute('aria-pressed') === 'true') c.click(); })()`);
      await sleep(500);
      await shotOfEditor(path.join(shotsFor, 'report-light.png'));
      for (const l of ['warning', 'info']) await w(W.click(`.chip.${l}`));
      writeFileSync(userSettings, JSON.stringify(settings, null, 2));
      await sleep(1500);
    });
  }

  await step('the report comes back after Reload Window', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await chord('b');
    await vs.pickQuickItem('v1.0.0');
    ctx = await vs.webview('schema.graphql (v1.0.0)');
    await w(W.click('.chip.info'));
    await sleep(300);
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('Schema changes')), { timeout: 20000, what: 'restored tab' });
    await reportTab();
    ctx = await vs.webview('schema.graphql (v1.0.0)', 25000);
    await until(`(${W.counts}).error > 0`, 'restored report', 15000);
    eq(await w(`document.querySelector('.chip.info').getAttribute('aria-pressed')`), 'false', 'filter kept');
  });

  await step('no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });

  await vs.close();
  await restricted();
} finally {
  await vs.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}

/**
 * Restricted Mode: a copy of the workspace, never trusted, whose settings try to hide every
 * change, to run Git, and to leave the split schema out.
 */
async function restricted() {
  const r = path.join(root, 'restricted');
  const ws2 = path.join(r, 'bookshop');
  mkdirSync(path.join(ws2, 'api', 'types'), { recursive: true });
  mkdirSync(path.join(ws2, '.vscode'), { recursive: true });
  writeFileSync(path.join(ws2, 'api', 'schema.graphql'), v1);
  writeFileSync(path.join(ws2, 'api', 'types', 'reviews.graphql'), sibling(sample('bookshop-v1.graphql')));
  writeFileSync(path.join(ws2, 'api', 'schema.json'), introspection);
  explorerFiles(ws2);
  const g = (...a) => execFileSync('git', a, { cwd: ws2, encoding: 'utf8' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-qm', 'v1');
  writeFileSync(path.join(ws2, 'api', 'schema.graphql'), v2);
  writeFileSync(path.join(ws2, 'api', 'types', 'reviews.graphql'), sibling(sample('bookshop-v2.graphql')));
  const workspaceSettings = { 'graphqlBreakingChanges.ignore': ['*'], 'graphqlBreakingChanges.baseRef': 'HEAD', 'graphqlBreakingChanges.schemaFiles': '' };
  writeFileSync(path.join(ws2, '.vscode', 'settings.json'), JSON.stringify(workspaceSettings, null, 2));
  const trust = { ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never', 'security.workspace.trust.untrustedFiles': 'open' };
  vs = new VSCode(r);
  vs.install(vsix, trust);
  await vs.launch(ws2);
  await sleep(2500);
  const userSettings = path.join(r, 'user-data', 'User', 'settings.json');

  await step('Restricted Mode: the workspace baseline is not applied', async () => {
    await waitFor(() => vs.eval(`!!document.querySelector('[id="status.workspaceTrust"], .statusbar-item[aria-label*="Restricted Mode"]') || document.body.textContent.includes('Restricted Mode')`), { what: 'the window in Restricted Mode', timeout: 20000 });
    await sleep(1500);
    await openFile('api/schema.graphql');
    await sleep(4000);
    eq(await problemCounts(), { errors: 0, warnings: 0 }, 'problems');
  });

  await step('Restricted Mode: nothing that needs Git runs', async () => {
    await vs.command('GraphQL Breaking Changes: Compare with HEAD');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes('needs a trusted workspace')), { what: 'trust message' });
    ok(!(await vs.editorTabs()).some((t) => t.includes('Schema changes')), 'no report');
    await vs.clearNotifications();
  });

  await step('Restricted Mode: two files compare; the workspace ignore rules and file pattern are not applied', async () => {
    await closeAll();
    await openFile('api/schema.graphql');
    await paletteRun('GraphQL Breaking Changes: Compare with Another Schema');
    await waitFor(async () => (await quickItems()).some((i) => i.includes('schema.json')), { what: 'schema.json listed' });
    await vs.pickQuickItem('schema.json');
    ctx = await vs.webview('schema.json');
    await until(`(${W.counts}).error > 0`, 'changes');
    eq((await w(W.counts)).ignored, undefined, 'nothing ignored (no ignored chip)');
    ok(await w(`!!${W.row('Book.reviews')}`), 'the split schema is still merged, by the default pattern');
  });

  await step('Restricted Mode: Ignore offers the user settings instead', async () => {
    await w(`document.querySelector('.change .ign').click()`);
    await waitFor(() => vs.quickInputVisible(), { what: 'ignore picker' });
    await vs.pickQuickItem('Every ');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes('Restricted Mode')), { what: 'restricted mode message' });
    await vs.dialogButton('Add to User Settings');
    await waitFor(() => /graphqlBreakingChanges\.ignore/.test(readFileSync(userSettings, 'utf8')), { what: 'user settings' });
    eq(JSON.parse(readFileSync(path.join(ws2, '.vscode', 'settings.json'), 'utf8')), workspaceSettings, 'workspace settings untouched');
    await reportTab();
    ctx = await vs.webview('schema.json');
    await until(`(${W.counts}).ignored > 0`, 'ignored now');
  });

  await step('Restricted Mode: the Explorer compare works', async () => {
    await closeAll();
    await explorerCompare('bookshop-v2.graphql', 'bookshop.graphql');
    ctx = await vs.webview('bookshop.graphql');
    eq(await w(W.sides), ['bookshop.graphql', 'bookshop-v2.graphql'], 'old, then new');
    await until(`(${W.counts}).error > 0`, 'breaking changes');
  });

  await step('Restricted Mode: no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
}
