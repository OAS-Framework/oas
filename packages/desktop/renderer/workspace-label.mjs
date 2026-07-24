// Generation-owned workspace header updates. Each roster request begins an
// operation; only the latest operation may commit a server-resolved name.
export function createWorkspaceLabel(element) {
  let generation = 0;
  const render = (workspace) => {
    element.textContent = workspace?.name ? `· ${workspace.name}` : "";
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
