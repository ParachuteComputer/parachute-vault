/**
 * Integration tests for `parachute-vault init` flag plumbing — the cases
 * where init exits early without touching the daemon, ~/.claude.json, or
 * the vault filesystem. The full happy-path of init isn't run here because
 * it would install a launchd agent on macOS and write into the developer's
 * real ~/Library/LaunchAgents — out of scope for unit tests. The vault-name
 * decision logic is fully covered by `vault-name.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");

function runCli(args: string[], env: Record<string, string> = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("vault init — --vault-name validation", () => {
  test("rejects --vault-name with uppercase + space and exits non-zero", () => {
    const { exitCode, stderr } = runCli(["init", "--vault-name", "My Vault"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--vault-name:");
    expect(stderr).toContain("lowercase alphanumeric");
  });

  test("rejects --vault-name with a slash and exits non-zero", () => {
    const { exitCode, stderr } = runCli(["init", "--vault-name", "team/work"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("lowercase alphanumeric");
  });

  test("rejects --vault-name with no value and exits non-zero", () => {
    // `--vault-name` is the last arg → no value follows.
    const { exitCode, stderr } = runCli(["init", "--vault-name"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("requires a value");
  });

  test("rejects reserved name 'list' and exits non-zero", () => {
    const { exitCode, stderr } = runCli(["init", "--vault-name", "list"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("reserved");
  });
});

describe("vault init — --help mentions --vault-name", () => {
  test("usage text documents the new flag", () => {
    const { exitCode, stdout } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--vault-name");
  });

  test("usage text documents --no-autostart (#113)", () => {
    const { exitCode, stdout } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--no-autostart");
  });
});

/**
 * End-to-end init under an isolated $HOME / $PARACHUTE_HOME so we never touch
 * the developer's real ~/.parachute or ~/Library/LaunchAgents. With
 * --no-autostart, init must:
 *   1. Persist `autostart: false` in config.yaml.
 *   2. NOT write the daemon wrapper (start.sh / server-path).
 *
 * --no-mcp / --no-token avoid the ~/.claude.json side effect; HOME=tmpdir
 * makes the launchd-uninstall-prior-registration call land inside the
 * sandbox even on macOS (where uninstallAgent operates on
 * `homedir()/Library/LaunchAgents/...`).
 */
describe("vault init — --no-autostart (#113)", () => {
  test("persists autostart=false and skips the daemon wrapper", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "vault-init-autostart-"));
    try {
      const parachuteHome = join(sandbox, ".parachute");
      const { exitCode, stdout } = runCli(
        [
          "init",
          "--no-autostart",
          "--no-mcp",
          "--no-token",
          "--vault-name",
          "autostarttest",
        ],
        { HOME: sandbox, PARACHUTE_HOME: parachuteHome },
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Autostart disabled");

      const configPath = join(parachuteHome, "vault", "config.yaml");
      expect(existsSync(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf-8")).toContain("autostart: false");

      // Daemon wrapper / pointer are written by installAgent /
      // installSystemdService — neither should run when autostart is off.
      expect(existsSync(join(parachuteHome, "vault", "start.sh"))).toBe(false);
      expect(existsSync(join(parachuteHome, "vault", "server-path"))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("re-running init without a flag preserves persisted autostart=false", () => {
    // We can't drive the --autostart re-run end-to-end here: it calls
    // installAgent() / installSystemdService() which write to launchd /
    // systemd state outside the PARACHUTE_HOME sandbox, breaking test
    // hermeticity. Instead verify the inverse property — that a no-flag
    // re-run honors the persisted opt-out and does NOT fall back to the
    // default-on. This is the actual user-facing risk (forgetting to pass
    // --no-autostart on every re-run shouldn't re-enable the daemon).
    const sandbox = mkdtempSync(join(tmpdir(), "vault-init-autostart-"));
    try {
      const parachuteHome = join(sandbox, ".parachute");
      const env = { HOME: sandbox, PARACHUTE_HOME: parachuteHome };

      const first = runCli(
        [
          "init",
          "--no-autostart",
          "--no-mcp",
          "--no-token",
          "--vault-name",
          "autostarttest",
        ],
        env,
      );
      expect(first.exitCode).toBe(0);

      const configPath = join(parachuteHome, "vault", "config.yaml");
      expect(readFileSync(configPath, "utf-8")).toContain("autostart: false");

      // No --autostart / --no-autostart on this run; init should read the
      // persisted false and skip daemon install again.
      const second = runCli(["init", "--no-mcp", "--no-token"], env);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("Autostart disabled");
      expect(readFileSync(configPath, "utf-8")).toContain("autostart: false");
      expect(existsSync(join(parachuteHome, "vault", "start.sh"))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

/**
 * #210: re-running `parachute-vault init` is the documented recovery path
 * for installs whose `services.json` is stale (#208 left some vaults out of
 * the manifest). The recovery is implicit — init re-registers the full
 * vault list every run via `buildVaultServicePaths` — so this test pins it
 * down with an explicit fixture: corrupt the manifest to drop one vault,
 * re-run init, expect the manifest to grow back.
 */
describe("vault init — repairs stale services.json (#210)", () => {
  test("re-running init rewrites services.json to include every vault on disk", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "vault-init-repair-"));
    try {
      const parachuteHome = join(sandbox, ".parachute");
      const env = { HOME: sandbox, PARACHUTE_HOME: parachuteHome };

      // Use `create` to bootstrap two vaults into a real, healthy state —
      // this also writes the initial services.json with both vaults so we
      // have a known-good baseline to corrupt.
      expect(runCli(["create", "alpha", "--json"], env).exitCode).toBe(0);
      expect(runCli(["create", "beta", "--json"], env).exitCode).toBe(0);

      const servicesPath = join(parachuteHome, "services.json");
      const baseline = JSON.parse(readFileSync(servicesPath, "utf-8"));
      const baselineEntry = baseline.services.find(
        (s: { name: string }) => s.name === "parachute-vault",
      );
      expect(baselineEntry.paths).toEqual(["/vault/alpha", "/vault/beta"]);

      // Corrupt: drop beta from the manifest, mimicking the #208 state where
      // an older `create` ran without the upsert.
      baselineEntry.paths = ["/vault/alpha"];
      writeFileSync(servicesPath, JSON.stringify(baseline, null, 2));

      // Re-run init with no flags that would change vault topology. The
      // sandbox env keeps launchd / ~/.claude.json side effects out of the
      // dev environment.
      const repair = runCli(
        ["init", "--no-autostart", "--no-mcp", "--no-token"],
        env,
      );
      expect(repair.exitCode).toBe(0);

      const repaired = JSON.parse(readFileSync(servicesPath, "utf-8"));
      const repairedEntry = repaired.services.find(
        (s: { name: string }) => s.name === "parachute-vault",
      );
      // alpha is still default (created first), so it leads. beta is back.
      expect(repairedEntry.paths).toEqual(["/vault/alpha", "/vault/beta"]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
