/* oas desktop — shell navigation manifest + stage-view loader.
   Extracted from shell.mjs so shell-level tests can exercise the SAME
   name→module wiring the production rail uses (regression: the Instances
   view shipped unreachable because no NAV entry loaded it — merged-state
   review of feature/desktop-ux-fixes). shell.mjs binds these one-to-one. */

/** First-class stage destinations on the nav rail. Every entry's `name`
 * must resolve through loadStageView to a mount-exporting view module. */
export const NAV = [
  { name: "hierarchy", label: "Active overview", icon: "⌘", title: "Active overview" },
  { name: "instances", label: "Instances", icon: "▤", title: "Instance roster, transcripts and details" },
  { name: "spawn", label: "Soul roster", icon: "✦", title: "Soul roster" },
];

/** Sidebar mode a stage view pairs with (spawn shows the souls context). */
export function stageSidebarMode(name) {
  return name === "spawn" ? "souls" : "overview";
}

/** The exact dynamic import the stage host performs. Kept here so tests can
 * prove every NAV entry loads a real mount-exporting module. */
export function loadStageView(name) {
  return import(new URL(`./views/${name}.mjs`, import.meta.url).href);
}
