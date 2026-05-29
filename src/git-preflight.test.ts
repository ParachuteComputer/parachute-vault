/**
 * Tests for the shared git-availability preflight (vault#415).
 *
 * Found live: importing a repo on a git-less Amazon Linux EC2 box failed
 * with a raw `Executable not found in $PATH: "git"` 500. The preflight gives
 * every git entry point a fast, friendly, actionable failure instead.
 */

import { describe, test, expect } from "bun:test";
import {
  GitNotInstalledError,
  ensureGitAvailable,
  isGitNotFoundSpawnError,
} from "./git-preflight.ts";

describe("ensureGitAvailable", () => {
  test("throws GitNotInstalledError when which returns null", () => {
    expect(() => ensureGitAvailable(() => null)).toThrow(GitNotInstalledError);
  });

  test("does not throw when which resolves git", () => {
    expect(() => ensureGitAvailable(() => "/usr/bin/git")).not.toThrow();
  });

  test("defaults to Bun.which (git is present in this test env)", () => {
    // The test host has git; the default-arg path resolves it cleanly.
    expect(() => ensureGitAvailable()).not.toThrow();
  });
});

describe("GitNotInstalledError message", () => {
  test("is OS-agnostic-but-helpful — names dnf, apt-get, and brew", () => {
    const msg = new GitNotInstalledError().message;
    expect(msg).toContain("git is required for this operation");
    expect(msg).toContain("sudo dnf install git");
    expect(msg).toContain("sudo apt-get install -y git");
    expect(msg).toContain("brew install git");
  });

  test("carries the GitNotInstalledError name (instanceof + name both work)", () => {
    const err = new GitNotInstalledError();
    expect(err).toBeInstanceOf(GitNotInstalledError);
    expect(err.name).toBe("GitNotInstalledError");
  });
});

describe("isGitNotFoundSpawnError", () => {
  test("matches Bun's executable-not-found message for git", () => {
    expect(
      isGitNotFoundSpawnError(
        new Error('Executable not found in $PATH: "git"'),
      ),
    ).toBe(true);
  });

  test("matches an ENOENT spawn error mentioning git", () => {
    const err = new Error("spawn git ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    expect(isGitNotFoundSpawnError(err)).toBe(true);
  });

  test("does not match an unrelated error", () => {
    expect(isGitNotFoundSpawnError(new Error("network unreachable"))).toBe(false);
  });

  test("does not match a non-Error value", () => {
    expect(isGitNotFoundSpawnError("git missing")).toBe(false);
    expect(isGitNotFoundSpawnError(null)).toBe(false);
  });
});
