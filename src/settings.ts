import * as vscode from 'vscode';
import { isSafeGlob, readIgnore, type IgnoreRule, type Level, type Policy } from './core';

export const SECTION = 'graphqlBreakingChanges';

export function policy(scope?: vscode.Uri): Policy {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return { ignore: readIgnore(c.get('ignore')), warningsAsErrors: c.get('treatWarningsAsErrors') === true };
}

/**
 * The pattern for the other files of a split schema, relative to the folder of the file
 * being compared; "" for a single file. A pattern that climbs out of the folder is not
 * used. In Restricted Mode VS Code hands back the user's value, not the workspace's.
 */
export function schemaGlob(scope?: vscode.Uri): string {
  const v = vscode.workspace.getConfiguration(SECTION, scope).get('schemaFiles');
  const g = typeof v === 'string' ? v.trim() : '';
  return g && isSafeGlob(g) ? g : '';
}

export function baseRef(scope?: vscode.Uri): string {
  const v = vscode.workspace.getConfiguration(SECTION, scope).get('baseRef');
  return typeof v === 'string' ? v.trim() : '';
}

export function problemsLevel(scope?: vscode.Uri): Level {
  const v = vscode.workspace.getConfiguration(SECTION, scope).get('problemsLevel');
  return v === 'error' || v === 'info' ? v : 'warning';
}

/** Where an ignore rule goes: the folder of the schema, the workspace, or the user settings. */
export function ignoreTarget(scope?: vscode.Uri): { target: vscode.ConfigurationTarget; name: string } {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) return { target: vscode.ConfigurationTarget.Global, name: 'user' };
  // In a multi-root workspace each folder keeps its own rules.
  if (folders.length > 1 && scope && vscode.workspace.getWorkspaceFolder(scope)) return { target: vscode.ConfigurationTarget.WorkspaceFolder, name: 'folder' };
  return { target: vscode.ConfigurationTarget.Workspace, name: 'workspace' };
}

/**
 * Adds an ignore rule. `user` puts it in the user settings whatever the workspace, for
 * Restricted Mode, where the workspace's own rules are not applied.
 */
export async function addIgnore(rules: IgnoreRule | string | Array<IgnoreRule | string>, scope?: vscode.Uri, user = false): Promise<string> {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  const { target, name } = user ? { target: vscode.ConfigurationTarget.Global, name: 'user' } : ignoreTarget(scope);
  // Add to what that target holds, not the merged value (which includes user settings).
  const info = c.inspect<unknown>('ignore');
  const held = target === vscode.ConfigurationTarget.WorkspaceFolder ? info?.workspaceFolderValue : target === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue;
  const current = Array.isArray(held) ? held : [];
  const have = new Set(current.map((x) => JSON.stringify(x)));
  const fresh = (Array.isArray(rules) ? rules : [rules]).filter((r) => {
    const k = JSON.stringify(r);
    return !have.has(k) && have.add(k);
  });
  if (fresh.length) await c.update('ignore', [...current, ...fresh], target);
  return name;
}

/** Above this many characters a schema is compared again when saved, not as you type. */
export const LIVE_LIMIT = 3_000_000;

/** The length of a document's text, without building the string. */
export function sizeOf(doc: vscode.TextDocument): number {
  return doc.lineCount ? doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end) : 0;
}
