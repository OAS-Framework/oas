// Placeholder view: "chat" — replaced by its owning developer per the
// desktop-app contract. Shell integration contract: export mount(el, ctx)
// and unmount(); ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }.
export async function mount(el, ctx) {
  el.innerHTML = `
    <div class="placeholder">
      <h2>chat view</h2>
      <div>placeholder — the chat view module ships separately into renderer/views/chat.mjs</div>
      <div>ctx received: ${Object.keys(ctx).join(", ")}</div>
    </div>`;
}
export function unmount() {}
