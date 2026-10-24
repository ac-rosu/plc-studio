// Styles of the table views, injected once (the webview CSP allows inline styles).
export const GRID_CSS = `
.grid input[type='text'] {
  width: 100%;
  box-sizing: border-box;
  border-color: transparent;
  background: transparent;
}
.grid input[type='text']:hover,
.grid input[type='text']:focus {
  border-color: var(--vscode-input-border, var(--vscode-focusBorder));
  background: var(--vscode-input-background);
}
.grid td.center { text-align: center; }
.grid tr.section th {
  background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorGroupHeader-tabsBackground));
  font-weight: 600;
}
.grid tr.has-problem td:first-child { box-shadow: inset 3px 0 0 var(--vscode-editorWarning-foreground); }
.grid td.missing { background: var(--vscode-inputValidation-warningBackground); }
.grid td.readonly, .grid td.muted { color: var(--vscode-descriptionForeground); }
.grid td.actions { white-space: nowrap; }
.grid td.actions button { padding: 0 6px; }
.problem-bar {
  padding: 4px 12px;
  background: var(--vscode-inputValidation-errorBackground);
  border-bottom: 1px solid var(--vscode-inputValidation-errorBorder);
}
.note { padding: 4px 12px; color: var(--vscode-descriptionForeground); }
details.block-section > summary {
  padding: 6px 12px;
  cursor: pointer;
  font-weight: 600;
  background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorGroupHeader-tabsBackground));
  border-top: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, transparent));
}
.view-message { padding: 24px; color: var(--vscode-descriptionForeground); }
.level-1 td:nth-child(1) { padding-left: 18px; }
.level-2 td:nth-child(1) { padding-left: 32px; }
.level-3 td:nth-child(1) { padding-left: 46px; }
.level-4 td:nth-child(1) { padding-left: 60px; }
`;

export function injectStyles(css: string = GRID_CSS): void {
  const id = `plcstudio-css-${css.length}`;
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}
