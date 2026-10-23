// HTML shell of a webview: a strict content security policy, the view's bundle and the shared
// stylesheet. No network access (ADR 0008): only local resources and inline styles.
import * as vscode from 'vscode';

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** `view` is the folder name under packages/webviews/src and the bundle name in dist/webviews. */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  view: string,
  title: string,
): string {
  const n = nonce();
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', `${view}.js`),
  );
  const styles = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', 'base.css'),
  );
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styles.toString()}">
<title>${title.replace(/[<>&"]/g, '')}</title>
</head>
<body>
<div id="root" role="main" aria-label="${title.replace(/[<>&"]/g, '')}"></div>
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
}
