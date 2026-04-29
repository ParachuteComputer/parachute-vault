import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Resolve per-call so `PARACHUTE_HOME` set at runtime (Docker, tests) is
// honored, matching the pattern in `config.ts`.
function servicesManifestPath(): string {
  const root = process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
  return join(root, "services.json");
}

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
}

export interface ServicesManifest {
  services: ServiceEntry[];
}

export class ServicesManifestError extends Error {
  override name = "ServicesManifestError";
}

function validateEntry(raw: unknown, where: string): ServiceEntry {
  if (!raw || typeof raw !== "object") {
    throw new ServicesManifestError(`${where}: expected object, got ${typeof raw}`);
  }
  const e = raw as Record<string, unknown>;
  const { name, port, paths, health, version } = e;
  if (typeof name !== "string" || name.length === 0) {
    throw new ServicesManifestError(`${where}: "name" must be a non-empty string`);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ServicesManifestError(`${where}: "port" must be an integer 1..65535`);
  }
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
    throw new ServicesManifestError(`${where}: "paths" must be an array of strings`);
  }
  if (typeof health !== "string" || !health.startsWith("/")) {
    throw new ServicesManifestError(`${where}: "health" must be a path starting with "/"`);
  }
  if (typeof version !== "string") {
    throw new ServicesManifestError(`${where}: "version" must be a string`);
  }
  // Spread the raw object first so hub-stamped fields (e.g. `installDir` from
  // parachute-hub#84) ride through the read. The strict fields below pin the
  // typed shape we promise callers; anything extra survives untouched.
  return { ...e, name, port, paths: paths as string[], health, version } as ServiceEntry;
}

function validateManifest(raw: unknown, where: string): ServicesManifest {
  if (!raw || typeof raw !== "object") {
    throw new ServicesManifestError(`${where}: root must be an object`);
  }
  const services = (raw as Record<string, unknown>).services;
  if (!Array.isArray(services)) {
    throw new ServicesManifestError(`${where}: "services" must be an array`);
  }
  return {
    services: services.map((s, i) => validateEntry(s, `${where} services[${i}]`)),
  };
}

export function readManifest(path: string = servicesManifestPath()): ServicesManifest {
  if (!existsSync(path)) return { services: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ServicesManifestError(
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateManifest(raw, path);
}

function writeManifest(manifest: ServicesManifest, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}

export function upsertService(
  entry: ServiceEntry,
  path: string = servicesManifestPath(),
): ServicesManifest {
  validateEntry(entry, "entry");
  const current = readManifest(path);
  const idx = current.services.findIndex((s) => s.name === entry.name);
  if (idx >= 0) {
    // Merge rather than replace so fields the hub stamps onto the row
    // (`installDir` from parachute-hub#84, etc.) survive a self-registration
    // pass. Vault still wins for the fields it owns — port, paths, version,
    // health — because `entry` spreads last.
    current.services[idx] = { ...current.services[idx], ...entry };
  } else {
    current.services.push(entry);
  }
  writeManifest(current, path);
  return current;
}
