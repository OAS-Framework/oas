import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { listInstances } from "../core.mjs";

function exec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2500, ...options,
    }).trimEnd();
  } catch { return ""; }
}

export function readMarkdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^#{1,6} ${escaped}\\s*$([\\s\\S]*?)(?=^#{1,6} |(?![\\s\\S]))`, "mi"));
  if (!match) return "";
  return match[1]
    .replace(/^\s*<!--[^]*?-->\s*$/gm, "")
    .split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^_.*_$/.test(line)).join(" ").replace(/\s+/g, " ").trim();
}

function readMarkdown(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function countMarkdown(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) count += countMarkdown(path);
    else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md" && entry.name !== "log.md") count++;
  }
  return count;
}

export function parseTmuxWindows(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [session, window, id, active, command, dead] = line.split("\t");
    return { session, window, id, active: active === "1", command: command || "", dead: dead === "1" };
  });
}

export function parseGitStatus(text, fallbackBranch = "") {
  const lines = text.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : "";
  const branch = head.split("...")[0].replace(/^No commits yet on /, "") || fallbackBranch || "?";
  const ahead = Number(head.match(/\[ahead (\d+)/)?.[1] || 0);
  const behind = Number(head.match(/behind (\d+)/)?.[1] || 0);
  return { branch, dirty: lines.length, ahead, behind };
}

export function parseGitDiffStat(text) {
  let additions = 0;
  let deletions = 0;
  for (const row of text.split("\n")) {
    const [added, deleted] = row.split("\t");
    if (/^\d+$/.test(added)) additions += Number(added);
    if (/^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  return { additions, deletions };
}

function gitState(work, fallbackBranch) {
  const empty = { branch: fallbackBranch || "?", dirty: 0, ahead: 0, behind: 0, additions: 0, deletions: 0 };
  if (!work || !existsSync(work)) return { ...empty, missing: true };
  const output = exec("git", ["-C", work, "status", "--short", "--branch", "--untracked-files=normal"]);
  if (!output) return { ...empty, missing: true };
  const diff = exec("git", ["-C", work, "diff", "--numstat", "HEAD", "--"]);
  return { ...parseGitStatus(output, fallbackBranch), ...parseGitDiffStat(diff) };
}

// ── Session tail state ── locate the newest session log for an instance and
// classify its tail: did the last exchange end in a provider/session error?
// Shared contract with oas-web (briefs/model-contract.md).

function latestFile(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch { return undefined; }
}

export function sessionFileFor(instance) {
  const home = instance.home || "";
  if ((instance.runtime || "pi") === "pi") {
    const dir = join(homedir(), ".pi", "agent", "sessions", `-${home.replace(/\//g, "-")}--`);
    return { file: latestFile(dir), kind: "pi" };
  }
  const encoded = home.replace(/\//g, "-");
  for (const base of [".claude", ".claude-personal", ".claude-work"]) {
    const file = latestFile(join(homedir(), base, "projects", encoded));
    if (file) return { file, kind: "claude" };
  }
  return { file: undefined, kind: "claude" };
}

// Provider error text may contain newlines/control chars that would break
// single-line rendering surfaces; collapse to plain single-spaced text.
const tidyError = (raw) => String(raw).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

/** Classify jsonl tail lines: the FINAL message decides. An assistant message
 * with stopReason "error" (pi) or an error/isApiErrorMessage marker (claude)
 * means the session died there; any later normal message means it recovered. */
export function classifySessionTail(lines, kind) {
  let result = { state: "unknown", errorMessage: null, ts: null };
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const ts = entry.timestamp || entry.ts || null;
    if (kind === "pi") {
      if (entry.type !== "message" || !entry.message) continue;
      if (entry.message.stopReason === "error") {
        result = { state: "error", errorMessage: tidyError(entry.message.errorMessage || "session error"), ts };
      } else result = { state: "ok", errorMessage: null, ts };
    } else {
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      if (entry.isApiErrorMessage || entry.error) {
        const raw = entry.error || (Array.isArray(entry.message?.content) ? entry.message.content.map((b) => b?.text || "").join(" ") : entry.message?.content) || "session error";
        result = { state: "error", errorMessage: tidyError(raw), ts };
      } else result = { state: "ok", errorMessage: null, ts };
    }
  }
  return result;
}

function readTail(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), truncated: size > length };
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

export function sessionTailState(instance) {
  const { file, kind } = sessionFileFor(instance);
  if (!file) return { state: "unknown", errorMessage: null, ts: null };
  const tail = readTail(file);
  if (!tail?.text) return { state: "unknown", errorMessage: null, ts: null };
  const lines = tail.text.split("\n").filter(Boolean);
  // Only when the read started mid-file may the first line be a cut record.
  if (tail.truncated && lines.length > 1) lines.shift();
  return classifySessionTail(lines, kind);
}

export function buildConstellation(instances) {
  const byName = new Map(instances.map((instance) => [instance.instance, instance]));
  const children = new Map(instances.map((instance) => [instance.instance, []]));
  const roots = [];
  for (const instance of instances) {
    if (instance.parentInstance && instance.parentInstance !== instance.instance && byName.has(instance.parentInstance)) {
      children.get(instance.parentInstance).push(instance);
    } else roots.push(instance);
  }
  const sort = (items) => items.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.instance.localeCompare(b.instance);
  });
  sort(roots);
  for (const value of children.values()) sort(value);

  const rows = [];
  const visited = new Set();
  function visit(instance, depth, ancestorsLast = [], last = false) {
    if (visited.has(instance.instance)) return;
    visited.add(instance.instance);
    rows.push({ instance, depth, ancestorsLast, last });
    const kids = children.get(instance.instance) || [];
    kids.forEach((child, index) => visit(child, depth + 1, [...ancestorsLast, last], index === kids.length - 1));
  }
  roots.forEach((root, index) => visit(root, 0, [], index === roots.length - 1));
  // Defensive cycle handling: malformed metadata must not hide a live instance.
  for (const instance of instances) if (!visited.has(instance.instance)) visit(instance, 0, [], true);
  return rows;
}

export function collectControlPane(root) {
  const tmuxText = exec("tmux", ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}\t#{window_id}\t#{window_active}\t#{pane_current_command}\t#{pane_dead}"]);
  const windows = parseTmuxWindows(tmuxText);
  const windowByTarget = new Map(windows.map((window) => [`${window.session}:${window.window}`, window]));
  const knowledgeCounts = new Map();
  const agents = listInstances(root);
  const instances = [];

  for (const agent of agents) {
    const knowledgeDir = join(agent.dir, "soul", "knowledge");
    if (!knowledgeCounts.has(knowledgeDir)) knowledgeCounts.set(knowledgeDir, countMarkdown(knowledgeDir));
    for (const metadata of agent.instances) {
      const home = metadata.home || join(agent.dir, "instances", metadata.instance);
      const workPath = join(home, "work");
      const taskText = readMarkdown(join(home, "TASK.md"));
      const stateText = readMarkdown(join(home, "STATE.md"));
      const session = metadata.tmux?.session || "pi-agents";
      const windowName = metadata.tmux?.window || metadata.instance;
      const window = windowByTarget.get(`${session}:${windowName}`);
      const sessionTail = sessionTailState({ home, runtime: metadata.runtime });
      instances.push({
        ...metadata,
        agent: metadata.agent || agent.name,
        description: agent.description || "",
        home,
        running: !!window && !window.dead,
        tmux: { session, window: windowName, id: window?.id },
        command: window?.command || "",
        git: gitState(workPath, metadata.branch),
        task: readMarkdownSection(taskText, "Task") || "No task provided",
        next: readMarkdownSection(stateText, "Next") || "No next action recorded",
        progress: readMarkdownSection(stateText, "Progress"),
        knowledgeCount: knowledgeCounts.get(knowledgeDir),
        sessionTail,
      });
    }
  }

  return {
    root,
    generatedAt: new Date().toISOString(),
    instances,
    rows: buildConstellation(instances),
    running: instances.filter((instance) => instance.running).length,
    soulCount: agents.length,
    tmuxAvailable: windows.length > 0,
  };
}

export function capturePreview(instance, lines = 24) {
  if (!instance?.running) return "This instance is not running. Press r to refresh after resuming it.";
  const target = `${instance.tmux.session}:${instance.tmux.window}`;
  // -e preserves the pane's native SGR colors; the TUI filters non-SGR control
  // sequences before rendering the preview.
  return exec("tmux", ["capture-pane", "-p", "-e", "-J", "-t", target, "-S", `-${Math.max(8, lines)}`]) || "The pane is running but has no visible output.";
}

export function switchToInstance(instance) {
  if (!instance?.running) return false;
  const target = `${instance.tmux.session}:${instance.tmux.window}`;
  try {
    if (process.env.TMUX) execFileSync("tmux", ["select-window", "-t", target], { stdio: "ignore" });
    else execFileSync("tmux", ["attach-session", "-t", instance.tmux.session, ";", "select-window", "-t", target], { stdio: "inherit" });
    return true;
  } catch { return false; }
}

export function relativeAge(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, now - new Date(timestamp || now).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function workspaceName(root) { return basename(join(root, "..")); }
