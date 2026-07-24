// Semantic tab chrome and keyboard policy, isolated so ARIA relationships and
// roving-navigation behavior are covered without booting the whole shell.
export function createTabChrome(document, id, title, isMac = false) {
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.setAttribute("role", "presentation");

  const triggerEl = document.createElement("button");
  triggerEl.type = "button";
  triggerEl.className = "tab-trigger";
  triggerEl.id = `tab-${id}`;
  triggerEl.setAttribute("role", "tab");
  triggerEl.setAttribute("aria-selected", "false");
  triggerEl.setAttribute("aria-controls", `tabpanel-${id}`);
  triggerEl.tabIndex = -1;
  triggerEl.textContent = title;

  const closeEl = document.createElement("button");
  closeEl.type = "button";
  closeEl.className = "close";
  closeEl.textContent = "×";
  closeEl.setAttribute("aria-label", `Close ${title}`);
  closeEl.title = `Close ${title} (Delete or ${isMac ? "⌘" : "Ctrl"}+W)`;
  tabEl.append(triggerEl, closeEl);

  const paneEl = document.createElement("div");
  paneEl.className = "tab-pane";
  paneEl.id = `tabpanel-${id}`;
  paneEl.setAttribute("role", "tabpanel");
  paneEl.setAttribute("aria-labelledby", triggerEl.id);
  paneEl.hidden = true;
  return { tabEl, triggerEl, closeEl, paneEl };
}

export function tabKeyAction(event, index, count) {
  const key = event.key;
  if (key === "Delete" || ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "w")) {
    return { type: "close" };
  }
  if (!count) return null;
  if (key === "ArrowRight") return { type: "move", index: (index + 1) % count };
  if (key === "ArrowLeft") return { type: "move", index: (index - 1 + count) % count };
  if (key === "Home") return { type: "move", index: 0 };
  if (key === "End") return { type: "move", index: count - 1 };
  return null;
}

/** Restore focus after the focused final tab is removed. The shell chooses the
 * logical destination (Instances filter for terminals, active nav for an
 * artifact's restored stage); this function performs the testable DOM move. */
export function focusAfterLastTab(kind, { instancesEntry, stageEntry }) {
  const target = kind === "terminal" ? instancesEntry : stageEntry;
  if (!target || typeof target.focus !== "function") return false;
  target.focus();
  return target.ownerDocument?.activeElement === target;
}
