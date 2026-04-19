import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ServiceEntry,
  ServicesManifestError,
  readManifest,
  upsertService,
} from "./services-manifest.ts";

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pvault-manifest-"));
  const path = join(dir, "services.json");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const vault: ServiceEntry = {
  name: "parachute-vault",
  port: 1940,
  paths: ["/"],
  health: "/health",
  version: "0.2.4",
};

const notes: ServiceEntry = {
  name: "parachute-notes",
  port: 5173,
  paths: ["/notes"],
  health: "/notes/health",
  version: "0.0.1",
};

describe("services-manifest", () => {
  test("readManifest returns empty when file missing", () => {
    const { path, cleanup } = tempPath();
    try {
      expect(readManifest(path)).toEqual({ services: [] });
    } finally {
      cleanup();
    }
  });

  test("upsertService creates the file if missing", () => {
    const { path, cleanup } = tempPath();
    try {
      const m = upsertService(vault, path);
      expect(m.services).toEqual([vault]);
      expect(readManifest(path)).toEqual({ services: [vault] });
    } finally {
      cleanup();
    }
  });

  test("upsertService updates by name and never duplicates", () => {
    const { path, cleanup } = tempPath();
    try {
      upsertService(vault, path);
      const updated = { ...vault, version: "0.3.0", port: 1941 };
      upsertService(updated, path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]).toEqual(updated);
    } finally {
      cleanup();
    }
  });

  test("upsertService preserves entries written by other services", () => {
    const { path, cleanup } = tempPath();
    try {
      writeFileSync(path, `${JSON.stringify({ services: [notes] }, null, 2)}\n`);
      upsertService(vault, path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(2);
      expect(m.services.find((s) => s.name === "parachute-notes")).toEqual(notes);
      expect(m.services.find((s) => s.name === "parachute-vault")).toEqual(vault);
    } finally {
      cleanup();
    }
  });

  test("upsertService writes pretty-printed JSON with trailing newline", () => {
    const { path, cleanup } = tempPath();
    try {
      upsertService(vault, path);
      const raw = readFileSync(path, "utf8");
      expect(raw).toBe(`${JSON.stringify({ services: [vault] }, null, 2)}\n`);
    } finally {
      cleanup();
    }
  });

  test("readManifest throws ServicesManifestError on malformed JSON", () => {
    const { path, cleanup } = tempPath();
    try {
      writeFileSync(path, "{ not json");
      expect(() => readManifest(path)).toThrow(ServicesManifestError);
    } finally {
      cleanup();
    }
  });

  test("readManifest throws ServicesManifestError on schema violation", () => {
    const { path, cleanup } = tempPath();
    try {
      writeFileSync(path, JSON.stringify({ services: [{ name: "x" }] }));
      expect(() => readManifest(path)).toThrow(ServicesManifestError);
    } finally {
      cleanup();
    }
  });

  test("upsertService rejects invalid entry without touching the file", () => {
    const { path, cleanup } = tempPath();
    try {
      writeFileSync(path, `${JSON.stringify({ services: [notes] }, null, 2)}\n`);
      const bad = { ...vault, port: -1 };
      expect(() => upsertService(bad as ServiceEntry, path)).toThrow(ServicesManifestError);
      expect(readManifest(path)).toEqual({ services: [notes] });
    } finally {
      cleanup();
    }
  });

  test("default path honors PARACHUTE_HOME set at runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "pvault-home-"));
    const prior = process.env.PARACHUTE_HOME;
    process.env.PARACHUTE_HOME = dir;
    try {
      upsertService(vault);
      expect(readManifest()).toEqual({ services: [vault] });
      expect(readManifest(join(dir, "services.json"))).toEqual({ services: [vault] });
    } finally {
      if (prior === undefined) delete process.env.PARACHUTE_HOME;
      else process.env.PARACHUTE_HOME = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
