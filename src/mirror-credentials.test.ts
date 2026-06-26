/**
 * Tests for mirror-credentials.ts — the UI-configurable git push
 * credential store.
 *
 * Coverage:
 *   - Read/write round-trip (parse + serialize symmetric across realistic
 *     credential shapes).
 *   - File perms enforced at 0o600 (the storage layer's whole security
 *     model rides on this).
 *   - Redaction masks tokens consistently — `sanitizeCredentials` is what
 *     the HTTP responses + logs go through.
 *   - Idempotent delete (Disconnect should succeed even if the file is
 *     gone).
 *   - Git remote helpers add/replace `origin` idempotently and don't leak
 *     the token in stderr/stdout we surface back to callers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyToGitRemote,
  deleteCredentials,
  emptyCredentials,
  githubAuthedRemoteUrl,
  legacyServerWideCredentialsPath,
  migrateLegacyServerWideCredentials,
  mirrorCredentialsPath,
  parseCredentials,
  previewToken,
  readCredentials,
  redactRemoteUrl,
  sanitizeCredentials,
  serializeCredentials,
  unsetGitRemote,
  writeCredentials,
  type MirrorCredentials,
} from "./mirror-credentials.ts";

const ORIG_HOME = process.env.HOME;
const ORIG_PARACHUTE_HOME = process.env.PARACHUTE_HOME;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withSandbox<T>(fn: (home: string) => T): T {
  const home = tmp("mirror-creds-");
  fs.mkdirSync(path.join(home, "vault"), { recursive: true });
  process.env.PARACHUTE_HOME = home;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_PARACHUTE_HOME === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIG_PARACHUTE_HOME;
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("emptyCredentials", () => {
  test("returns a fully-null shape — no active method, no provider blocks", () => {
    const e = emptyCredentials();
    expect(e.active_method).toBeNull();
    expect(e.github_oauth).toBeNull();
    expect(e.pat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Serialize / parse round-trip
// ---------------------------------------------------------------------------

describe("serialize + parse round-trip", () => {
  test("empty credentials round-trip cleanly", () => {
    const out = parseCredentials(serializeCredentials(emptyCredentials()));
    expect(out).toEqual(emptyCredentials());
  });

  test("github_oauth credentials round-trip", () => {
    const creds: MirrorCredentials = {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_abc123def456ghi789",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 12345,
      },
      pat: null,
    };
    const out = parseCredentials(serializeCredentials(creds));
    expect(out).toEqual(creds);
  });

  test("github_oauth with persisted owner/name round-trips through the bytes (vault#401)", () => {
    // owner/name are persisted at repo-select time so the selection survives a
    // cleared git origin + restart. They must serialize and parse back
    // byte-faithfully.
    const creds: MirrorCredentials = {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_abc123def456ghi789",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 12345,
        owner: "aaron",
        name: "backup-repo",
      },
      pat: null,
    };
    const out = parseCredentials(serializeCredentials(creds));
    expect(out).toEqual(creds);
    expect(out.github_oauth?.owner).toBe("aaron");
    expect(out.github_oauth?.name).toBe("backup-repo");
  });

  test("github_oauth WITHOUT owner/name stays byte-stable (back-compat)", () => {
    // Credentials written before a repo is picked (or before vault#401) carry
    // no owner/name. Serialize must NOT emit empty owner/name lines, and the
    // round-trip must leave the fields absent (not "").
    const creds: MirrorCredentials = {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_abc123def456ghi789",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 12345,
      },
      pat: null,
    };
    const serialized = serializeCredentials(creds);
    expect(serialized).not.toContain("owner:");
    expect(serialized).not.toContain("name:");
    const out = parseCredentials(serialized);
    expect(out).toEqual(creds);
    expect(out.github_oauth?.owner).toBeUndefined();
    expect(out.github_oauth?.name).toBeUndefined();
  });

  test("github_oauth with empty scope round-trips (GitHub App tokens)", () => {
    // Tokens from the shared Parachute GitHub App carry scope: "" (GitHub
    // Apps use fine-grained permissions, not scopes). The empty string must
    // survive serialize → parse and still pass the section-validity guard.
    const creds: MirrorCredentials = {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "ghu_abc123def456ghi789",
        scope: "",
        authorized_at: "2026-06-10T18:00:00.000Z",
        user_login: "aaron",
        user_id: 12345,
      },
      pat: null,
    };
    const out = parseCredentials(serializeCredentials(creds));
    expect(out).toEqual(creds);
    expect(out.github_oauth?.scope).toBe("");
  });

  test("pat credentials round-trip", () => {
    const creds: MirrorCredentials = {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_xyz9876543210abc",
        remote_url: "https://github.com/aaron/my-vault.git",
        label: "GitHub PAT",
      },
    };
    const out = parseCredentials(serializeCredentials(creds));
    expect(out).toEqual(creds);
  });

  test("both surfaces populated, github_oauth active", () => {
    // The operator can have BOTH a github_oauth and a pat configured
    // (e.g. linked GitHub, plus a fallback PAT). Only one is the
    // active_method at any time; the others stay populated so flipping
    // back is a single click rather than re-authenticating.
    const creds: MirrorCredentials = {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_test",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 1,
      },
      pat: {
        token: "ghp_test",
        remote_url: "https://github.com/aaron/backup.git",
        label: "Backup PAT",
      },
    };
    // Short tokens get the < 12 char branch for previewToken; pad these
    // up so the round-trip path is exercising the realistic shape.
    creds.github_oauth!.access_token = "gho_abc123def456ghi789";
    creds.pat!.token = "ghp_xyz9876543210abc";
    const out = parseCredentials(serializeCredentials(creds));
    expect(out).toEqual(creds);
  });

  test("special characters in label are quoted/escaped on round-trip", () => {
    const creds: MirrorCredentials = {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_test1234567890abcdef",
        remote_url: "https://gitlab.com/team/repo.git",
        label: 'PAT with "quotes" and: colons',
      },
    };
    const out = parseCredentials(serializeCredentials(creds));
    expect(out.pat!.label).toBe('PAT with "quotes" and: colons');
  });

  // Reviewer-flagged on vault#384 — without newline escaping a label
  // containing a literal `\n` produces multi-line YAML that breaks
  // the per-line section parser. PAT/OAuth tokens never carry newlines
  // but operator-supplied labels have no such guarantee.
  test("newlines + carriage returns in label round-trip via escapes", () => {
    const labelWithLineBreak = "Line one\nLine two";
    const labelWithCR = "First\rSecond";
    for (const label of [labelWithLineBreak, labelWithCR]) {
      const creds: MirrorCredentials = {
        active_method: "pat",
        github_oauth: null,
        pat: {
          token: "ghp_newline_test_token_12345",
          remote_url: "https://gitlab.com/team/repo.git",
          label,
        },
      };
      const serialized = serializeCredentials(creds);
      // Serialized YAML must NOT contain literal newlines inside the
      // label scalar (would break section parsing).
      const labelLine = serialized.split("\n").find((l) => l.includes("label:"))!;
      expect(labelLine).not.toContain("\n");
      // Round-trip recovers the original.
      const out = parseCredentials(serialized);
      expect(out.pat!.label).toBe(label);
    }
  });
});

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

describe("readCredentials / writeCredentials", () => {
  test("returns null when no file exists", () => {
    withSandbox(() => {
      expect(readCredentials("default")).toBeNull();
    });
  });

  test("write + read round-trip with real disk", () => {
    withSandbox(() => {
      const creds: MirrorCredentials = {
        active_method: "github_oauth",
        github_oauth: {
          access_token: "gho_abc123def456ghi789",
          scope: "repo",
          authorized_at: "2026-05-28T03:14:15.000Z",
          user_login: "aaron",
          user_id: 12345,
        },
        pat: null,
      };
      writeCredentials("default", creds);
      const read = readCredentials("default");
      expect(read).toEqual(creds);
    });
  });

  test("write enforces 0600 perms — the storage model rides on this", () => {
    withSandbox(() => {
      const creds: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "pat",
        pat: {
          token: "ghp_test1234567890abcdef",
          remote_url: "https://github.com/x/y.git",
          label: "test",
        },
      };
      writeCredentials("default", creds);
      const p = mirrorCredentialsPath("default");
      const stat = fs.statSync(p);
      const perms = stat.mode & 0o777;
      expect(perms).toBe(0o600);
    });
  });

  test("write creates the parent directory if missing", () => {
    const home = tmp("mirror-creds-mkdir-");
    process.env.PARACHUTE_HOME = home;
    process.env.HOME = home;
    try {
      // Note: don't pre-create the vault data subdir.
      const creds: MirrorCredentials = { ...emptyCredentials() };
      writeCredentials("default", creds);
      expect(
        fs.existsSync(
          path.join(home, "vault", "data", "default", ".mirror-credentials.yaml"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("two vaults' credentials are isolated — no bleed (vault#399)", () => {
    withSandbox(() => {
      const aCreds: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "pat",
        pat: {
          token: "ghp_vaultA1234567890abc",
          remote_url: "https://x-access-token:ghp_vaultA1234567890abc@github.com/aaron/vault-a.git",
          label: "vault A",
        },
      };
      const bCreds: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "pat",
        pat: {
          token: "ghp_vaultB9876543210xyz",
          remote_url: "https://x-access-token:ghp_vaultB9876543210xyz@github.com/aaron/vault-b.git",
          label: "vault B",
        },
      };
      writeCredentials("alpha", aCreds);
      writeCredentials("beta", bCreds);
      // Each vault reads back ITS OWN remote + token — never the other's.
      expect(readCredentials("alpha")).toEqual(aCreds);
      expect(readCredentials("beta")).toEqual(bCreds);
      expect(readCredentials("alpha")?.pat?.remote_url).toContain("vault-a.git");
      expect(readCredentials("beta")?.pat?.remote_url).toContain("vault-b.git");
      expect(readCredentials("alpha")?.pat?.token).not.toBe(readCredentials("beta")?.pat?.token);
      // Files live in separate per-vault dirs.
      expect(mirrorCredentialsPath("alpha")).not.toBe(mirrorCredentialsPath("beta"));
    });
  });

  test("write is atomic — partial file not left on failure path", () => {
    withSandbox(() => {
      const creds: MirrorCredentials = {
        active_method: "github_oauth",
        github_oauth: {
          access_token: "gho_initial1234567890",
          scope: "repo",
          authorized_at: "2026-05-28T03:14:15.000Z",
          user_login: "aaron",
          user_id: 1,
        },
        pat: null,
      };
      writeCredentials("default", creds);
      // Subsequent write replaces atomically (.tmp rename onto final).
      const updated: MirrorCredentials = {
        ...creds,
        github_oauth: { ...creds.github_oauth!, access_token: "gho_updated123456789" },
      };
      writeCredentials("default", updated);
      const read = readCredentials("default");
      expect(read?.github_oauth?.access_token).toBe("gho_updated123456789");
      // No leftover .tmp file.
      expect(fs.existsSync(`${mirrorCredentialsPath("default")}.tmp`)).toBe(false);
    });
  });
});

describe("deleteCredentials", () => {
  test("idempotent — missing file is a no-op (doesn't throw)", () => {
    withSandbox(() => {
      expect(() => deleteCredentials("default")).not.toThrow();
    });
  });

  test("removes the file when present", () => {
    withSandbox(() => {
      writeCredentials("default", { ...emptyCredentials(), active_method: null });
      expect(fs.existsSync(mirrorCredentialsPath("default"))).toBe(true);
      deleteCredentials("default");
      expect(fs.existsSync(mirrorCredentialsPath("default"))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Migration — legacy server-wide → per-vault (vault#399)
// ---------------------------------------------------------------------------

describe("migrateLegacyServerWideCredentials", () => {
  function writeLegacyFile(_home: string, creds: MirrorCredentials): string {
    const legacyPath = legacyServerWideCredentialsPath();
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, serializeCredentials(creds), { mode: 0o600 });
    return legacyPath;
  }

  const sampleCreds: MirrorCredentials = {
    ...emptyCredentials(),
    active_method: "pat",
    pat: {
      token: "ghp_legacy1234567890abc",
      remote_url: "https://x-access-token:ghp_legacy1234567890abc@github.com/aaron/first-vault.git",
      label: "legacy",
    },
  };

  test("no legacy file → no-op", () => {
    withSandbox(() => {
      const r = migrateLegacyServerWideCredentials("default");
      expect(r.migrated).toBe(false);
      expect((r as { reason: string }).reason).toBe("no_legacy_file");
    });
  });

  test("legacy file → attributed to the FIRST vault, others stay empty", () => {
    const home = tmp("mirror-migrate-");
    process.env.PARACHUTE_HOME = home;
    process.env.HOME = home;
    try {
      const legacyPath = writeLegacyFile(home, sampleCreds);
      const r = migrateLegacyServerWideCredentials("first");
      expect(r.migrated).toBe(true);
      // First vault now owns the legacy creds.
      expect(readCredentials("first")).toEqual(sampleCreds);
      // A second vault that never had its own file starts EMPTY — the bug
      // would have made it read the same remote. It must not.
      expect(readCredentials("second")).toBeNull();
      // Legacy file preserved as .bak — nothing silently lost.
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(`${legacyPath}.bak`)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("idempotent — second run is a no-op once target has creds", () => {
    const home = tmp("mirror-migrate-idem-");
    process.env.PARACHUTE_HOME = home;
    process.env.HOME = home;
    try {
      writeLegacyFile(home, sampleCreds);
      expect(migrateLegacyServerWideCredentials("first").migrated).toBe(true);
      // Run again: no legacy file remains, so no-op.
      const r2 = migrateLegacyServerWideCredentials("first");
      expect(r2.migrated).toBe(false);
      // First vault's creds unchanged.
      expect(readCredentials("first")).toEqual(sampleCreds);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not clobber an existing per-vault file", () => {
    const home = tmp("mirror-migrate-noclobber-");
    process.env.PARACHUTE_HOME = home;
    process.env.HOME = home;
    try {
      writeLegacyFile(home, sampleCreds);
      // Target vault already has its own (different) creds.
      const existing: MirrorCredentials = {
        ...emptyCredentials(),
        active_method: "pat",
        pat: {
          token: "ghp_already1234567890ab",
          remote_url: "https://x-access-token:ghp_already1234567890ab@github.com/aaron/already.git",
          label: "already",
        },
      };
      writeCredentials("first", existing);
      const r = migrateLegacyServerWideCredentials("first");
      expect(r.migrated).toBe(false);
      expect((r as { reason: string }).reason).toBe("target_already_has_creds");
      // Existing per-vault creds preserved, NOT overwritten by legacy.
      expect(readCredentials("first")).toEqual(existing);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("no target vault → leaves legacy file in place for a later boot", () => {
    const home = tmp("mirror-migrate-notarget-");
    process.env.PARACHUTE_HOME = home;
    process.env.HOME = home;
    try {
      const legacyPath = writeLegacyFile(home, sampleCreds);
      const r = migrateLegacyServerWideCredentials(null);
      expect(r.migrated).toBe(false);
      expect((r as { reason: string }).reason).toBe("no_target_vault");
      // Legacy file untouched — a future boot (after a vault exists) migrates.
      expect(fs.existsSync(legacyPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("previewToken", () => {
  test("masks middle of typical OAuth tokens", () => {
    expect(previewToken("gho_abcdefghijklmnop")).toBe("gho_…mnop");
  });

  test("fully masks tokens shorter than 12 chars (defense in depth)", () => {
    expect(previewToken("short")).toBe("***");
    expect(previewToken("")).toBe("***");
  });

  test("preserves enough to verify but not enough to use", () => {
    const t = "ghp_1234567890abcdefghij";
    const p = previewToken(t);
    // Has the prefix + the trailing chars.
    expect(p.startsWith("ghp_")).toBe(true);
    expect(p.endsWith("ghij")).toBe(true);
    // Doesn't contain the middle.
    expect(p).not.toContain("567890abc");
  });
});

describe("redactRemoteUrl", () => {
  test("strips userinfo from HTTPS URLs", () => {
    expect(
      redactRemoteUrl("https://x-access-token:gho_secret@github.com/a/b.git"),
    ).toContain("***@github.com/a/b.git");
    expect(
      redactRemoteUrl("https://x-access-token:gho_secret@github.com/a/b.git"),
    ).not.toContain("gho_secret");
  });

  test("leaves URLs without userinfo unchanged", () => {
    expect(redactRemoteUrl("https://github.com/a/b.git")).toBe(
      "https://github.com/a/b.git",
    );
  });

  test("non-URL string fully masks (defense in depth)", () => {
    expect(redactRemoteUrl("not a url")).toBe("***");
  });
});

describe("sanitizeCredentials", () => {
  test("null input returns the fully-null public shape", () => {
    expect(sanitizeCredentials(null)).toEqual({
      active_method: null,
      github_oauth: null,
      pat: null,
    });
  });

  test("github_oauth credential exposes user info but masks token", () => {
    const creds: MirrorCredentials = {
      active_method: "github_oauth",
      github_oauth: {
        access_token: "gho_secret1234567890",
        scope: "repo",
        authorized_at: "2026-05-28T03:14:15.000Z",
        user_login: "aaron",
        user_id: 12345,
      },
      pat: null,
    };
    const safe = sanitizeCredentials(creds);
    expect(safe.github_oauth?.user_login).toBe("aaron");
    expect(safe.github_oauth?.user_id).toBe(12345);
    expect(safe.github_oauth?.scope).toBe("repo");
    expect(safe.github_oauth?.token_preview).toBe("gho_…7890");
    // No raw token leaks.
    expect(JSON.stringify(safe)).not.toContain("gho_secret");
  });

  test("pat credential masks both token AND any token embedded in remote_url", () => {
    const creds: MirrorCredentials = {
      active_method: "pat",
      github_oauth: null,
      pat: {
        token: "ghp_secret1234567890",
        remote_url:
          "https://x-access-token:ghp_secret1234567890@github.com/owner/repo.git",
        label: "GitHub PAT",
      },
    };
    const safe = sanitizeCredentials(creds);
    expect(safe.pat?.label).toBe("GitHub PAT");
    expect(safe.pat?.token_preview).toBe("ghp_…7890");
    // Embedded token in URL must be redacted.
    expect(safe.pat?.remote_url).not.toContain("ghp_secret");
    expect(JSON.stringify(safe)).not.toContain("ghp_secret");
  });
});

// ---------------------------------------------------------------------------
// Git remote helpers (real git, real tempdir)
// ---------------------------------------------------------------------------

describe("githubAuthedRemoteUrl", () => {
  test("builds the x-access-token https URL", () => {
    expect(
      githubAuthedRemoteUrl("gho_test", "aaron", "my-vault"),
    ).toBe("https://x-access-token:gho_test@github.com/aaron/my-vault.git");
  });
});

describe("applyToGitRemote + unsetGitRemote", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmp("mirror-creds-remote-");
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.email", "t@p.computer"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.name", "T P"], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("adds origin when no remote configured", async () => {
    const url = "https://x-access-token:gho_test1234567890@github.com/a/b.git";
    const res = await applyToGitRemote(dir, url);
    expect(res.ok).toBe(true);
    const probe = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir });
    expect(probe.exitCode).toBe(0);
    expect(new TextDecoder().decode(probe.stdout).trim()).toBe(url);
  });

  test("replaces origin when already configured (idempotent rotation)", async () => {
    Bun.spawnSync(["git", "remote", "add", "origin", "https://old.example/x.git"], { cwd: dir });
    const newUrl = "https://x-access-token:gho_new1234567890@github.com/c/d.git";
    const res = await applyToGitRemote(dir, newUrl);
    expect(res.ok).toBe(true);
    const probe = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir });
    expect(new TextDecoder().decode(probe.stdout).trim()).toBe(newUrl);
  });

  test("unsetGitRemote removes origin", async () => {
    Bun.spawnSync(["git", "remote", "add", "origin", "https://x.example/a.git"], { cwd: dir });
    const res = await unsetGitRemote(dir);
    expect(res.ok).toBe(true);
    const probe = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir });
    expect(probe.exitCode).not.toBe(0); // no remote
  });

  test("unsetGitRemote is idempotent — no remote = ok", async () => {
    const res = await unsetGitRemote(dir);
    expect(res.ok).toBe(true);
  });
});
