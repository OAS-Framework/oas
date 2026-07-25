// OAS desktop — application menu policy (pure; unit-tested).
//
// macOS: without an Edit role menu, Cmd+C/V/X/A are dead in the renderer —
// transcript text could be selected but never copied. Cmd-based accelerators
// cannot collide with terminal control chords (those are Ctrl-based), so the
// full role menu is safe there.
//
// Linux/Windows: role menus register Ctrl accelerators (Ctrl+C, Ctrl+A,
// Ctrl+Z, Ctrl+R, Ctrl+W, …) that fire BEFORE web content and would steal
// core terminal chords from xterm — interrupt, line-start, suspend, history
// search, delete-word (review befe75b important 1). Chromium already handles
// clipboard shortcuts natively in web content on these platforms, so the
// correct menu is NO menu: return null and the caller installs none.
export function appMenuTemplate(platform) {
  if (platform !== "darwin") return null;
  return [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
