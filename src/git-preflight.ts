/**
 * Shared git-availability preflight.
 *
 * Every git-using entry point in vault (mirror import, mirror sync/commit/
 * push, internal-mirror bootstrap) shells out to the `git` binary via
 * `Bun.spawn(["git", ...])`. On a server where `git` isn't installed (a
 * fresh Amazon Linux / minimal Docker image, etc.) Bun throws a raw
 * `Executable not found in $PATH: "git"` error, which the import route only
 * caught in its generic `internal` 500 branch — surfacing an unhelpful,
 * un-actionable error to the operator.
 *
 * This module centralizes the preflight so every git entry point fails
 * fast with a clear, actionable message that tells the operator HOW to
 * fix it (install git via their distro's package manager).
 *
 * Found live on the gitcoin-parachute EC2 deploy (Amazon Linux, no git).
 * See vault#415-era fix.
 */

/**
 * Thrown when `git` is required for an operation but isn't on PATH. Carries
 * an OS-agnostic-but-helpful message with the common install commands so the
 * operator can act without leaving the error surface.
 */
export class GitNotInstalledError extends Error {
  constructor() {
    super(
      "git is required for this operation but was not found on the server. " +
        "Install git and retry — e.g. `sudo dnf install git` (Amazon Linux / Fedora), " +
        "`sudo apt-get install -y git` (Debian / Ubuntu), or `brew install git` (macOS).",
    );
    this.name = "GitNotInstalledError";
  }
}

/**
 * Throw `GitNotInstalledError` if `git` isn't resolvable on PATH.
 *
 * `which` is a TEST SEAM (default `Bun.which`) so tests can force the
 * git-missing branch without uninstalling git from the test host. Production
 * callers pass nothing and get the real `Bun.which`.
 */
export function ensureGitAvailable(
  which: (cmd: string) => string | null = Bun.which,
): void {
  if (which("git") === null) {
    throw new GitNotInstalledError();
  }
}

/**
 * Heuristic: does this error look like the "git executable not found" failure
 * Bun throws when it can't resolve the binary? Used as a belt-and-suspenders
 * catch around `Bun.spawn(["git", ...])` so a spawn that slips past the
 * preflight (race where git is removed between check and spawn, or a code path
 * that didn't preflight) still surfaces the friendly error instead of the raw
 * `Executable not found in $PATH: "git"` string.
 */
export function isGitNotFoundSpawnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  // Bun: `Executable not found in $PATH: "git"`.
  // Node/posix: ENOENT spawn errors mention the missing file.
  return (
    (msg.includes("Executable not found") && msg.includes("git")) ||
    ((err as { code?: string }).code === "ENOENT" && msg.includes("git"))
  );
}
