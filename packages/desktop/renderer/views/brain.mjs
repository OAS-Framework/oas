// Placeholder view: "brain" — replaced by its owning developer per the
// desktop-app contract. Shell integration contract: export mount(el, ctx)
// and unmount(); ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }.
export async function mount(el, ctx) {
  el.innerHTML = `
    <div class="placeholder">
      <h2>brain view</h2>
      <div>placeholder — the brain view module ships separately into renderer/views/brain.mjs</div>
      <div>ctx received: ${Object.keys(ctx).join(", ")}</div>
    </div>`;
}
export function unmount() {}
