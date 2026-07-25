// Packaged-app code-signature verification (macOS) — the strict deep
// codesign gate that would have rejected the v0.18.2 installers.
//
// Defect class this exists to catch (verified on the shipped v0.18.2 arm64
// DMG): the app executable carried only the LINKER-GENERATED partial ad-hoc
// signature (`flags=adhoc,linker-signed`, `Sealed Resources=none`, no
// Contents/_CodeSignature), which fails
//   codesign --verify --deep --strict --verbose=2 "OAS Desktop.app"
// with "code has no resources but signature indicates they must be present"
// and makes Gatekeeper report the app as damaged. The x64 bundle was not
// signed at all. A COMPLETE ad-hoc bundle signature (electron-builder
// identity "-" — @electron/osx-sign signs every nested helper/framework and
// seals resources) passes; anything less must fail here.
//
// Execution discipline: same contract as smoke-probes.mjs — every child
// runs through the injected reaper's runTracked (async, detached,
// group-tracked, timeout kills the whole group). No synchronous execution.

/** The EXACT strict deep verification argv. Pinned and exported so tests
 * can assert the command cannot drift to a weaker form (dropping --deep or
 * --strict would re-admit the v0.18.2 partial-signature class). */
export function verifyArgv(appPath) {
  return ["--verify", "--deep", "--strict", "--verbose=2", appPath];
}

/** Display argv — used to log the signature identity/flags as evidence. */
export function displayArgv(appPath) {
  return ["--display", "--verbose=2", appPath];
}

/**
 * Verify the packaged .app bundle carries a complete, valid (ad-hoc)
 * bundle signature.
 *
 * @param reaper  MUST provide runTracked (group-tracked async execution).
 * @param appPath absolute path to the .app bundle.
 * @param opts    { timeout, platform, existsSync } — platform/fs injectable
 *                for tests; verification is meaningful on darwin only and
 *                REFUSES to pass elsewhere (a caller must never treat a
 *                non-darwin run as verified).
 * @returns { ok, detail } — never throws.
 */
export async function verifyAppSignature(reaper, appPath, {
  timeout = 120_000,
  platform = process.platform,
  existsSync,
} = {}) {
  if (typeof reaper?.runTracked !== "function") {
    return { ok: false, detail: "codesign verify requires a reaper with runTracked (async group-tracked execution is the contract)" };
  }
  if (platform !== "darwin") {
    return { ok: false, detail: `codesign verification is only meaningful on darwin (got ${platform})` };
  }
  if (typeof existsSync !== "function") {
    return { ok: false, detail: "codesign verify requires an injected existsSync" };
  }
  // Structural pre-check: the v0.18.2 arm64 bundle had NO
  // Contents/_CodeSignature at all (linker-signed executable only). Assert
  // the bundle seal exists before asking codesign — this names the defect
  // class precisely in the failure message.
  const seal = `${appPath}/Contents/_CodeSignature/CodeResources`;
  if (!existsSync(seal)) {
    return { ok: false, detail: `no bundle signature seal at ${seal} — this is the v0.18.2 defect class (linker-signed executable, unsealed bundle)` };
  }
  const v = await reaper.runTracked("codesign", verifyArgv(appPath), { timeout });
  if (v.timedOut) {
    return { ok: false, detail: "codesign --verify --deep --strict timed out (group killed)" };
  }
  if (v.code !== 0) {
    const tail = `${String(v.stdout)}\n${String(v.stderr || "")}`.trim().slice(-1000);
    return { ok: false, detail: `codesign --verify --deep --strict FAILED (exit ${v.code}) for ${appPath}: ${tail}` };
  }
  // Evidence line: show what signed the bundle (ad-hoc, no team). Display
  // failure after a successful verify is still a failure — the evidence is
  // part of the gate.
  const d = await reaper.runTracked("codesign", displayArgv(appPath), { timeout });
  if (d.timedOut || d.code !== 0) {
    return { ok: false, detail: `codesign --display failed after a passing verify (exit ${d.code}, timedOut=${d.timedOut})` };
  }
  const info = String(d.stderr || d.stdout || "");
  const sig = /Signature=([^\n]+)/.exec(info)?.[1]?.trim() ?? "unknown";
  const sealed = /Sealed Resources[^\n]*/.exec(info)?.[0] ?? "Sealed Resources: unknown";
  if (/linker-signed/.test(info)) {
    return { ok: false, detail: `bundle is only linker-signed (partial ad-hoc) — the v0.18.2 defect class: ${info.slice(0, 400)}` };
  }
  return {
    ok: true,
    detail: `codesign --verify --deep --strict PASSED for ${appPath} (Signature=${sig}; ${sealed})`,
  };
}
