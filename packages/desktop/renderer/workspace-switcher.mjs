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
  let adding = false;

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
    const focusedId = document.activeElement?.classList?.contains("ws-option")
      ? document.activeElement.dataset.workspaceId : "";
    options.replaceChildren();
    workspaces.forEach((workspace, index) => {
      const haystack = `${labels[index]} ${workspace.id} ${workspace.team?.name || ""}`.toLocaleLowerCase();
      if (query && !haystack.includes(query)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ws-option";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(workspace.id === activeId));
      button.dataset.workspaceId = workspace.id;
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
        closeMenu(true);
        if (workspace.id !== activeId) selectWorkspace(workspace.id);
      });
      options.append(button);
    });
    if (focusedId && !menu.hidden) {
      [...options.querySelectorAll(".ws-option")].find((button) => button.dataset.workspaceId === focusedId)?.focus();
    }
  };
  const openMenu = () => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    menuSearch.value = "";
    renderOptions();
    menuSearch.focus();
  };

  const renderSuggestions = (focusId = "") => {
    const query = modalSearch.value.trim().toLocaleLowerCase();
    suggestionsEl.replaceChildren();
    const visible = suggestions.filter((candidate) => {
      const haystack = `${candidateName(candidate)} ${candidateId(candidate)} ${candidate.team?.name || ""} ${candidate.reason || ""}`.toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
    const selectedId = candidateId(selected);
    const selectedIsVisible = visible.some((candidate) => candidateId(candidate) === selectedId);
    visible.forEach((candidate, index) => {
      const id = candidateId(candidate);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ws-suggestion";
      button.dataset.workspaceId = id;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(selectedId === id));
      button.tabIndex = selectedId === id || (!selectedIsVisible && index === 0) ? 0 : -1;
      button.disabled = adding;
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
        if (adding) return;
        selected = candidate;
        confirm.disabled = false;
        renderSuggestions(id);
      });
      suggestionsEl.append(button);
    });
    if (focusId) {
      [...suggestionsEl.querySelectorAll(".ws-suggestion")]
        .find((button) => button.dataset.workspaceId === focusId)?.focus();
    }
    if (!visible.length && !status.textContent) setStatus("No matching OAS workspaces found.");
  };

  const setAdding = (value) => {
    adding = value;
    dialog.setAttribute("aria-busy", String(value));
    browse.disabled = value;
    cancel.disabled = value;
    closeButton.disabled = value;
    modalSearch.disabled = value;
    for (const suggestion of suggestionsEl.querySelectorAll(".ws-suggestion")) suggestion.disabled = value;
    confirm.disabled = value || !selected;
  };
  const closeModal = (restore = true) => {
    if (adding) return false;
    modalGeneration++;
    modal.hidden = true;
    selected = null;
    confirm.disabled = true;
    if (restore) trigger.focus();
    return true;
  };
  const openModal = async () => {
    if (adding) return;
    closeMenu();
    const token = ++modalGeneration;
    modal.hidden = false;
    modalSearch.value = "";
    suggestions = [];
    selected = null;
    setAdding(false);
    suggestionsEl.replaceChildren();
    setStatus("Finding OAS workspaces…");
    modalSearch.focus();
    try {
      const result = await discoverSuggestions();
      if (token !== modalGeneration || result?.stale) return;
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

  const reconcileAddedWorkspace = (workspace) => {
    const list = [...workspaces.filter((candidate) => candidate.id !== workspace.id), workspace];
    render(workspace, list);
    closeModal(false);
    selectWorkspace(candidateId(workspace));
    trigger.focus();
  };
  const resolvedMutation = (result) => {
    if (result?.ok && result.workspace) { reconcileAddedWorkspace(result.workspace); return true; }
    if (result?.code === "superseded") { setStatus(""); return true; }
    return false;
  };
  const mutationFailureMessage = (result, fallback) => result?.code === "not-suggested"
    ? `${result.reason || "That workspace is no longer suggested."} Use Browse… to choose it explicitly.`
    : result?.reason || fallback;
  const onBrowse = async () => {
    if (adding) return;
    const token = ++modalGeneration;
    const previousStatus = status.textContent;
    setAdding(true);
    setStatus("Choose an OAS workspace folder…");
    try {
      const result = await pickWorkspace();
      if (token !== modalGeneration) return;
      setAdding(false);
      if (result?.code === "cancelled") { setStatus(previousStatus); return; }
      if (resolvedMutation(result)) return;
      setStatus(mutationFailureMessage(result, "Could not use that folder."), true);
    } catch (error) {
      if (token !== modalGeneration) return;
      setAdding(false);
      setStatus(error?.message || "Could not use that folder.", true);
    }
  };
  const onConfirm = async () => {
    if (!selected || adding) return;
    const token = ++modalGeneration;
    const choice = selected;
    setAdding(true);
    setStatus(`Adding ${candidateName(choice)}…`);
    try {
      const result = await addWorkspace(choice.path);
      if (token !== modalGeneration) return;
      setAdding(false);
      if (resolvedMutation(result)) return;
      setStatus(mutationFailureMessage(result, "Could not add that workspace."), true);
    } catch (error) {
      if (token !== modalGeneration) return;
      setAdding(false);
      setStatus(error?.message || "Could not add that workspace.", true);
    }
  };

  const render = (workspace, list = []) => {
    activeId = workspace?.id || "";
    workspaces = Array.isArray(list) ? [...list] : [];
    if (workspace && !workspaces.some((candidate) => candidate.id === activeId)) workspaces.unshift(workspace);
    const labels = workspaceChoiceLabels(workspaces);
    const activeIndex = workspaces.findIndex((candidate) => candidate.id === activeId);
    currentName.textContent = workspace ? (labels[activeIndex] || candidateName(workspace)) : "Resolving…";
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
  const onSuggestionKey = (event) => {
    if (adding || !["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const target = event.target.closest?.(".ws-suggestion");
    if (!target) return;
    event.preventDefault();
    const items = [...suggestionsEl.querySelectorAll(".ws-suggestion")];
    const index = items.indexOf(target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : ["ArrowDown", "ArrowRight"].includes(event.key) ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
    const id = items[next].dataset.workspaceId;
    selected = suggestions.find((candidate) => candidateId(candidate) === id) || selected;
    confirm.disabled = !selected;
    renderSuggestions(id);
  };
  const onDialogKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled])")]
      .filter((element) => !element.hidden && element.tabIndex >= 0);
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
  suggestionsEl.addEventListener("keydown", onSuggestionKey);
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
