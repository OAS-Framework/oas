// Pure workspace scoping for shell terminal tabs.
// Same-named instances may exist in several workspaces; a terminal tab is
// only visible/eligible for auto-activation in the workspace that resolved
// its tmux target.
export function terminalTabsForWorkspace(entries, ws) {
  return [...entries].filter(([, tab]) => tab.kind === "terminal" && tab.workspace === ws);
}

export function tabVisibleInContext(tab, mode, ws) {
  if (mode === "instances") return tab.kind === "terminal" && tab.workspace === ws;
  if (mode === "souls") return tab.kind === "brain" || tab.kind === "file";
  return false;
}

export function canActivateTab(tab, ws) {
  return !!tab && (tab.kind !== "terminal" || tab.workspace === ws);
}

export function fallbackTabForContext(entries, mode, ws) {
  return [...entries].filter(([, tab]) => tabVisibleInContext(tab, mode, ws)).at(-1) || null;
}

export function terminalOpenOwnsWorkspace(capturedWs, currentWs) {
  return capturedWs === currentWs;
}
