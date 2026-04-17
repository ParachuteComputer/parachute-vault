import { describe, test, expect } from "bun:test";
import { generateUnit } from "./systemd.ts";
import { WRAPPER_PATH } from "./daemon.ts";

describe("generateUnit", () => {
  test("invokes the shared wrapper rather than hardcoding server.ts", () => {
    const unit = generateUnit();
    // Same incident on Linux: the old unit hardcoded the absolute path to
    // server.ts inside ExecStart. Now ExecStart points at the wrapper, and
    // the wrapper resolves the path from a pointer file at boot.
    expect(unit).toContain(`ExecStart=/bin/bash ${WRAPPER_PATH}`);
    expect(unit).not.toMatch(/server\.ts/);
    expect(unit).toContain("Restart=on-failure");
  });
});
