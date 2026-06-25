/**
 * Integration tests for `parachute-vault create <name> [--json]`.
 *
 * The `--json` mode is the contract the hub orchestrator parses: stdout
 * carries a single JSON object with name/token/paths/set_as_default. These
 * tests spawn the CLI in a temp `PARACHUTE_HOME` so the create lands on a
 * fresh, isolated vault tree and we can assert the on-disk artifacts the
 * payload claims to have written.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");

function runCli(
  args: string[],
  env: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  // Hermetic: don't inherit the dev/CI box's PARACHUTE_HUB_ORIGIN. A leaked
  // origin makes `detectHubPresence`'s rule-1 (configured-origin) short-circuit
  // to "hub present" with no probe, flipping the no-hub guidance copy to the
  // "admin wizard" variant — a CI flake when the runner env has it set. Tests
  // that genuinely want a hub origin pass it explicitly via `env`.
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.PARACHUTE_HUB_ORIGIN;
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ...env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Path to a vault's per-vault mirror-config file inside a temp PARACHUTE_HOME. */
function mirrorConfigPath(home: string, name: string): string {
  return join(home, "vault", "data", name, "mirror-config.yaml");
}

/** Path to a vault's internal mirror git working tree. */
function mirrorRepoPath(home: string, name: string): string {
  return join(home, "vault", "data", name, "mirror");
}

/** Write a minimal config.yaml carrying a `default_mirror` knob value. */
function writeDefaultMirrorKnob(home: string, value: "internal" | "off"): void {
  const dir = join(home, "vault");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), `port: 1940\ndefault_mirror: ${value}\n`);
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vault-create-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("vault create --json", () => {
  test("emits parseable JSON with name, token, paths, set_as_default=true on first vault", () => {
    const { exitCode, stdout, stderr } = runCli(
      ["create", "myvault", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    // stdout must be exactly one JSON object — single-line, parseable.
    // Asserting line count first so a regression that prints a banner above
    // the JSON fails with "expected 1 line, got 2" rather than the much
    // less actionable "JSON parse error".
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(payload.name).toBe("myvault");
    // vault#442: default auth is per-user OAuth — `create` does NOT mint a
    // token. The contract hub's admin-vaults.ts requires still holds (`token`
    // is a string); it's the empty string and `token_guidance` carries the
    // OAuth-first connect path (the hub SPA handles the empty-token case and
    // mints admin via its own session-cookie path).
    expect(typeof payload.token).toBe("string");
    expect(payload.token).toBe("");
    expect(payload.token_guidance).toContain("No token minted");
    expect(payload.token_guidance).toContain("per-user OAuth");
    expect(payload.set_as_default).toBe(true);
    expect(payload.paths.vault_dir).toBe(join(home, "vault", "data", "myvault"));
    expect(payload.paths.vault_db).toBe(join(home, "vault", "data", "myvault", "vault.db"));
    expect(payload.paths.vault_config).toBe(join(home, "vault", "data", "myvault", "vault.yaml"));

    // Sanity: the on-disk artifacts the payload describes actually exist.
    expect(existsSync(payload.paths.vault_dir)).toBe(true);
    expect(existsSync(payload.paths.vault_db)).toBe(true);
    expect(existsSync(payload.paths.vault_config)).toBe(true);
  });

  test("set_as_default=false when another vault already holds the default slot", () => {
    runCli(["create", "first", "--json"], { PARACHUTE_HOME: home });
    const { exitCode, stdout } = runCli(
      ["create", "second", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.name).toBe("second");
    expect(payload.set_as_default).toBe(false);
  });

  test("--json works regardless of flag position (before or after name)", () => {
    const { exitCode, stdout } = runCli(
      ["create", "--json", "before"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.name).toBe("before");
  });

  test("invalid name in --json mode still errors on stderr (not stdout) and exits non-zero", () => {
    const { exitCode, stdout, stderr } = runCli(
      ["create", "Bad Name", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("lowercase alphanumeric");
  });

  test("UPPERCASE vault name is rejected (security review — audience case-drift)", () => {
    // An uppercase name would flip the JWT audience case (vault.<Name> vs
    // vault.<name>) and drift from hub/init lowercasing. cmdCreate must
    // reject it the same way `init` does.
    const { exitCode, stdout, stderr } = runCli(
      ["create", "MyVault", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("lowercase");
  });

  test("reserved names (list/new/assets/admin) are rejected at create", () => {
    // Consolidated reserved set (2026-06-09 hub-module-boundary B2). Before
    // the consolidation cmdCreate hardcoded only "list" — `admin` could enter
    // through `create` and capture the daemon-level /vault/admin mount.
    for (const reserved of ["list", "new", "assets", "admin"]) {
      const { exitCode, stdout, stderr } = runCli(
        ["create", reserved, "--json"],
        { PARACHUTE_HOME: home },
      );
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("reserved");
      // The vault must not have been created.
      expect(existsSync(join(home, "vault", "data", reserved))).toBe(false);
    }
  });

  test("near-misses of reserved names (adminx, admin2) create fine", () => {
    for (const name of ["adminx", "admin2"]) {
      const { exitCode, stdout } = runCli(["create", name, "--json"], {
        PARACHUTE_HOME: home,
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim()).name).toBe(name);
    }
  });

  test("duplicate name in --json mode errors on stderr and exits non-zero", () => {
    runCli(["create", "dup", "--json"], { PARACHUTE_HOME: home });
    const { exitCode, stdout, stderr } = runCli(
      ["create", "dup", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("already exists");
  });
});

/**
 * vault#442: default to per-user OAuth — `create` must NOT auto-mint or bake in
 * a shared `vault:<name>:admin` token. Token-minting is explicit opt-in
 * (`--mint`) and scope-narrow (read/write, NEVER admin); `--token <bearer>` is
 * the paste path. These tests pin the behavioral contract.
 */
describe("vault create — OAuth-first auth (vault#442)", () => {
  test("default create does NOT mint a token — empty token + OAuth guidance (--json)", () => {
    const { exitCode, stdout } = runCli(["create", "oauthy", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim());
    // No token baked in — OAuth on first connect.
    expect(payload.token).toBe("");
    expect(payload.token_guidance).toContain("No token minted");
    expect(payload.token_guidance).toContain("per-user OAuth");
    // Never the admin-mint failure copy.
    expect(payload.token_guidance).not.toContain("No token issued");
    expect(payload.token_guidance).not.toContain("admin");
  });

  test("default create leads the human summary with the OAuth connect command", () => {
    const { exitCode, stdout } = runCli(["create", "connectme"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "Connect your AI: claude mcp add --transport http parachute-connectme",
    );
    expect(stdout).toContain("no token needed");
    // Scope-narrow opt-in pointer, never admin.
    expect(stdout).toContain("parachute auth mint-token --scope vault:connectme:read");
    expect(stdout).not.toContain("vault:connectme:admin");
  });

  test("--scope admin is rejected from the create flow (admin never mintable here)", () => {
    const { exitCode, stdout, stderr } = runCli(
      ["create", "noadmin", "--mint", "--scope", "admin", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain('--scope must be "read" or "write"');
    // The vault must not have been created (rejected before createVault).
    expect(existsSync(join(home, "vault", "data", "noadmin", "vault.db"))).toBe(false);
  });

  test("--mint and --token are mutually exclusive", () => {
    const { exitCode, stderr } = runCli(
      ["create", "conflict", "--mint", "--token", "abc.def.ghi", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("mutually exclusive");
  });

  test("--token <bearer> paste path surfaces the supplied bearer (no mint attempted)", () => {
    const { exitCode, stdout } = runCli(
      ["create", "pasted", "--token", "header.auth.bearer", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim());
    // The pasted bearer is surfaced verbatim — vault never minted one.
    expect(payload.token).toBe("header.auth.bearer");
    expect(payload.token_guidance).toContain("--token");
    // No admin scope, no mint-failure copy.
    expect(payload.token_guidance).not.toContain("No token issued");
  });

  test("--mint (no hub reachable) opts in but mints scope-narrow read, never admin", () => {
    // In this sandbox there's no hub/operator.token, so the mint can't complete
    // — but the request is scope-narrow read by default and must NEVER ask for
    // an admin grant. We assert the create still succeeds and the guidance is
    // the standalone path (the scope requested is read, per
    // mintBootstrapCredential).
    //
    // Point the hub-presence probe at a guaranteed-closed port so the test is
    // deterministic regardless of whether a real hub happens to be running on
    // the dev box's 1939 (#445 added a live `/health` probe to branch the
    // no-operator-token copy).
    const { exitCode, stdout } = runCli(
      ["create", "wantmint", "--mint", "--json"],
      { PARACHUTE_HOME: home, PARACHUTE_HUB_PORT: "59399" },
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim());
    // No hub here → no token, and the standalone guidance asks for NO admin
    // grant (the #445 hub-present "admin wizard" copy is gated out by the dead
    // probe port above).
    expect(payload.token).toBe("");
    expect(payload.token_guidance).not.toContain("admin");
  });
});

/**
 * Regression tests for #208: `vault create` was not updating
 * `~/.parachute/services.json`, so vaults created after init were invisible
 * to the hub well-known endpoint and to paraclaw's attach picker. cmdCreate
 * now re-registers the parachute-vault entry with the full vault list every
 * time. The default vault must sort first because the hub uses `paths[0]`
 * as the canonical mount for `.well-known/parachute.json`.
 */
describe("vault create — services.json registration (#208)", () => {
  function readServices(): { name: string; paths: string[]; port: number }[] {
    const raw = readFileSync(join(home, "services.json"), "utf-8");
    return JSON.parse(raw).services;
  }

  test("create-first-vault registers parachute-vault entry with /vault/<name>", () => {
    const { exitCode } = runCli(["create", "first", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);

    const services = readServices();
    const vault = services.find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    expect(vault!.paths).toEqual(["/vault/first"]);
  });

  test("create-additional-vault grows the paths array (default stays first)", () => {
    runCli(["create", "alpha", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "beta", "--json"], { PARACHUTE_HOME: home });

    const vault = readServices().find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    // alpha is the default (created first), so it must lead. beta follows.
    expect(vault!.paths).toEqual(["/vault/alpha", "/vault/beta"]);
  });

  test("create-multiple preserves default-first ordering across N vaults", () => {
    runCli(["create", "one", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "two", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "three", "--json"], { PARACHUTE_HOME: home });

    const vault = readServices().find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    expect(vault!.paths[0]).toBe("/vault/one");
    expect(vault!.paths.slice(1).sort()).toEqual([
      "/vault/three",
      "/vault/two",
    ]);
    expect(vault!.paths).toHaveLength(3);
  });

  test("--json mode keeps stdout parseable even when services.json is updated", () => {
    // Regression guard: warnings from upsertService must go to stderr, not
    // stdout — otherwise the hub orchestrator's JSON.parse(stdout) breaks.
    const { stdout } = runCli(["create", "clean", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });
});

/**
 * Onboarding-guide seeding on create (demo-prep Workstream A — A1/A3).
 *
 * A freshly-created vault must contain the `Getting Started` + `Surface Starter`
 * notes so a connected AI can read them and help set the vault up. Idempotent +
 * best-effort: the seed never fails a create and never clobbers an edited note.
 */
describe("vault create — onboarding guide seeding (A1/A3)", () => {
  /** Read all (path, content) rows from a created vault's SQLite DB. */
  function readNotes(name: string): { path: string | null; content: string }[] {
    const dbPath = join(home, "vault", "data", name, "vault.db");
    const db = new Database(dbPath, { readonly: true });
    try {
      return db
        .query("SELECT path, content FROM notes")
        .all() as { path: string | null; content: string }[];
    } finally {
      db.close();
    }
  }

  test("create seeds Getting Started + Surface Starter notes", () => {
    const { exitCode } = runCli(["create", "guided", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);

    const notes = readNotes("guided");
    const gs = notes.find((n) => n.path === "Getting Started");
    const ss = notes.find((n) => n.path === "Surface Starter");
    expect(gs).toBeDefined();
    expect(ss).toBeDefined();
    expect(gs!.content).toContain("# Getting Started");
    expect(gs!.content).toContain("[[Surface Starter]]");
    expect(ss!.content).toContain("@openparachute/surface-client");
  });

  test("seeding doesn't break --json stdout (notes seeded silently)", () => {
    const { stdout } = runCli(["create", "jsonclean", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });
});

describe("vault create (human mode)", () => {
  test("prints multi-line human output without --json", () => {
    const { exitCode, stdout } = runCli(
      ["create", "human"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Vault "human" created.');
    // vault#442: default auth is per-user OAuth — NO token is minted, even when
    // a hub would have been reachable. The human output leads with the OAuth
    // connect command and never prints an "API token:" line.
    expect(stdout).toContain("No token minted");
    expect(stdout).toContain("Connect your AI: claude mcp add --transport http parachute-human");
    expect(stdout).not.toContain("API token:");
    // The old admin auto-mint failure copy must NOT fire on a default create.
    expect(stdout).not.toContain("No token issued");
    // Human output should NOT be valid JSON.
    expect(() => JSON.parse(stdout.trim())).toThrow();
  });
});

/**
 * Create-time default backup posture: new vaults default to an internal live
 * mirror (local git backup of the markdown projection). The History preset
 * `{enabled:true, location:internal, sync_mode:events, auto_commit:true,
 * auto_push:false}` is written to `data/<vault>/mirror-config.yaml` and (when
 * git is present) the internal mirror dir is git-bootstrapped. The behavior is
 * controlled by the server-wide `default_mirror` knob (default `internal`) and
 * overridable per-create by `--no-mirror`.
 *
 * Critically: create-time ONLY — already-created vaults are NOT retroactively
 * migrated, and the git-less box stays a successful create (best-effort
 * bootstrap, config still written, actionable log).
 */
describe("vault create — default internal live mirror", () => {
  test("default (no knob) → History-preset mirror config written + git-bootstrapped", () => {
    const { exitCode } = runCli(["create", "backed", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);

    // Mirror config exists with the exact History preset.
    const cfgPath = mirrorConfigPath(home, "backed");
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = readFileSync(cfgPath, "utf-8");
    expect(cfg).toContain("enabled: true");
    expect(cfg).toContain("location: internal");
    expect(cfg).toContain("sync_mode: events");
    expect(cfg).toContain("auto_commit: true");
    expect(cfg).toContain("auto_push: false");

    // Git present on the test host → the internal mirror dir is a real repo
    // with the seed commit (bootstrap ran). counts/usage reflect it: the
    // mirror working tree exists under the vault data dir.
    const repo = mirrorRepoPath(home, "backed");
    expect(existsSync(join(repo, ".git"))).toBe(true);
    const log = Bun.spawnSync({
      cmd: ["git", "-C", repo, "log", "--oneline"],
      stdout: "pipe",
    });
    expect(new TextDecoder().decode(log.stdout)).toContain("initial mirror bootstrap");
  });

  test("default_mirror: off knob → no mirror config written", () => {
    writeDefaultMirrorKnob(home, "off");
    const { exitCode } = runCli(["create", "bare", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);

    // Vault is created…
    expect(existsSync(join(home, "vault", "data", "bare", "vault.db"))).toBe(true);
    // …but NO mirror config + NO mirror dir.
    expect(existsSync(mirrorConfigPath(home, "bare"))).toBe(false);
    expect(existsSync(mirrorRepoPath(home, "bare"))).toBe(false);
  });

  test("default_mirror: internal knob (explicit) → mirror config written", () => {
    writeDefaultMirrorKnob(home, "internal");
    const { exitCode } = runCli(["create", "explicit", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);
    expect(existsSync(mirrorConfigPath(home, "explicit"))).toBe(true);
  });

  test("--no-mirror → no mirror config even when knob is internal", () => {
    writeDefaultMirrorKnob(home, "internal");
    const { exitCode } = runCli(["create", "optout", "--no-mirror", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);

    expect(existsSync(join(home, "vault", "data", "optout", "vault.db"))).toBe(true);
    expect(existsSync(mirrorConfigPath(home, "optout"))).toBe(false);
    expect(existsSync(mirrorRepoPath(home, "optout"))).toBe(false);
  });

  test("--no-mirror in human mode keeps the rest of the create working", () => {
    const { exitCode, stdout } = runCli(["create", "humanbare", "--no-mirror"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Vault "humanbare" created.');
    expect(existsSync(mirrorConfigPath(home, "humanbare"))).toBe(false);
  });

  test("git missing → vault still creates, config written, mirror NOT bootstrapped, actionable log, no crash", () => {
    // Simulate a git-less server: spawn the CLI with a PATH that resolves
    // `bun` (so the test can run) but NOT `git`. `bootstrapInternalMirror`'s
    // `Bun.which("git")` preflight then returns null → friendly,
    // best-effort failure. The vault create MUST still succeed.
    const bunBin = Bun.which("bun");
    expect(bunBin).toBeTruthy();
    const fakeBin = mkdtempSync(join(tmpdir(), "vault-create-nogit-bin-"));
    symlinkSync(bunBin!, join(fakeBin, "bun"));
    try {
      const proc = Bun.spawnSync({
        cmd: [bunBin!, CLI, "create", "nogit", "--json"],
        stdout: "pipe",
        stderr: "pipe",
        // Replace PATH entirely so `git` is unresolvable — only our fake bin
        // (bun only) is on the path.
        env: { ...process.env, PARACHUTE_HOME: home, PATH: fakeBin },
      });
      const exitCode = proc.exitCode ?? -1;
      const stdout = new TextDecoder().decode(proc.stdout);
      const stderr = new TextDecoder().decode(proc.stderr);

      // No crash — the vault create succeeds on a git-less box.
      expect(exitCode).toBe(0);
      // The vault itself was created.
      expect(existsSync(join(home, "vault", "data", "nogit", "vault.db"))).toBe(true);
      // The mirror CONFIG was still written (intent persists for when git
      // lands later).
      expect(existsSync(mirrorConfigPath(home, "nogit"))).toBe(true);
      // But the mirror was NOT git-bootstrapped (no .git — git was absent).
      expect(existsSync(join(mirrorRepoPath(home, "nogit"), ".git"))).toBe(false);
      // And the operator got an actionable, clear log on stderr.
      expect(stderr).toContain("local git backup configured but not yet active");
      expect(stderr).toContain("Install git");
      // JSON stdout stays clean + parseable (the note went to stderr).
      const payload = JSON.parse(stdout.trim());
      expect(payload.name).toBe("nogit");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test("EXISTING vault (created before this change) is NOT auto-migrated on a later create", () => {
    // Simulate a vault that predates the default-mirror behavior: create it
    // with the knob OFF so it gets no mirror config (stand-in for "created by
    // an older vault build").
    writeDefaultMirrorKnob(home, "off");
    const first = runCli(["create", "legacy", "--json"], { PARACHUTE_HOME: home });
    expect(first.exitCode).toBe(0);
    expect(existsSync(mirrorConfigPath(home, "legacy"))).toBe(false);

    // Now flip the knob ON and create a SECOND, different vault. The act of
    // creating "fresh" (which DOES get a mirror) must not retroactively write
    // a mirror config onto the pre-existing "legacy" vault — create-time only,
    // never a sweep over existing vaults.
    writeDefaultMirrorKnob(home, "internal");
    const second = runCli(["create", "fresh", "--json"], { PARACHUTE_HOME: home });
    expect(second.exitCode).toBe(0);

    // The new vault is backed…
    expect(existsSync(mirrorConfigPath(home, "fresh"))).toBe(true);
    // …but the pre-existing vault is left exactly as it was — no surprise
    // mirror config, no surprise disk-doubling mirror repo.
    expect(existsSync(mirrorConfigPath(home, "legacy"))).toBe(false);
    expect(existsSync(mirrorRepoPath(home, "legacy"))).toBe(false);
  });
});
