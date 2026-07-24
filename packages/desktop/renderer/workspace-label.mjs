// Generation-owned workspace header updates. Each roster request begins an
// operation; only the latest operation may commit a server-resolved name.
export function createWorkspaceLabel(element) {
  let generation = 0;
  const render = (workspace) => {
    const id = workspace?.id || "";
    const name = workspace?.name || id.split("/").filter(Boolean).at(-1) || "";
    element.textContent = name || "Resolving…";
    element.title = id ? `Active workspace: ${id}` : "Resolving active workspace";
  };
  return {
    begin() {
      const token = ++generation;
      return (workspace) => {
        if (token !== generation) return false;
        render(workspace);
        return true;
      };
    },
    reset() {
      generation++;
      render(null);
    },
  };
}
