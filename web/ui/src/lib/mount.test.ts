/**
 * Mount detection round-trips. The runtime basename is what makes the same
 * compiled SPA bundle work at any `/vault/<name>/admin/` mount post-vault#252
 * — a regression here means React Router can't strip the basename and the
 * SPA renders a blank 404 shell.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBasename, getMountedVaultName } from "./mount.ts";

describe("mount detection", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  describe("getMountedVaultName", () => {
    it("extracts the vault name from a per-vault mount", () => {
      window.history.replaceState(null, "", "/vault/boulder/admin/");
      expect(getMountedVaultName()).toBe("boulder");
    });

    it("extracts the vault name from a deep client-routed path", () => {
      window.history.replaceState(null, "", "/vault/boulder/admin/vault/boulder/tokens");
      expect(getMountedVaultName()).toBe("boulder");
    });

    it("decodes percent-encoded vault names", () => {
      window.history.replaceState(null, "", "/vault/my%20vault/admin/");
      expect(getMountedVaultName()).toBe("my vault");
    });

    it("returns null on origin-rooted /admin (legacy / dev)", () => {
      window.history.replaceState(null, "", "/admin/");
      expect(getMountedVaultName()).toBeNull();
    });

    it("returns null on stand-alone root", () => {
      window.history.replaceState(null, "", "/");
      expect(getMountedVaultName()).toBeNull();
    });

    it("returns null on the per-vault metadata path (no admin segment)", () => {
      // The plain per-vault mount serves JSON metadata, not the SPA — only
      // /admin under it should activate the runtime mount.
      window.history.replaceState(null, "", "/vault/boulder/");
      expect(getMountedVaultName()).toBeNull();
    });

    it("does not match adjacent paths under the vault", () => {
      window.history.replaceState(null, "", "/vault/boulder/api/notes");
      expect(getMountedVaultName()).toBeNull();
      window.history.replaceState(null, "", "/vault/boulder/admin-foo");
      expect(getMountedVaultName()).toBeNull();
    });
  });

  describe("getBasename", () => {
    it("returns /vault/<name>/admin under a per-vault mount", () => {
      window.history.replaceState(null, "", "/vault/boulder/admin/");
      expect(getBasename()).toBe("/vault/boulder/admin");
    });

    it("preserves percent-encoding in the vault name", () => {
      // Decoding the name would break basename matching against
      // window.location.pathname (which is encoded).
      window.history.replaceState(null, "", "/vault/my%20vault/admin/");
      expect(getBasename()).toBe("/vault/my%20vault/admin");
    });

    it("falls back to /admin for the legacy origin-rooted mount", () => {
      window.history.replaceState(null, "", "/admin/tokens");
      expect(getBasename()).toBe("/admin");
    });

    it("returns empty string at the stand-alone root", () => {
      window.history.replaceState(null, "", "/");
      expect(getBasename()).toBe("");
    });
  });
});
