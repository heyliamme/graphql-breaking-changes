import type { Change } from '../src/core/diff';
import { KIND_NAME, type Level } from '../src/core/types';
import type { FromWebview, Report, SideInfo, SideName, ToWebview, ViewState } from '../src/protocol';
import { esc, groupChanges, matchesQuery, messageHtml, type Group } from './model';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; setState(s: unknown): void; getState(): unknown };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const LEVELS: Level[] = ['error', 'warning', 'info'];
const LEVEL_ICON: Record<Level, string> = { error: 'error', warning: 'warning', info: 'info' };
const LEVEL_NAME: Record<Level, string> = { error: 'breaking', warning: 'dangerous', info: 'other' };
/** Rows rendered before "Show all". */
const PAGE = 1500;

const saved = (vscode.getState() ?? {}) as { persist?: unknown; view?: ViewState };
let persist = saved.persist;
const view = {
  levels: { error: true, warning: true, info: true, ...(saved.view?.levels ?? {}) } as Record<string, boolean>,
  query: saved.view?.query ?? '',
  collapsed: new Set<string>(saved.view?.collapsed ?? []),
};
let report: Report | undefined;
/** A new report is on its way (swap, refresh): the one shown no longer matches the sides. */
let pending = false;
let limit = PAGE;

const icon = (name: string, cls = '') => `<span class="codicon codicon-${name}${cls ? ' ' + cls : ''}" aria-hidden="true"></span>`;

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="progress" id="progress" role="progressbar" aria-label="Comparing" hidden><div></div></div>
<header class="bar">
  <div class="sides" id="sides"></div>
  <div class="actions">
    <button id="swap" class="icon" title="Swap old and new" aria-label="Swap old and new">${icon('arrow-swap')}</button>
    <button id="refresh" class="icon" title="Read both sides again" aria-label="Refresh">${icon('refresh')}</button>
    <button id="copy" title="Copy the changes as a Markdown changelog, for a pull request" disabled>${icon('copy')} Copy as Markdown</button>
    <button id="releaseNotes" title="Release notes for API clients: Breaking, Dangerous, Added, Changed, in a Markdown editor" disabled>${icon('output')} Release Notes</button>
  </div>
</header>
<div class="summary" id="summary" role="group" aria-label="Show changes by level" hidden></div>
<div class="filter">
  <span class="search">${icon('search')}<input id="search" type="search" placeholder="Filter by type, field, id or text" aria-label="Filter changes" spellcheck="false"></span>
  <button id="expand" class="link" title="Expand or collapse every type" disabled>Collapse all</button>
</div>
<div id="cards"></div>
<div id="status" class="sr-only" role="status"></div>
<main id="groups"></main>
`;
const $ = (id: string) => document.getElementById(id)!;
const search = $('search') as HTMLInputElement;
search.value = view.query;

function saveState() {
  vscode.setState({ persist, view: { levels: view.levels, query: view.query, collapsed: [...view.collapsed] } });
}

function sideHtml(s: SideInfo, which: SideName) {
  const i = s.info;
  const v = i ? `<span class="ver" title="${i.kind === 'sdl' ? 'Schema definition language' : 'Introspection result'}, ${i.types} type${i.types === 1 ? '' : 's'}">${i.kind === 'sdl' ? 'SDL' : 'introspection'} · ${i.types.toLocaleString()} type${i.types === 1 ? '' : 's'}</span>` : '';
  return `<div class="side ${which}">
    <span class="tag">${which}</span>
    <span class="label" title="${esc(s.detail ?? s.label)}">${esc(s.label)}</span>${v}
  </div>`;
}

function renderHeader(r: Report) {
  $('sides').innerHTML = `${sideHtml(r.old, 'old')}<span class="arrow">${icon('arrow-right')}</span>${sideHtml(r.new, 'new')}`;
  const c = r.counts;
  const chip = (level: Level, n: number) =>
    `<button class="chip ${level}" data-level="${level}" aria-pressed="${view.levels[level]}" title="${view.levels[level] ? 'Hide' : 'Show'} ${LEVEL_NAME[level]} changes">${icon(LEVEL_ICON[level])}<b>${n}</b><span class="name"> ${LEVEL_NAME[level]}</span></button>`;
  const failed = r.old.error || r.new.error;
  // No empty group for screen readers to announce.
  $('summary').hidden = !!failed;
  $('summary').innerHTML = failed
    ? ''
    : `${chip('error', c.error)}${chip('warning', c.warning)}${chip('info', c.info)}${c.ignored ? `<button class="chip ignored" data-level="ignored" aria-pressed="${view.levels.ignored !== false}" title="Show or hide ignored changes">${icon('eye-closed')}<b>${c.ignored}</b><span class="name"> ignored</span></button>` : ''}${r.strict ? `<span class="note">${icon('warning')} Dangerous changes count as breaking</span>` : ''}<span class="time" title="Time to read and compare both sides">${r.ms} ms</span>`;
  // Nothing to copy or fold until both sides were compared; nothing to fold without changes.
  for (const id of ['copy', 'releaseNotes']) ($(id) as HTMLButtonElement).disabled = !!failed;
  ($('expand') as HTMLButtonElement).disabled = !!failed || !r.changes.length;
}

/** Which control has the keyboard focus, as a selector that finds it again after a render. */
function focusSelector(el: Element | null): string | undefined {
  if (!el || el === document.body) return undefined;
  const chip = el.closest<HTMLElement>('.chip');
  if (chip) return `.chip[data-level="${chip.dataset.level}"]`;
  const head = el.closest<HTMLElement>('.ghead');
  if (head) return `.group[data-key="${CSS.escape(head.closest<HTMLElement>('.group')!.dataset.key!)}"] .ghead`;
  const row = el.closest<HTMLElement>('.change');
  if (row) {
    const sel = `.change[data-i="${row.dataset.i}"]`;
    if (el.classList.contains('loc')) return `${sel} .loc.${(el as HTMLElement).dataset.side}`;
    return sel; // the row itself: its Ignore button goes away once the change is ignored
  }
  if (el.id) return `#${el.id}`;
  return undefined;
}

// --- keyboard: one tab stop for the list ------------------------------------------------
// Tab moves between the controls, the type headers and one row of changes; the arrow
// keys move between headers and rows; Tab from a row reaches its buttons.

/** The row that is the list's tab stop, by change index. */
let currentRow: string | undefined;

function setCurrent(row: HTMLElement) {
  if (row.dataset.i === currentRow && row.tabIndex === 0) return;
  for (const r of document.querySelectorAll<HTMLElement>('.change[tabindex="0"]')) if (r !== row) setRowStop(r, false);
  setRowStop(row, true);
  currentRow = row.dataset.i;
}

function setRowStop(row: HTMLElement, on: boolean) {
  row.tabIndex = on ? 0 : -1;
  for (const b of row.querySelectorAll<HTMLElement>('button')) b.tabIndex = on ? 0 : -1;
}

/** After a render: the current row, else the first, is the tab stop. */
function fixTabStop() {
  const row = (currentRow !== undefined && document.querySelector<HTMLElement>(`.change[data-i="${currentRow}"]`)) || document.querySelector<HTMLElement>('.change');
  if (row) setCurrent(row);
}
let lastFocus: string | undefined;
document.addEventListener('focusin', (e) => (lastFocus = focusSelector(e.target as Element) ?? lastFocus));

function locButton(c: Change, side: SideName, r: Report) {
  const loc = c[side];
  if (!loc) return '';
  const main = r[side].path;
  const file = loc.file === main ? '' : loc.file.split('/').pop() + ':';
  return `<button class="loc ${side}" data-side="${side}" tabindex="-1" title="Open the ${side} schema at ${esc(loc.pointer || '/')}">${side} ${esc(file)}${loc.line + 1}</button>`;
}

function render() {
  const r = report;
  if (!r) return;
  // Rebuilding the list would drop the keyboard focus: put it back afterwards.
  const active = document.activeElement;
  const refocus = active && active !== document.body ? focusSelector(active) : document.hasFocus() ? lastFocus : undefined;
  draw(r);
  fixTabStop();
  if (refocus && (!document.activeElement || document.activeElement === document.body)) {
    const el = document.querySelector<HTMLElement>(refocus) ?? (refocus.startsWith('.change') ? document.querySelector<HTMLElement>(refocus.split(' ')[0]) : null);
    el?.focus();
  }
}

function draw(r: Report) {
  const groupsEl = $('groups');
  const status = $('status');
  renderHeader(r);
  const notes: string[] = [];
  for (const side of ['old', 'new'] as const) {
    const e = r[side].error;
    if (!e) continue;
    notes.push(`<div class="card error">${icon('error')}<div><b>Couldn't read the ${side} schema</b> (${esc(r[side].label)})<br>${messageHtml(e.message)}${e.line !== undefined ? ` <button class="link open-error" data-side="${side}" data-file="${esc(e.file)}" data-line="${e.line}" data-col="${e.col ?? 0}">line ${e.line + 1}</button>` : ''}</div></div>`);
  }
  if (r.warnings.length) {
    const shown = r.warnings.slice(0, 5).map((w) => `<li>${messageHtml(w)}</li>`).join('');
    notes.push(`<details class="card warn"><summary>${icon('warning')} ${r.warnings.length} thing${r.warnings.length > 1 ? 's' : ''} to note about how the schemas were read</summary><ul>${shown}${r.warnings.length > 5 ? `<li>and ${r.warnings.length - 5} more</li>` : ''}</ul></details>`);
  }
  $('cards').innerHTML = notes.join('');
  if (r.old.error || r.new.error) {
    groupsEl.innerHTML = '';
    status.textContent = 'Nothing was compared: a schema could not be read.';
    return;
  }
  if (!r.changes.length) {
    groupsEl.innerHTML = `<div class="empty">${icon('pass', 'ok')}<p><b>No changes for API clients.</b></p><p class="muted">The order of definitions, comments and formatting are not compared.</p></div>`;
    status.textContent = 'No changes for API clients.';
    return;
  }
  const visible = (c: Change) => (c.ignored !== undefined ? view.levels.ignored !== false : view.levels[c.level]) && matchesQuery(c, view.query);
  const groups = groupChanges(r.changes);
  let rows = 0;
  let html = '';
  let shownGroups = 0;
  for (const g of groups) {
    const items = g.items.filter((i) => visible(r.changes[i]));
    if (!items.length) continue;
    shownGroups++;
    const collapsed = view.collapsed.has(g.key);
    html += `<section class="group${collapsed ? ' collapsed' : ''}" data-key="${esc(g.key)}">${groupHead(g, items, r)}`;
    if (!collapsed) {
      html += '<ul class="changes">';
      for (const i of items) {
        if (rows++ >= limit) break;
        html += changeRow(r.changes[i], i, r);
      }
      html += '</ul>';
    }
    html += '</section>';
    if (rows >= limit) break;
  }
  const matching = r.changes.reduce((n, c) => n + (visible(c) ? 1 : 0), 0);
  if (rows >= limit && matching > limit) html += `<div class="more"><button id="showAll" class="link">Show all ${matching} changes</button></div>`;
  if (!shownGroups) html = `<div class="empty">${icon('filter')}<p>No changes match the filter.</p><button class="link" id="clearFilter">Clear the filter</button></div>`;
  groupsEl.innerHTML = html;
  // Screen readers hear a summary, not the whole list again.
  status.textContent = shownGroups ? `${matching} of ${r.changes.length} change${r.changes.length === 1 ? '' : 's'} shown, on ${shownGroups} type${shownGroups === 1 ? '' : 's'}` : 'No changes match the filter.';
  const keys = visibleGroups();
  $('expand').textContent = keys.length && keys.every((k) => view.collapsed.has(k)) ? 'Expand all' : 'Collapse all';
  ($('expand') as HTMLButtonElement).disabled = !keys.length;
}

/** The groups that have a change passing the filters. */
function visibleGroups(): string[] {
  const r = report;
  if (!r) return [];
  const visible = (c: Change) => (c.ignored !== undefined ? view.levels.ignored !== false : view.levels[c.level]) && matchesQuery(c, view.query);
  return groupChanges(r.changes)
    .filter((g) => g.items.some((i) => visible(r.changes[i])))
    .map((g) => g.key);
}

function groupHead(g: Group, items: number[], r: Report) {
  const n: Record<Level, number> = { error: 0, warning: 0, info: 0 };
  for (const i of items) if (r.changes[i].ignored === undefined) n[r.changes[i].level]++;
  const counts = LEVELS.filter((l) => n[l])
    .map((l) => `<span class="count ${l}" title="${n[l]} ${LEVEL_NAME[l]}">${icon(LEVEL_ICON[l])}${n[l]}<span class="sr-only"> ${LEVEL_NAME[l]},</span></span>`)
    .join('');
  const kind = KIND_NAME[g.kind];
  const title = g.type ? `<span class="kind k-${esc(kind)}">${esc(kind)}</span><span class="path">${esc(g.type)}</span>` : `<span class="kind k-schema">schema</span><span class="path whole">Schema</span>`;
  const collapsed = view.collapsed.has(g.key);
  return `<button class="ghead" aria-expanded="${!collapsed}">${icon(collapsed ? 'chevron-right' : 'chevron-down', 'chev')}${title}<span class="counts">${counts}</span></button>`;
}

function changeRow(c: Change, i: number, r: Report) {
  const ignored = c.ignored !== undefined;
  const reason = ignored ? `<span class="why">ignored${c.ignored ? `: ${esc(c.ignored)}` : ''}</span>` : '';
  const state = ignored ? `, ignored${c.ignored ? ` (${c.ignored})` : ''}` : '';
  const field = c.field ? `<span class="fld" title="${fieldTitle(c)}">${esc(c.field)}</span>` : '';
  return `<li class="change ${c.level}${ignored ? ' is-ignored' : ''}" data-i="${i}" tabindex="-1" aria-label="${esc(LEVEL_NAME[c.level] + state)}: ${esc(c.message.replace(/`/g, ''))}">
    <span class="lvl ${c.level}" title="${LEVEL_NAME[c.level]}">${icon(LEVEL_ICON[c.level])}</span>
    <span class="msg">${field}${messageHtml(c.message)}${reason}</span>
    <span class="meta"><code class="id" title="Change id, for ignore rules">${esc(c.id)}</code>${locButton(c, 'old', r)}${locButton(c, 'new', r)}${ignored ? '' : `<button class="icon ign" tabindex="-1" title="Ignore…" aria-label="Ignore this change">${icon('eye-closed')}</button>`}</span>
  </li>`;
}

/** What the name at the start of a row is. */
function fieldTitle(c: Change): string {
  if (c.kind === 'ENUM') return 'Enum value';
  if (c.kind === 'UNION') return 'Union member';
  if (c.kind === 'INPUT_OBJECT') return 'Input field';
  if (/^(deprecated-)?argument-/.test(c.id)) return 'Field whose argument changed';
  return 'Field';
}

function openLoc(c: Change, side: SideName) {
  const loc = c[side];
  if (loc && report && !pending) post({ type: 'open', report: report.id, side, file: loc.file, line: loc.line, col: loc.col });
}

// --- events ---------------------------------------------------------------------------

$('swap').addEventListener('click', () => post({ type: 'swap' }));
$('refresh').addEventListener('click', () => post({ type: 'refresh' }));
$('copy').addEventListener('click', () => report && !pending && post({ type: 'copyMarkdown', report: report.id }));
$('releaseNotes').addEventListener('click', () => report && !pending && post({ type: 'releaseNotes', report: report.id }));
$('expand').addEventListener('click', () => {
  if (!report) return;
  // Only what the filter shows: hidden groups keep their state.
  const keys = visibleGroups();
  if (!keys.length) return;
  const all = keys.every((k) => view.collapsed.has(k));
  for (const k of keys) {
    if (all) view.collapsed.delete(k);
    else view.collapsed.add(k);
  }
  saveState();
  render();
});
let typing: ReturnType<typeof setTimeout> | undefined;
search.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    view.query = search.value;
    limit = PAGE;
    saveState();
    render();
  }, 120);
});

$('summary').addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.chip');
  if (!chip) return;
  const level = chip.dataset.level!;
  view.levels[level] = view.levels[level] === false;
  saveState();
  render();
});

$('cards').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.open-error');
  if (b && report && !pending) post({ type: 'open', report: report.id, side: b.dataset.side as SideName, file: b.dataset.file!, line: Number(b.dataset.line), col: Number(b.dataset.col) });
});

$('groups').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#showAll')) {
    const shown = document.querySelectorAll('.change').length;
    limit = Infinity;
    render();
    // The button is gone: on to the first row it brought in.
    const rows = document.querySelectorAll<HTMLElement>('.change');
    const row = rows[shown] ?? rows[rows.length - 1];
    if (row) {
      setCurrent(row);
      row.focus();
    }
    return;
  }
  if (t.closest('#clearFilter')) {
    view.query = '';
    search.value = '';
    for (const l of [...LEVELS, 'ignored']) view.levels[l] = true;
    saveState();
    render();
    search.focus();
    return;
  }
  const head = t.closest<HTMLElement>('.ghead');
  if (head) {
    const key = head.closest<HTMLElement>('.group')!.dataset.key!;
    if (view.collapsed.has(key)) view.collapsed.delete(key);
    else view.collapsed.add(key);
    saveState();
    render();
    (document.querySelector(`.group[data-key="${CSS.escape(key)}"] .ghead`) as HTMLElement | null)?.focus();
    return;
  }
  const row = t.closest<HTMLElement>('.change');
  if (!row || !report) return;
  const c = report.changes[Number(row.dataset.i)];
  const loc = t.closest<HTMLElement>('.loc');
  if (loc) return openLoc(c, loc.dataset.side as SideName);
  if (t.closest('.ign')) return pending || post({ type: 'ignore', report: report.id, index: Number(row.dataset.i) });
  if (t.closest('.id')) return; // let people select the id
  // Selecting text in the row (to copy a name) is not a click to open it.
  if (window.getSelection()?.toString()) return;
  openLoc(c, c.new ? 'new' : 'old');
});

$('groups').addEventListener('focusin', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.change');
  if (row) setCurrent(row);
});

$('groups').addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const item = t.closest<HTMLElement>('.change') ?? t.closest<HTMLElement>('.ghead');
  if (!item || !report) return;
  if (e.key === 'Enter' && e.target === item && item.classList.contains('change')) {
    const c = report.changes[Number(item.dataset.i)];
    openLoc(c, e.altKey && c.old ? 'old' : c.new ? 'new' : 'old');
    e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    // Headers too, so a folded type can be reached and opened.
    const all = [...document.querySelectorAll<HTMLElement>('.ghead, .change')];
    const i = all.indexOf(item);
    const next = e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : all[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      if (next.classList.contains('change')) setCurrent(next);
      next.focus();
    }
    e.preventDefault();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== search) {
    search.focus();
    e.preventDefault();
  } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
    search.value = '';
    search.dispatchEvent(new Event('input'));
  }
});

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'loading':
      $('progress').hidden = false;
      $('status').textContent = 'Comparing…';
      // What is shown stays until the new report comes, but can't be acted on.
      pending = !!report;
      for (const id of ['copy', 'releaseNotes']) ($(id) as HTMLButtonElement).disabled = true;
      document.body.classList.toggle('pending', pending);
      if (!report) {
        for (const id of ['copy', 'releaseNotes', 'expand']) ($(id) as HTMLButtonElement).disabled = true;
        $('groups').innerHTML = `<p class="loading">Comparing…</p>`;
      }
      break;
    case 'report':
      $('progress').hidden = true;
      pending = false;
      document.body.classList.remove('pending');
      report = m.report;
      render();
      break;
    case 'persist':
      persist = m.state;
      saveState();
      break;
    case 'view':
      if (m.view.levels) Object.assign(view.levels, m.view.levels);
      if (m.view.query !== undefined) search.value = view.query = m.view.query;
      if (m.view.collapsed) view.collapsed = new Set(m.view.collapsed);
      render();
      break;
  }
});

post({ type: 'ready' });
