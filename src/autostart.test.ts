import { describe, test, expect } from "bun:test";
import { decideAutostart } from "./autostart.ts";

/**
 * Pure matrix for the autostart decision (ParachuteComputer/parachute-hub#580
 * item 2). No launchd/systemd is touched — `decideAutostart` is side-effect
 * free; the CLI consumes its result to register or skip.
 */
describe("decideAutostart", () => {
  test("hub present, no flag, no persisted → default OFF (#580)", () => {
    const d = decideAutostart({ flagOn: false, flagOff: false, persisted: undefined, hubPresent: true });
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("hub-default-off");
    // Per-run inference — not persisted, so a later standalone re-run registers.
    expect(d.persist).toBe(false);
    expect(d.overrodeHub).toBe(false);
  });

  test("hub absent, no flag, no persisted → default ON (standalone)", () => {
    const d = decideAutostart({ flagOn: false, flagOff: false, persisted: undefined, hubPresent: false });
    expect(d.enabled).toBe(true);
    expect(d.reason).toBe("default-on");
    expect(d.persist).toBe(false);
  });

  test("explicit --autostart forces ON even under a hub (operator override + warn flag)", () => {
    const d = decideAutostart({ flagOn: true, flagOff: false, persisted: undefined, hubPresent: true });
    expect(d.enabled).toBe(true);
    expect(d.reason).toBe("flag-on");
    expect(d.persist).toBe(true);
    expect(d.overrodeHub).toBe(true);
  });

  test("explicit --autostart with no hub does not set overrodeHub", () => {
    const d = decideAutostart({ flagOn: true, flagOff: false, persisted: undefined, hubPresent: false });
    expect(d.enabled).toBe(true);
    expect(d.overrodeHub).toBe(false);
    expect(d.persist).toBe(true);
  });

  test("explicit --no-autostart forces OFF and persists (even under a hub)", () => {
    const d = decideAutostart({ flagOn: false, flagOff: true, persisted: undefined, hubPresent: true });
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("flag-off");
    expect(d.persist).toBe(true);
    expect(d.overrodeHub).toBe(false);
  });

  test("--no-autostart wins over --autostart on the same line (safer default)", () => {
    const d = decideAutostart({ flagOn: true, flagOff: true, persisted: undefined, hubPresent: false });
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("flag-off");
  });

  test("persisted=false honored over hub-present default", () => {
    const d = decideAutostart({ flagOn: false, flagOff: false, persisted: false, hubPresent: true });
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("persisted");
    expect(d.persist).toBe(false);
  });

  test("persisted=true honored even when a hub is present (prior explicit choice)", () => {
    const d = decideAutostart({ flagOn: false, flagOff: false, persisted: true, hubPresent: true });
    expect(d.enabled).toBe(true);
    expect(d.reason).toBe("persisted");
    expect(d.persist).toBe(false);
  });

  test("flag beats persisted: --no-autostart over persisted=true", () => {
    const d = decideAutostart({ flagOn: false, flagOff: true, persisted: true, hubPresent: false });
    expect(d.enabled).toBe(false);
    expect(d.reason).toBe("flag-off");
    expect(d.persist).toBe(true);
  });
});
