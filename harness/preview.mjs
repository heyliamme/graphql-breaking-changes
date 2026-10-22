// Renders the real webview outside VS Code, for UI work.
//
//   npm run build
//   node harness/preview.mjs samples/bookshop-v1.graphql samples/bookshop-v2.graphql
//   google-chrome --headless=new --window-size=1280,860 --screenshot=out/dark.png "file://$PWD/out/preview.html?theme=dark"
//
// Query parameters: theme=dark|light.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)(path.join(root, 'dist/core.js'));
const [oldFile = 'samples/bookshop-v1.graphql', newFile = 'samples/bookshop-v2.graphql'] = process.argv.slice(2);
const read = (f) => readFileSync(path.resolve(f), 'utf8');

const THEMES = {
  dark: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-list-hoverBackground:#2a2d2e;--vscode-input-background:#313131;--vscode-focusBorder:#0078d4;--vscode-descriptionForeground:#9d9d9d;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-button-secondaryForeground:#cccccc;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-textLink-foreground:#4daafc;`,
  light: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-list-hoverBackground:#f2f2f2;--vscode-input-background:#ffffff;--vscode-focusBorder:#005fb8;--vscode-descriptionForeground:#717171;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryHoverBackground:#cccccc;--vscode-button-secondaryForeground:#3b3b3b;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-textLink-foreground:#005fb8;`,
};

const side = (f) => ({ text: read(f), path: path.resolve(f) });
const r = core.compare(side(oldFile), side(newFile));
const changes = core.applyPolicy(r.changes, { ignore: [], warningsAsErrors: false });
const report = {
  old: { label: path.basename(oldFile), detail: oldFile, path: path.resolve(oldFile), info: r.info.old, error: r.errors.old },
  new: { label: path.basename(newFile), detail: newFile, path: path.resolve(newFile), info: r.info.new, error: r.errors.new },
  changes,
  counts: core.count(changes),
  warnings: r.warnings,
  ms: r.ms,
  strict: false,
};

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>:root{${THEMES.dark}} :root.light{${THEMES.light}}</style>
<link rel="stylesheet" href="codicon.css">
<style>${read(path.join(root, 'dist/webview.css'))}</style></head>
<body><div id="app"></div>
<script>
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') { document.documentElement.classList.add('light'); document.body.className = 'vscode-light'; }
else document.body.className = 'vscode-dark';
const report = ${JSON.stringify(report).replace(/</g, '\\u003c')};
window.acquireVsCodeApi = () => ({ setState: () => {}, getState: () => undefined, postMessage: (m) => {
  console.log('host <-', JSON.stringify(m).slice(0, 200));
  if (m.type === 'ready') setTimeout(() => window.postMessage({ type: 'report', report }, '*'));
}});
</script>
<script>${read(path.join(root, 'dist/webview.js'))}</script>
</body></html>`;

mkdirSync(path.join(root, 'out'), { recursive: true });
writeFileSync(path.join(root, 'out/preview.html'), html);
for (const f of ['codicon.css', 'codicon.ttf']) writeFileSync(path.join(root, 'out', f), readFileSync(path.join(root, 'dist', f)));
console.log(path.join(root, 'out/preview.html'));
