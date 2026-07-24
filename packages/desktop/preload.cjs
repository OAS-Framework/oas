// OAS desktop — preload. The ONLY bridge between the isolated renderer and
// the main process. Exposes a minimal, promise-based surface; no Node objects
// cross the boundary.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oasDesktop", {
  /** ctx.api backing: proxied fetch against the oas-web server. */
  api: (pathname, opts) => ipcRenderer.invoke("api", pathname, opts),

  /** Integrated terminal channels (one pty per open terminal tab). */
  termOpen: (spec) => ipcRenderer.invoke("term:open", spec),
  termWrite: (id, data) => ipcRenderer.send("term:write", id, data),
  termResize: (id, cols, rows) => ipcRenderer.send("term:resize", id, cols, rows),
  termClose: (id) => ipcRenderer.send("term:close", id),

  /** Runtime workspace switcher (privileged; renderer modal is the UX layer). */
  workspaceSuggestions: () => ipcRenderer.invoke("workspace:suggestions"),
  workspaceAdd: (path) => ipcRenderer.invoke("workspace:add", path),
  workspacePick: () => ipcRenderer.invoke("workspace:pick"),

  /** CLI degradation affordances: native binary picker (Choose oas…) and
   * focus-triggered re-probe notifications (contract re-probe triggers). */
  cliPickBinary: () => ipcRenderer.invoke("cli:pick"),
  onAppFocus: (cb) => {
    const fn = () => cb();
    ipcRenderer.on("app:focus", fn);
    return () => ipcRenderer.removeListener("app:focus", fn);
  },
  onTermData: (id, cb) => {
    const ch = `term:data:${id}`;
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  onTermExit: (id, cb) => {
    const ch = `term:exit:${id}`;
    const fn = (_e, code) => cb(code);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
});
