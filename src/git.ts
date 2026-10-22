import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeText } from './core';

/** The parts of the built-in Git extension's API this extension uses. */
interface GitRef {
  type: number; // 0 head, 1 remote head, 2 tag
  name?: string;
  commit?: string;
  remote?: string;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: { HEAD?: GitRef; refs?: GitRef[]; onDidChange: vscode.Event<void> };
  show(ref: string, path: string): Promise<string>;
  getRefs?(query?: unknown): Promise<GitRef[]>;
}
interface GitApi {
  state: string;
  /** The git executable the Git extension found (its `git.path` setting, else PATH). */
  git?: { path?: string };
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri?(uri: vscode.Uri, ref: string): vscode.Uri;
  onDidOpenRepository: vscode.Event<GitRepository>;
}

export interface RefItem {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag';
  commit?: string;
}

/** The ref VS Code's own diff editors use for the index (staged version). */
export const INDEX = '~';

/** A Git repository, through the built-in Git extension or, without it, the git CLI. */
export interface Repo {
  root: vscode.Uri;
  show(ref: string, file: vscode.Uri): Promise<string>;
  /** The files under a folder at a ref, as POSIX paths relative to that folder, with their blob ids. */
  list(ref: string, folder: vscode.Uri): Promise<GitFile[]>;
  /** Blobs by id, in one go; one that is missing, not a blob, or too large is left out. */
  blobs(oids: string[]): Promise<Map<string, string>>;
  refs(): Promise<RefItem[]>;
  /** A URI that opens the file as of `ref` in a read-only editor. */
  uriAt(file: vscode.Uri, ref: string): vscode.Uri;
  /** The most recent tag reachable from HEAD (`git describe`), if any. */
  lastTag(): Promise<string | undefined>;
  /** The commit a ref names, or undefined when it names none in this repository. */
  resolve(ref: string): Promise<string | undefined>;
  onDidChange?: vscode.Event<void>;
}

export interface GitFile {
  path: string;
  oid: string;
}

export class GitUnavailable extends Error {}

/** Blobs larger than this are not read, as on disk: no schema file is that big. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** All the files of one split schema together, at a ref or on disk. */
export const MAX_BLOBS_BYTES = 256 * 1024 * 1024;

let apiPromise: Promise<GitApi | undefined> | undefined;

/** The git executable: the Git extension's when it is there, so that `git.path` applies. */
let gitExe = 'git';

async function gitApi(): Promise<GitApi | undefined> {
  apiPromise ??= (async () => {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi; enabled?: boolean }>('vscode.git');
    if (!ext) return undefined;
    try {
      const exp = ext.isActive ? ext.exports : await ext.activate();
      if (exp.enabled === false) return undefined;
      const api = exp.getAPI(1);
      if (typeof api.git?.path === 'string' && api.git.path) gitExe = api.git.path;
      return api;
    } catch {
      return undefined;
    }
  })();
  return apiPromise;
}

/** Refs come from settings and quick picks: never let one turn into a git option. */
export function validRef(ref: string): boolean {
  return ref === INDEX || (/^[^\s-][^\s:]*$/.test(ref) && !ref.includes('..') && ref.length < 256);
}

/** `ref:path` as `git show` and `git cat-file` take it; `:path` for the index. */
const spec = (ref: string, rel: string) => (ref === INDEX ? `:${rel}` : `${ref}:${rel}`);

/** Git's messages in English, whatever the locale: `missingAtRef` reads them. */
const env = () => ({ ...process.env, LC_ALL: 'C', LANGUAGE: 'C' });

function runBytes(args: string[], cwd: string, maxBuffer = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(gitExe, args, { cwd, maxBuffer, encoding: 'buffer', windowsHide: true, env: env() }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr.toString('utf8') || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

const run = async (args: string[], cwd: string, maxBuffer?: number) => (await runBytes(args, cwd, maxBuffer)).toString('utf8');

/** A file's text from `git show`, decoded as VS Code would open it. */
const showText = async (args: string[], cwd: string) => decodeText(await runBytes(args, cwd));

/** Runs git with text on its stdin and the raw bytes it writes, stopping it past `max` bytes. */
function runWithInput(args: string[], cwd: string, input: string, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(gitExe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: env() });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let over = false;
    p.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > max) {
        over = true;
        p.kill();
      } else out.push(b);
    });
    p.stderr.on('data', (b: Buffer) => err.length < 16 && err.push(b));
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (over) reject(new Error(`git ${args[0]} wrote more than ${Math.round(max / 1024 / 1024)} MB.`));
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(Buffer.concat(err).toString('utf8').trim().split('\n')[0] || `git exited with ${code}`));
    });
    p.stdin.on('error', () => undefined);
    p.stdin.end(input);
  });
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Blobs by id. Their sizes first (`--batch-check`), so that one too large is never read;
 * then `--batch` for the rest, each answer checked against the id asked for, so that no
 * answer is ever taken for another file's.
 */
async function readBlobs(root: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const oids = [...new Set(ids)].filter((o) => OID.test(o));
  if (!oids.length) return out;
  const checked = (await runWithInput(['cat-file', '--batch-check'], root, oids.join('\n') + '\n', oids.length * 128 + 4096)).toString('utf8').split('\n');
  const keep: Array<{ oid: string; size: number }> = [];
  let total = 0;
  oids.forEach((oid, i) => {
    const m = checked[i]?.match(/^(\S+) (\S+) (\d+)$/);
    if (!m || m[1] !== oid || m[2] !== 'blob') return;
    const size = Number(m[3]);
    if (size > MAX_BLOB_BYTES || total + size > MAX_BLOBS_BYTES) return;
    total += size;
    keep.push({ oid, size });
  });
  if (!keep.length) return out;
  const buf = await runWithInput(['cat-file', '--batch'], root, keep.map((k) => k.oid).join('\n') + '\n', total + keep.length * 128 + 4096);
  let at = 0;
  for (const k of keep) {
    const nl = buf.indexOf(10, at);
    const m = nl < 0 ? null : buf.subarray(at, nl).toString('utf8').match(/^(\S+) (\S+) (\d+)$/);
    if (!m || m[1] !== k.oid || Number(m[3]) !== k.size) throw new Error('git cat-file gave an answer for another object than the one asked for.');
    at = nl + 1;
    out.set(k.oid, decodeText(buf.subarray(at, at + k.size)));
    at += k.size + 1;
  }
  return out;
}

/** Where a path really is, through symbolic links; for a file that isn't there, its folder's. */
function realPath(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; ) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

const within = (root: string, file: string) => {
  // Drive letters and, on macOS and Windows, names are not case-sensitive.
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const r = (fold ? root.toLowerCase() : root).replace(/[\\/]+$/, '');
  const f = fold ? file.toLowerCase() : file;
  if (f === r) return '';
  if (!f.startsWith(r) || !/^[\\/]/.test(f.slice(r.length))) return undefined;
  return file.slice(r.length + 1).replace(/\\/g, '/');
};

/** The file's path inside the repository, as Git names it ("" for the root itself). */
export function rel(root: vscode.Uri, file: vscode.Uri): string {
  const direct = within(root.fsPath, file.fsPath);
  if (direct !== undefined) return direct;
  // Opened through a symbolic link: Git gives the root's real path.
  const real = within(realPath(root.fsPath), realPath(file.fsPath));
  if (real !== undefined) return real;
  throw new Error(`${file.fsPath} is outside the repository at ${root.fsPath}.`);
}

/** Whether a file is inside the repository. */
export function inRepo(root: vscode.Uri, file: vscode.Uri): boolean {
  try {
    rel(root, file);
    return true;
  } catch {
    return false;
  }
}

export const SHOW_SCHEME = 'graphql-breaking-changes-git';

/**
 * The repository that holds `file`. Throws GitUnavailable with a message for people when
 * there is none or Git can't run (Restricted Mode, no git).
 */
export async function repoFor(file: vscode.Uri): Promise<Repo> {
  if (!vscode.workspace.isTrusted) throw new GitUnavailable("Comparing with Git needs a trusted workspace: Git doesn't run in Restricted Mode.");
  if (file.scheme !== 'file') throw new GitUnavailable('Comparing with Git works for files on disk.');
  const api = await gitApi();
  if (api) {
    let repo = api.getRepository(file);
    // Right after startup Git is still discovering repositories.
    for (let waited = 0; !repo && api.state !== 'initialized' && waited < 10_000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
      repo = api.getRepository(file);
    }
    if (repo) {
      const r = repo;
      const cli = cliRepo(r.rootUri);
      return {
        ...cli,
        show: async (ref, f) => {
          if (!validRef(ref)) throw new Error(`Not a valid ref: ${ref}`);
          if (ref === INDEX) return cli.show(ref, f);
          try {
            return await r.show(ref, f.fsPath);
          } catch {
            // The API's errors don't say why; the CLI's do.
            return cli.show(ref, f);
          }
        },
        refs: async () => toItems(r.getRefs ? await r.getRefs() : (r.state.refs ?? []), r.state.HEAD),
        uriAt: (f, ref) => (api.toGitUri ? api.toGitUri(f, ref) : showUri(f, ref, r.rootUri)),
        onDidChange: r.state.onDidChange,
      };
    }
  }
  // No Git extension (disabled, or another editor): the CLI.
  let top: string;
  try {
    top = (await run(['rev-parse', '--show-toplevel'], vscode.Uri.joinPath(file, '..').fsPath)).trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT/.test(msg)) throw new GitUnavailable('Git is not installed or not on PATH.');
    throw new GitUnavailable(`${file.path.split('/').pop()} is not in a Git repository.`);
  }
  return cliRepo(vscode.Uri.file(top));
}

/** A repository driven through the git command. */
function cliRepo(root: vscode.Uri): Repo {
  const cwd = root.fsPath;
  return {
    root,
    show: (ref, f) => {
      if (!validRef(ref)) return Promise.reject(new Error(`Not a valid ref: ${ref}`));
      return showText(['show', spec(ref, rel(root, f))], cwd);
    },
    blobs: (oids) => readBlobs(cwd, oids),
    list: async (ref, folder) => {
      if (!validRef(ref)) throw new Error(`Not a valid ref: ${ref}`);
      const dir = rel(root, folder);
      // `<mode> <type> <oid>\t<path>` from ls-tree, `<mode> <oid> <stage>\t<path>` from ls-files.
      const args = ref === INDEX ? ['ls-files', '-z', '-s', '--', dir || '.'] : ['ls-tree', '-r', '-z', ref, '--', dir ? `${dir}/` : '.'];
      const out = await run(args, cwd);
      const prefix = dir ? `${dir}/` : '';
      const files: GitFile[] = [];
      for (const entry of out.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const [, a, b] = entry.slice(0, tab).split(' ');
        const p = entry.slice(tab + 1);
        const oid = ref === INDEX ? (b === '0' ? a : undefined) : a === 'blob' ? b : undefined;
        if (oid && p.startsWith(prefix)) files.push({ path: p.slice(prefix.length), oid });
      }
      return files;
    },
    refs: async () => {
      const out = await run(['for-each-ref', '--format=%(refname)%09%(objectname:short)', 'refs/heads', 'refs/tags', 'refs/remotes'], cwd);
      const items: RefItem[] = [{ name: 'HEAD', kind: 'head' }];
      for (const line of out.split('\n')) {
        const [full, commit] = line.split('\t');
        if (!full) continue;
        if (full.startsWith('refs/heads/')) items.push({ name: full.slice(11), kind: 'branch', commit });
        else if (full.startsWith('refs/tags/')) items.push({ name: full.slice(10), kind: 'tag', commit });
        else if (full.startsWith('refs/remotes/') && !full.endsWith('/HEAD')) items.push({ name: full.slice(13), kind: 'remote', commit });
      }
      return items;
    },
    uriAt: (f, ref) => showUri(f, ref, root),
    lastTag: () => lastTag(root),
    resolve: (ref) => resolve(root, ref),
  };
}

async function resolve(root: vscode.Uri, ref: string): Promise<string | undefined> {
  if (!validRef(ref) || ref === INDEX) return undefined;
  try {
    return (await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root.fsPath)).trim() || undefined;
  } catch (e) {
    // Git that can't run is not a ref that names nothing.
    if (/ENOENT/.test(e instanceof Error ? e.message : String(e))) throw new GitUnavailable('Git is not installed or not on PATH.');
    return undefined;
  }
}

async function lastTag(root: vscode.Uri): Promise<string | undefined> {
  try {
    const t = (await run(['describe', '--tags', '--abbrev=0', 'HEAD'], root.fsPath)).trim();
    return t && validRef(t) ? t : undefined;
  } catch {
    return undefined; // no tags
  }
}

function toItems(refs: GitRef[], head?: GitRef): RefItem[] {
  const items: RefItem[] = [{ name: 'HEAD', kind: 'head', commit: head?.commit }];
  for (const r of refs) {
    if (!r.name) continue;
    if (r.type === 0) items.push({ name: r.name, kind: 'branch', commit: r.commit });
    else if (r.type === 1) {
      if (!r.name.endsWith('/HEAD')) items.push({ name: r.name, kind: 'remote', commit: r.commit });
    } else if (r.type === 2) items.push({ name: r.name, kind: 'tag', commit: r.commit });
  }
  return items;
}

function showUri(file: vscode.Uri, ref: string, root: vscode.Uri) {
  return vscode.Uri.from({ scheme: SHOW_SCHEME, path: file.path, query: JSON.stringify({ ref, root: root.toString() }) });
}

/** Serves `showUri` documents (when the Git extension isn't there to do it). */
export function registerShowProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SHOW_SCHEME, {
    provideTextDocumentContent: async (uri) => {
      const { ref, root } = JSON.parse(uri.query) as { ref: string; root: string };
      const r = vscode.Uri.parse(root);
      if (!validRef(ref) || !vscode.workspace.isTrusted) return '';
      return showText(['show', spec(ref, rel(r, uri.with({ scheme: 'file', query: '' })))], r.fsPath);
    },
  });
}

/**
 * The file isn't there at that ref (it is newer): `git show` says the path does not exist
 * in it (in English: git runs with LC_ALL=C). A ref that names nothing is another error.
 */
export function missingAtRef(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /does not exist in|exists on disk, but not in|is in the index, but not at stage/i.test(m);
}
