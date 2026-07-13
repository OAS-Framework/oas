import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const OAS_MOUSE_BLOCK = `# OAS: scroll agent windows normally with a mouse or trackpad.\nset -g mouse on\n`;

/** Choose the tmux user config without creating a second competing config. */
export function tmuxConfigPath(home = homedir(), env = process.env) {
  const legacy = join(home, ".tmux.conf");
  const xdg = join(env.XDG_CONFIG_HOME || join(home, ".config"), "tmux", "tmux.conf");
  return existsSync(legacy) || !existsSync(xdg) ? legacy : xdg;
}

/** Whether the selected config explicitly enables tmux mouse support. */
export function tmuxMouseEnabled(text) {
  return text.split("\n").some((line) => {
    const active = line.replace(/\s+#.*$/, "").trim();
    return /^(?:set|set-option)(?:\s+-[a-zA-Z]+)*\s+mouse\s+(?:on|1)\s*$/.test(active);
  });
}

/** Add the setting once and reload a running tmux server when possible. */
export function enableTmuxMouse(configPath = tmuxConfigPath()) {
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (tmuxMouseEnabled(before)) return { changed: false, configPath, reloaded: false };

  mkdirSync(dirname(configPath), { recursive: true });
  const separator = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  appendFileSync(configPath, separator + OAS_MOUSE_BLOCK);

  const server = spawnSync("tmux", ["has-session"], { stdio: "ignore" });
  const reloaded = server.status === 0 && spawnSync("tmux", ["source-file", configPath], { stdio: "ignore" }).status === 0;
  return { changed: true, configPath, reloaded };
}
