import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the parsing by writing a config file and reading it back
// using the real readGlobalConfig/writeGlobalConfig functions.
// To avoid touching the real config, we override PARACHUTE_HOME.

const testDir = join(tmpdir(), `vault-trigger-test-${Date.now()}`);

// Must set env before importing config module
process.env.PARACHUTE_HOME = testDir;

// Dynamic import after env is set
const { readGlobalConfig, writeGlobalConfig } = await import("./config.ts");

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("trigger config round-trip", () => {
  it("writes and reads triggers", () => {
    mkdirSync(testDir, { recursive: true });
    writeGlobalConfig({
      port: 1940,
      triggers: [
        {
          name: "tts-reader",
          events: ["created", "updated"],
          when: {
            tags: ["reader"],
            has_content: true,
            missing_metadata: ["audio_rendered_at", "audio_pending_at"],
          },
          action: {
            webhook: "http://localhost:8080/tts",
            timeout: 30000,
          },
        },
        {
          name: "transcribe-capture",
          when: {
            tags: ["capture"],
            has_content: false,
          },
          action: {
            webhook: "http://localhost:8080/transcribe",
          },
        },
      ],
    });

    const config = readGlobalConfig();
    expect(config.triggers).toBeDefined();
    expect(config.triggers!.length).toBe(2);

    const tts = config.triggers![0];
    expect(tts.name).toBe("tts-reader");
    expect(tts.events).toEqual(["created", "updated"]);
    expect(tts.when.tags).toEqual(["reader"]);
    expect(tts.when.has_content).toBe(true);
    expect(tts.when.missing_metadata).toEqual(["audio_rendered_at", "audio_pending_at"]);
    expect(tts.action.webhook).toBe("http://localhost:8080/tts");
    expect(tts.action.timeout).toBe(30000);

    const transcribe = config.triggers![1];
    expect(transcribe.name).toBe("transcribe-capture");
    expect(transcribe.when.tags).toEqual(["capture"]);
    expect(transcribe.when.has_content).toBe(false);
    expect(transcribe.action.webhook).toBe("http://localhost:8080/transcribe");
    expect(transcribe.action.timeout).toBeUndefined();
  });

  it("handles config with no triggers", () => {
    mkdirSync(testDir, { recursive: true });
    writeGlobalConfig({ port: 1940 });
    const config = readGlobalConfig();
    expect(config.triggers).toBeUndefined();
  });

  it("roundtrips triggers with action.include_context", () => {
    mkdirSync(testDir, { recursive: true });
    writeGlobalConfig({
      port: 1940,
      triggers: [
        {
          name: "transcribe-with-people",
          when: { tags: ["capture"], has_content: false },
          action: {
            webhook: "http://localhost:1943/v1/audio/transcriptions",
            send: "attachment",
            include_context: [
              { tag: "person", include_metadata: ["summary", "aliases"] },
              { tag: "project", exclude_tag: "archived", include_metadata: ["summary"] },
            ],
          },
        },
      ],
    });

    const config = readGlobalConfig();
    const ctx = config.triggers![0].action.include_context!;
    expect(ctx.length).toBe(2);
    expect(ctx[0]).toEqual({ tag: "person", include_metadata: ["summary", "aliases"] });
    expect(ctx[1]).toEqual({
      tag: "project",
      exclude_tag: "archived",
      include_metadata: ["summary"],
    });
  });

  it("skips include_context serialization when empty", () => {
    mkdirSync(testDir, { recursive: true });
    writeGlobalConfig({
      port: 1940,
      triggers: [
        {
          name: "plain",
          when: { tags: ["t"] },
          action: { webhook: "http://x/y" },
        },
      ],
    });
    const raw = readFileSync(join(testDir, "vault", "config.yaml"), "utf8");
    expect(raw).not.toContain("include_context");
    const config = readGlobalConfig();
    expect(config.triggers![0].action.include_context).toBeUndefined();
  });
});
