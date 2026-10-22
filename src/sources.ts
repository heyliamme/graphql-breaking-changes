import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { codeSpan, decodeText, globMatcher, looksLikeSchema, MAX_FILES } from './core';
import { INDEX, inRepo, MAX_BLOBS_BYTES, repoFor, validRef, type GitFile, type Repo } from './git';
import { schemaGlob } from './settings';

/** How to get a side back after a window reload. */
export type Restore =
  | { kind: 'doc'; uri: string; label?: string }
  | { kind: 'git'; uri: string; ref: string; label?: string }
  /** `dropped`: the text was too large to keep, so the side can't come back. */
  | { kind: 'text'; label: string; text: string; path: string; scope?: string; dropped?: boolean };

/** Diff editor sides kept as text up to this size across a window reload. */
const MAX_KEPT_TEXT = 5_000_000;

export interface SchemaFile {
  path: string;
  text: string;
}

/** One side of a comparison: a schema's text, the other files of a split schema, and how to open them. */
export interface SchemaSource {
  label: string;
  /** How release notes name this version: "`v1.2.0`", "the working copy". */
  name: string;
  detail?: string;
  text: string;
  /** POSIX path the engine sees. */
  path: string;
  /** The other SDL files merged with this one, read at the same version. */
  files: SchemaFile[];
  /** What reading the files left out, for the report. */
  warnings?: string[];
  /**
   * When only some of the split schema's files were looked at on disk (a huge folder, too
   * many matches, too many bytes), the paths that were: the same version at a Git ref is
   * read from these alone, so that the files left out don't show as removed.
   */
  partial?: string[];
  /** Why this side couldn't be read back after a window reload. */
  failed?: string;
  /** The editor URI for a path the engine reported, or undefined when it can't be opened. */
  uriFor(path: string): vscode.Uri | undefined;
  /** Documents whose edits should update the comparison, by URI string. */
  watch: Set<string>;
  /** The main document, whose unsaved text is read when the comparison runs again. */
  live?: vscode.Uri;
  /** The file on disk this side is a version of, whose folder's settings apply. */
  scope?: vscode.Uri;
  restore: Restore;
  reload(): Promise<SchemaSource>;
}

const base = (u: vscode.Uri) => u.path.split('/').pop() || u.path;
const dirOf = (u: vscode.Uri) => vscode.Uri.joinPath(u, '..');

/** Larger files are not read: no schema is that big, and a device or a FIFO never ends. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Files read from disk, by URI, while their size and modification time stay the same: the
 * Problems panel check reads a split schema's files again after every pause in typing.
 */
const texts = new Map<string, { mtime: number; size: number; text: string }>();
let textsBytes = 0;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;

/** A file's text and size: the open document's, else the file's, when it is a regular file of a sane size. */
async function readSized(uri: vscode.Uri): Promise<{ text: string; size: number }> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const text = open.getText();
    return { text, size: text.length };
  }
  const st = await vscode.workspace.fs.stat(uri);
  if (!(st.type & vscode.FileType.File)) throw new Error(`${base(uri)} is not a file.`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${base(uri)} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const key = uri.toString();
  const hit = texts.get(key);
  if (hit && hit.mtime === st.mtime && hit.size === st.size) return { text: hit.text, size: st.size };
  // As VS Code opens it: UTF-16 when a byte order mark says so.
  const text = decodeText(await vscode.workspace.fs.readFile(uri));
  if (hit) textsBytes -= hit.size;
  if (textsBytes + st.size > MAX_CACHED_BYTES) {
    texts.clear();
    textsBytes = 0;
  }
  if (st.size <= MAX_CACHED_BYTES / 8) {
    texts.set(key, { mtime: st.mtime, size: st.size, text });
    textsBytes += st.size;
  } else texts.delete(key);
  return { text, size: st.size };
}

const readUri = async (uri: vscode.Uri) => (await readSized(uri)).text;

/**
 * Folders whose files are never part of a split schema: dependencies, build output and
 * vendored code. The same on disk and at a Git ref, so that both sides merge the same files.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'vendor']);
/** Entries looked at on disk before giving up on the rest of the folder. */
const MAX_WALK = 50_000;

/**
 * The files under a folder on disk, as POSIX paths relative to it. Symbolic links are not
 * followed, so the set never leaves the folder.
 */
async function walk(dir: string, limit: number): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = [];
  const stack = [''];
  let seen = 0;
  while (stack.length && seen < limit) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(dir, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    seen += entries.length;
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(r);
      } else if (e.isFile()) out.push(r);
    }
  }
  return { files: out.sort(), truncated: stack.length > 0 };
}

/**
 * Folder listings on disk, while nothing is created or deleted in the workspace: walking
 * a large folder again after every pause in typing would keep the extension host busy.
 */
const listings = new Map<string, Promise<{ files: string[]; truncated: boolean }>>();

/** Forgets folder listings when files come and go; to dispose with the extension. */
export function watchSchemaFolders(): vscode.Disposable {
  const w = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  const forget = () => listings.clear();
  return vscode.Disposable.from(w, w.onDidCreate(forget), w.onDidDelete(forget), vscode.workspace.onDidChangeWorkspaceFolders(forget));
}

function listFolder(dir: vscode.Uri): Promise<{ files: string[]; truncated: boolean }> {
  // Only folders the workspace watches are kept: elsewhere nothing would say they changed.
  if (!vscode.workspace.getWorkspaceFolder(dir)) return walk(dir.fsPath, MAX_WALK);
  const key = dir.fsPath;
  let p = listings.get(key);
  if (!p) {
    p = walk(dir.fsPath, MAX_WALK);
    listings.set(key, p);
    p.catch(() => listings.delete(key));
  }
  return p;
}

/**
 * Which files of a folder's listing are other files of the split schema: the one rule both
 * sides use, on disk and at a Git ref. Paths through a skipped folder are left out, then
 * those the pattern names, sorted, at most MAX_FILES.
 */
function pick(listed: string[], glob: string, main: string): { picked: string[]; warnings: string[] } {
  const match = globMatcher(glob);
  const hits = listed.filter((p) => p !== main && !p.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d)) && match(p)).sort();
  const warnings = hits.length > MAX_FILES ? [`Only the first ${MAX_FILES} of the ${hits.length} files matching ${codeSpan(glob)} were read.`] : [];
  return { picked: hits.slice(0, MAX_FILES), warnings };
}

const tooMany = (n: number) => `Only ${n} other files of the split schema were read: the rest are too large (over ${MAX_FILE_BYTES / 1024 / 1024} MB each, or ${MAX_BLOBS_BYTES / 1024 / 1024} MB together).`;

/**
 * The other files of a split schema next to (and below) the main one, by the pattern:
 * only when the main file is SDL on disk. Files holding only queries are dropped later
 * by the engine; here only what the pattern names is read.
 */
async function siblingsOnDisk(main: vscode.Uri, text: string): Promise<{ files: SchemaFile[]; warnings: string[]; partial?: string[] }> {
  if (main.scheme !== 'file' || looksLikeSchema(text) !== 'sdl') return { files: [], warnings: [] };
  const glob = schemaGlob(main);
  if (!glob) return { files: [], warnings: [] };
  const dir = dirOf(main);
  const listed = await listFolder(dir);
  const { picked, warnings } = pick(listed.files, glob, base(main));
  if (listed.truncated) warnings.push(`The folder of ${base(main)} holds more than ${MAX_WALK.toLocaleString('en')} files: only some of them were searched for other files of the schema.`);
  const files: SchemaFile[] = [];
  const looked: string[] = [];
  let total = 0;
  for (const r of picked) {
    const u = vscode.Uri.joinPath(dir, ...r.split('/'));
    if (u.path === main.path) continue;
    looked.push(u.path);
    try {
      const { text: t, size } = await readSized(u);
      // The same budget as at a Git ref: a folder of huge files can't fill the extension host's memory.
      if (total + size > MAX_BLOBS_BYTES) {
        warnings.push(tooMany(files.length));
        looked.pop();
        break;
      }
      total += size;
      if (looksLikeSchema(t) === 'sdl') files.push({ path: u.path, text: t });
    } catch {
      /* unreadable: left out */
    }
  }
  return { files, warnings, partial: warnings.length ? looked : undefined };
}

/** A file that is the main one of its schema: it defines a root type or the schema block. */
const ROOT_DEF = /^[ \t]*(?:schema\s*[{@]|type\s+(?:Query|Mutation|Subscription)\b)/m;
const SDL_FILE = /\.(graphqls?|gql)$/i;

/**
 * For a file that is only a part of a split schema (no root type, no schema block), the
 * main file whose split brings it in: the nearest one in its folder or a folder above it,
 * within its workspace folder. Undefined for a main file, or when none is found.
 */
export async function mainSchemaOf(part: vscode.Uri, text: string): Promise<vscode.Uri | undefined> {
  if (part.scheme !== 'file' || ROOT_DEF.test(text) || looksLikeSchema(text) !== 'sdl') return undefined;
  const ws = vscode.workspace.getWorkspaceFolder(part);
  if (!ws) return undefined;
  const top = ws.uri.path.replace(/\/$/, '');
  let dir = dirOf(part);
  for (;;) {
    const rel = part.path.slice(dir.path.replace(/\/$/, '').length + 1);
    if (!rel.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d))) {
      let names: string[] = [];
      try {
        names = (await fs.promises.readdir(dir.fsPath, { withFileTypes: true })).filter((e) => e.isFile() && SDL_FILE.test(e.name)).map((e) => e.name).sort();
      } catch {
        /* unreadable folder */
      }
      for (const n of names) {
        const u = vscode.Uri.joinPath(dir, n);
        if (u.path === part.path) continue;
        const glob = schemaGlob(u);
        if (!glob || !globMatcher(glob)(rel)) continue;
        try {
          const t = (await readSized(u)).text;
          if (ROOT_DEF.test(t) && looksLikeSchema(t) === 'sdl') return u;
        } catch {
          /* unreadable: not it */
        }
      }
    }
    if (dir.path.replace(/\/$/, '') === top || !dir.path.startsWith(top + '/')) return undefined;
    dir = dirOf(dir);
  }
}

/** A document on disk (or any file system), following its unsaved edits, with its split-schema siblings. */
export async function fromDocument(uri: vscode.Uri): Promise<SchemaSource> {
  const text = await readUri(uri);
  const untitled = uri.scheme === 'untitled';
  const { files, warnings, partial } = await siblingsOnDisk(uri, text);
  const watch = new Set([uri.toString(), ...files.map((f) => uri.with({ path: f.path }).toString())]);
  return {
    label: untitled ? uri.path : base(uri),
    name: codeSpan(untitled ? uri.path : base(uri)),
    detail: untitled ? 'unsaved' : vscode.workspace.asRelativePath(uri),
    text,
    path: uri.path,
    files,
    warnings,
    partial,
    uriFor: (p) => uri.with({ path: p }),
    watch,
    live: uri,
    scope: uri,
    restore: { kind: 'doc', uri: uri.toString() },
    reload: () => fromDocument(uri),
  };
}

/** The file as of a Git ref, with the split-schema files that exist at that ref. */
/** `only`: the split schema's files to read, by path, when the side on disk could read only those. */
export async function fromGit(file: vscode.Uri, ref: string, repo?: Repo, only?: ReadonlySet<string>): Promise<SchemaSource> {
  const r = repo ?? (await repoFor(file));
  const text = await r.show(ref, file);
  const files: SchemaFile[] = [];
  const warnings: string[] = [];
  const glob = schemaGlob(file);
  if (glob && looksLikeSchema(text) === 'sdl') {
    const dir = dirOf(file);
    let listed: GitFile[] = [];
    try {
      listed = await r.list(ref, dir);
    } catch {
      /* a ref with no such folder */
    }
    const oids = new Map(listed.map((f) => [f.path, f.oid]));
    const candidates = [...oids.keys()].filter((p) => !only || only.has(vscode.Uri.joinPath(dir, ...p.split('/')).path));
    const chosen = pick(candidates, glob, base(file));
    warnings.push(...chosen.warnings);
    const got = await r.blobs(chosen.picked.map((p) => oids.get(p)!));
    let read = 0;
    for (const p of chosen.picked) {
      const u = vscode.Uri.joinPath(dir, ...p.split('/'));
      const t = got.get(oids.get(p)!);
      if (t === undefined) continue;
      read++;
      if (u.path !== file.path && looksLikeSchema(t) === 'sdl') files.push({ path: u.path, text: t });
    }
    if (read < new Set(chosen.picked.map((p) => oids.get(p))).size) warnings.push(tooMany(read));
  }
  const inside = (p: string) => inRepo(r.root, file.with({ path: p }));
  return {
    label: `${base(file)} (${shortRef(ref)})`,
    name: codeSpan(shortRef(ref)),
    detail: `${vscode.workspace.asRelativePath(file)} at ${shortRef(ref)}`,
    text,
    path: file.path,
    files,
    warnings,
    uriFor: (p) => (inside(p) ? r.uriAt(file.with({ path: p }), ref) : undefined),
    watch: new Set(),
    scope: file,
    restore: { kind: 'git', uri: file.toString(), ref },
    reload: () => fromGit(file, ref),
  };
}

/** `23e29a0971e9…` → `23e29a09`, as VS Code's own diff tabs show commits. */
export const shortRef = (r: string) => (r === INDEX || r === '' ? 'index' : r.replace(/^([0-9a-f]{8})[0-9a-f]{32}$/, '$1'));

/**
 * One side of an open diff editor: a file, or a `git:` revision (Source Control, Timeline,
 * pull requests). A Git revision of a file on disk is read through Git, with its split
 * schema; any other scheme is read as one document.
 */
export async function fromDiffSide(uri: vscode.Uri, label?: string): Promise<SchemaSource> {
  if (uri.scheme === 'file' || uri.scheme === 'untitled' || uri.scheme === 'vscode-remote') return fromDocument(uri);
  const gitRef = (() => {
    if (uri.scheme !== 'git') return undefined;
    try {
      return (JSON.parse(uri.query) as { ref?: string }).ref;
    } catch {
      return undefined;
    }
  })();
  const file = uri.with({ scheme: 'file', query: '', fragment: '' });
  // A staged change's diff shows the index as ref "": read it with its split schema too.
  const ref = gitRef === '' ? INDEX : gitRef;
  if (ref !== undefined && validRef(ref) && vscode.workspace.isTrusted) {
    try {
      const s = await fromGit(file, ref);
      if (label) relabel(s, label);
      return s;
    } catch {
      /* no repository here: the document alone */
    }
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const name = label ?? (gitRef !== undefined ? `${base(uri)} (${shortRef(gitRef)})` : base(uri));
  const text = doc.getText();
  // A `git:` view of a workspace file is that file, as far as settings go.
  const scope = uri.scheme === 'git' ? file : undefined;
  return {
    label: name,
    name: codeSpan(gitRef !== undefined ? shortRef(gitRef) : name),
    detail: gitRef !== undefined ? `${vscode.workspace.asRelativePath(file)} at ${shortRef(gitRef)}` : undefined,
    text,
    path: uri.path,
    files: [],
    uriFor: (p) => (p === uri.path ? uri : undefined),
    watch: new Set([uri.toString()]),
    live: uri,
    scope,
    restore: text.length <= MAX_KEPT_TEXT ? { kind: 'text', label: name, text, path: uri.path, scope: scope?.toString() } : { kind: 'text', label: name, text: '', path: uri.path, scope: scope?.toString(), dropped: true },
    reload: () => fromDiffSide(uri, label),
  };
}

/** A side that only exists as text (restored after a reload). */
export function fromText(label: string, text: string, path: string, scope?: vscode.Uri): SchemaSource {
  return {
    label,
    name: codeSpan(label),
    text,
    path,
    files: [],
    uriFor: () => undefined,
    watch: new Set(),
    scope,
    restore: { kind: 'text', label, text, path, scope: scope?.toString() },
    reload: async () => fromText(label, text, path, scope),
  };
}

export async function fromRestore(r: Restore): Promise<SchemaSource> {
  if (r.kind === 'text') {
    if (r.dropped) throw new Error(`${r.label} was too large to keep across a window reload. Run the comparison again from where it started (for a diff, Check This Diff for Breaking Changes).`);
    return fromText(r.label, r.text, r.path, r.scope ? vscode.Uri.parse(r.scope) : undefined);
  }
  const s = r.kind === 'doc' ? await fromDocument(vscode.Uri.parse(r.uri)) : await fromGit(vscode.Uri.parse(r.uri), r.ref);
  if (r.label) relabel(s, r.label);
  return s;
}

/** Another name for a side, kept across a window reload and a refresh. */
export function relabel(s: SchemaSource, label: string) {
  s.label = label;
  s.restore = { ...s.restore, label };
  const reload = s.reload;
  s.reload = async () => {
    const again = await reload();
    relabel(again, label);
    return again;
  };
}

/**
 * A side that couldn't be read back after a window reload (Restricted Mode, a document not
 * open yet): the report says why, and Refresh tries again.
 */
export function unrestored(r: Restore, message: string): SchemaSource {
  const label = r.label ?? (r.kind === 'text' ? r.path : vscode.Uri.parse(r.uri).path).split('/').pop()!;
  const p = r.kind === 'text' ? r.path : vscode.Uri.parse(r.uri).path;
  return {
    label,
    name: codeSpan(label),
    text: '',
    path: p,
    files: [],
    failed: message,
    uriFor: () => undefined,
    watch: new Set(),
    scope: r.kind === 'text' ? (r.scope ? vscode.Uri.parse(r.scope) : undefined) : vscode.Uri.parse(r.uri),
    restore: r,
    reload: () => fromRestore(r),
  };
}

/**
 * Two sides with the same name (`v1/schema.graphql` and `v2/schema.graphql`) are named by
 * the shortest end of their paths that tells them apart.
 */
export function distinguish(a: SchemaSource, b: SchemaSource) {
  if (a.label !== b.label || !a.detail || !b.detail || a.detail === b.detail) return;
  const pa = a.detail.split('/');
  const pb = b.detail.split('/');
  for (let k = 2; k <= Math.max(pa.length, pb.length); k++) {
    const x = pa.slice(-k).join('/');
    const y = pb.slice(-k).join('/');
    if (x === y) continue;
    a.label = x;
    b.label = y;
    a.name = codeSpan(x);
    b.name = codeSpan(y);
    return;
  }
}
