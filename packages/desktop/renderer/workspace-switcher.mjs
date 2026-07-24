export function workspaceChoiceLabels(choices) {
  const base = choices.map((choice) => choice.name
    || String(choice.id || "").split("/").filter(Boolean).at(-1)
    || "Workspace");
  const counts = new Map();
  for (const name of base) counts.set(name, (counts.get(name) || 0) + 1);
  return choices.map((choice, index) => {
    if (counts.get(base[index]) === 1) return base[index];
    const team = choice.team?.name ? `${choice.team.name} · ` : "";
    return `${base[index]} — ${team}${choice.id}`;
  });
}

const text = (value) => String(value || "");
const candidateId = (candidate) => text(candidate?.id || candidate?.path);
const candidateName = (candidate) => candidate?.name
  || candidateId(candidate).split("/").filter(Boolean).at(-1)
  || "Workspace";

export function createWorkspaceSwitcher({
  document, selectWorkspace, discoverSuggestions, addWorkspace, pickWorkspace,
}) {
  const q = (id) => document.getElementById(id);
  const trigger = q("ws-trigger"), currentName = q("ws-name"), menu = q("ws-menu");
  const menuSearch = q("ws-menu-search"), options = q("ws-options"), addOpen = q("ws-add-open");
  const modal = q("ws-modal"), dialog = modal.querySelector(".ws-dialog");
  const modalSearch = q("ws-suggestion-search"), suggestionsEl = q("ws-suggestions");
  const status = q("ws-dialog-status"), confirm = q("ws-confirm"), browse = q("ws-browse");
  const cancel = q("ws-cancel"), closeButton = q("ws-dialog-close");
  let generation = 0, modalGeneration = 0, activeId = "", workspaces = [], suggestions = [], selected = null;

  const setStatus = (message = "", error = false) => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };
  const closeMenu = (restore = false) => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restore) trigger.focus();
  };
  const menuItems = () => [...options.querySelectorAll(".ws-option:not([hidden])")];
  const renderOptions = () => {
    const query = menuSearch.value.trim().toLocaleLowerCase();
    const labels = workspaceChoiceLabels(workspaces);
    options.replaceChildren();
    workspaces.forEach((workspace, index) => {
      const haystack = `${labels[index]} ${workspace.id} ${workspace.team?.name || ""}`.toLocaleLowerCase();
      if (query && !haystack.includes(query)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ws-option";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(workspace.id === activeId));
      button.title = workspace.id;
      const check = document.createElement("span");
      check.className = "ws-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = workspace.id === activeId ? "✓" : "";
      const copy = document.createElement("span");
      copy.className = "ws-option-copy";
      const name = document.createElement("span");
      name.className = "ws-option-name";
      name.textContent = labels[index];
      const path = document.createElement("span");
      path.className = "ws-option-path";
      path.textContent = workspace.id;
      copy.append(name, path);
      button.append(check, copy);
      button.addEventListener("click", () => {
        closeMenu();
        if (workspace.id !== activeId) selectWorkspace(workspace.id);
      });
      options.append(button);
    });
  };
  const openMenu = () => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    menuSearch.value = "";
    renderOptions();
    menuSearch.focus();
  };

  const renderSuggestions = () => {
    const query = modalSearch.value.trim().toLocaleLowerCase();
    suggestionsEl.replaceChildren();
    const visible = suggestions.filter((candidate) => {
      const haystack = `${candidateName(candidate)} ${candidateId(candidate)} ${candidate.team?.name || ""} ${candidate.reason || ""}`.toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
    for (const candidate of visible) {
      const id = candidateId(candidate);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ws-suggestion";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(candidateId(selected) === id));
      button.title = id;
      const radio = document.createElement("span");
      radio.className = "ws-radio";
      radio.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "ws-suggestion-copy";
      const title = document.createElement("span");
      title.className = "ws-suggestion-title";
      title.textContent = candidateName(candidate);
      const meta = document.createElement("span");
      meta.className = "ws-suggestion-meta";
      meta.textContent = `${candidate.team?.name ? `${candidate.team.name} · ` : ""}${id}`;
      copy.append(title, meta);
      if (candidate.reason) {
        const reason = document.createElement("span");
        reason.className = "ws-suggestion-reason";
        reason.textContent = candidate.reason;
        copy.append(reason);
      }
      button.append(radio, copy);
      button.addEventListener("click", () => {
        selected = candidate;
        confirm.disabled = false;
        renderSuggestions();
      });
      suggestionsEl.append(button);
    }
    if (!visible.length && !status.textContent) setStatus("No matching OAS workspaces found.");
  };

  const closeModal = (restore = true) => {
    modalGeneration++;
    modal.hidden = true;
    selected = null;
    confirm.disabled = true;
    if (restore) trigger.focus();
  };
  const openModal = async () => {
    closeMenu();
    const token = ++modalGeneration;
    modal.hidden = false;
    modalSearch.value = "";
    suggestions = [];
    selected = null;
    confirm.disabled = true;
    browse.disabled = false;
    suggestionsEl.replaceChildren();
    setStatus("Finding OAS workspaces…");
    modalSearch.focus();
    try {
      const result = await discoverSuggestions();
      if (token !== modalGeneration) return;
      const found = Array.isArray(result) ? result : (result?.suggestions || []);
      const added = new Set(workspaces.map((workspace) => workspace.id));
      suggestions = found.filter((candidate) => candidateId(candidate) && !added.has(candidateId(candidate)));
      setStatus(suggestions.length ? `${suggestions.length} suggested workspace${suggestions.length === 1 ? "" : "s"}` : "No additional OAS workspaces were discovered.");
      renderSuggestions();
    } catch (error) {
      if (token !== modalGeneration) return;
      setStatus(error?.message || "Could not discover OAS workspaces.", true);
    }
  };

  const onBrowse = async () => {
    const token = ++modalGeneration;
    setStatus("Choose an OAS workspace folder…");
    try {
      const candidate = await pickWorkspace();
      if (token !== modalGeneration) return;
      if (!candidate) { setStatus("No folder selected."); return; }
      const normalized = typeof candidate === "string" ? { id: candidate, path: candidate } : candidate;
      if (!suggestions.some((item) => candidateId(item) === candidateId(normalized))) suggestions.unshift(normalized);
      selected = normalized;
      confirm.disabled = false;
      setStatus("Folder validated. Review it, then add the workspace.");
      renderSuggestions();
    } catch (error) {
      if (token !== modalGeneration) return;
      setStatus(error?.message || "Could not use that folder.", true);
    }
  };
  const onConfirm = async () => {
    if (!selected) return;
    const token = ++modalGeneration;
    const choice = selected;
    confirm.disabled = true;
    browse.disabled = true;
    setStatus(`Adding ${candidateName(choice)}…`);
    try {
      const result = await addWorkspace(choice);
      if (token !== modalGeneration) return;
      browse.disabled = false;
      const workspace = result?.workspace || choice;
      const list = result?.workspaces || [...workspaces, workspace];
      render(workspace, list);
      closeModal(false);
      selectWorkspace(candidateId(workspace));
      trigger.focus();
    } catch (error) {
      if (token !== modalGeneration) return;
      browse.disabled = false;
      confirm.disabled = false;
      setStatus(error?.message || "Could not add that workspace.", true);
    }
  };

  const render = (workspace, list = []) => {
    activeId = workspace?.id || "";
    workspaces = Array.isArray(list) ? [...list] : [];
    if (workspace && !workspaces.some((candidate) => candidate.id === activeId)) workspaces.unshift(workspace);
    currentName.textContent = workspace ? candidateName(workspace) : "Resolving…";
    trigger.title = activeId ? `Active workspace: ${activeId}` : "Resolving active workspace";
    renderOptions();
  };

  const onTrigger = () => menu.hidden ? openMenu() : closeMenu(true);
  const onDocumentPointer = (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
  };
  const onMenuKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeMenu(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = menuItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
    items[next].focus();
  };
  const onDialogKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled])")].filter((element) => !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  trigger.addEventListener("click", onTrigger);
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "Enter", " "].includes(event.key) && menu.hidden) { event.preventDefault(); openMenu(); }
  });
  menuSearch.addEventListener("input", renderOptions);
  menu.addEventListener("keydown", onMenuKey);
  addOpen.addEventListener("click", openModal);
  modalSearch.addEventListener("input", renderSuggestions);
  browse.addEventListener("click", onBrowse);
  confirm.addEventListener("click", onConfirm);
  cancel.addEventListener("click", () => closeModal());
  closeButton.addEventListener("click", () => closeModal());
  modal.addEventListener("mousedown", (event) => { if (event.target === modal) closeModal(); });
  dialog.addEventListener("keydown", onDialogKey);
  document.addEventListener("mousedown", onDocumentPointer);

  render(null);
  return {
    begin() {
      const token = ++generation;
      return (workspace, list) => {
        if (token !== generation) return false;
        render(workspace, list);
        return true;
      };
    },
    reset() { generation++; render(null); },
    openMenu,
    openModal,
  };
}
