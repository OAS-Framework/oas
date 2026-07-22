// Placeholder view: "diff" — replaced by its owning developer per the
// desktop-app contract. Shell integration contract: export mount(el, ctx)
// and unmount(); ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }.
export async function mount(el, ctx) {
  el.innerHTML = `
    <div class="placeholder">
      <h2>diff view</h2>
      <div>placeholder — the diff view module ships separately into renderer/views/diff.mjs</div>
      <div>ctx received: ${Object.keys(ctx).join(", ")}</div>
    </div>`;
}
export function unmount() {}
