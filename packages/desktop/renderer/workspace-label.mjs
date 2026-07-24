// Generation-owned workspace selector updates. Each roster request begins an
// operation; only the latest operation may commit server-resolved options.
export function workspaceChoiceLabels(choices) {
  const base = choices.map((choice) => choice.name
    || String(choice.id || "").split("/").filter(Boolean).at(-1)
    || "Workspace");
  const counts = new Map(base.map((name) => [name, base.filter((candidate) => candidate === name).length]));
  return choices.map((choice, index) => {
    if (counts.get(base[index]) === 1) return base[index];
    const team = choice.team?.name ? `${choice.team.name} · ` : "";
    return `${base[index]} — ${team}${choice.id}`;
  });
}

export function createWorkspaceLabel(element) {
  let generation = 0;
  const render = (workspace, workspaces = []) => {
    const id = workspace?.id || "";
    const choices = Array.isArray(workspaces) ? [...workspaces] : [];
    if (workspace && !choices.some((candidate) => candidate.id === id)) choices.unshift(workspace);
    element.replaceChildren();
    if (!choices.length) {
      const option = element.ownerDocument.createElement("option");
      option.value = "";
      option.textContent = "Resolving…";
      element.append(option);
      element.title = "Resolving active workspace";
      return;
    }
    const labels = workspaceChoiceLabels(choices);
    choices.forEach((choice, index) => {
      const option = element.ownerDocument.createElement("option");
      option.value = choice.id;
      option.textContent = labels[index];
      option.title = String(choice.id || "");
      element.append(option);
    });
    element.value = id;
    element.title = id ? `Active workspace: ${id}` : "Select active workspace";
  };
  return {
    begin() {
      const token = ++generation;
      return (workspace, workspaces) => {
        if (token !== generation) return false;
        render(workspace, workspaces);
        return true;
      };
    },
    reset() {
      generation++;
      render(null);
    },
  };
}

export function bindWorkspaceSelect(element, selectWorkspace) {
  const onChange = () => selectWorkspace(element.value);
  element.addEventListener("change", onChange);
  return () => element.removeEventListener("change", onChange);
}
