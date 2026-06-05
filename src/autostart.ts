/**
 * Decide whether `parachute-vault init` should register a boot/restart daemon
 * (launchd on macOS, systemd on Linux).
 *
 * Pure: extracted so the flag × persisted-config × hub-presence matrix can be
 * unit-tested without spawning the CLI or touching launchd/systemd. The caller
 * passes in the resolved `hubPresent` signal (from `detectHubPresence`) so this
 * function stays side-effect-free.
 *
 * Why hub-presence flips the default (ParachuteComputer/parachute-hub#580):
 * under hub-as-supervisor the hub owns the vault lifecycle — it spawns vault as
 * a supervised child. If init *also* registers a launchd/systemd unit with
 * `KeepAlive`/`RunAtLoad`, two lifecycles race for :1940: the supervisor's
 * child and the platform manager's respawn. `parachute stop` kills the
 * supervised one, launchd resurrects the other (EADDRINUSE crash-loop, pidfile
 * records the loser, the rogue holds the port with no injected
 * PARACHUTE_HUB_ORIGIN → iss mismatch). Defaulting autostart OFF when a hub is
 * present makes the standalone daemon an explicit opt-in.
 *
 * Precedence (first match wins):
 *   1. `--no-autostart` on this run            → off  (persisted; safer-default
 *                                                 precedence beats --autostart)
 *   2. `--autostart` on this run               → on   (persisted; operator
 *                                                 override — caller warns if a
 *                                                 supervised hub was detected)
 *   3. Existing `config.autostart` (boolean)   → that value (honor prior choice)
 *   4. Hub present, no flag, no persisted value → off  (the hub supervisor owns
 *                                                 the lifecycle — #580)
 *   5. Default                                 → on   (standalone deploys
 *                                                 genuinely need a daemon)
 *
 * `persist` is true only when the choice came from an explicit flag (cases 1+2)
 * — matching the prior behavior where a flagless re-run never rewrote the
 * persisted value. The hub-present default (case 4) is intentionally NOT
 * persisted: it's a per-run inference, so a later standalone re-run (no hub)
 * falls back to the register default rather than being stuck off.
 *
 * `overrodeHub` is true only for case 2 when a hub was detected — the signal the
 * caller uses to log the "supervised hub detected, registering anyway" warning.
 */
export interface AutostartDecisionInput {
  /** `--autostart` present on this invocation. */
  flagOn: boolean;
  /** `--no-autostart` present on this invocation. */
  flagOff: boolean;
  /** Persisted `config.autostart` from a prior run, if a boolean. */
  persisted?: boolean | undefined;
  /** Whether a hub supervisor was detected (from `detectHubPresence`). */
  hubPresent: boolean;
}

export interface AutostartDecision {
  /** Final resolved value. */
  enabled: boolean;
  /** Whether the caller should write `config.autostart` to disk. */
  persist: boolean;
  /** True when `--autostart` forced registration despite a detected hub. */
  overrodeHub: boolean;
  /** Which precedence rule decided the outcome (for testing + copy). */
  reason: "flag-off" | "flag-on" | "persisted" | "hub-default-off" | "default-on";
}

export function decideAutostart(input: AutostartDecisionInput): AutostartDecision {
  const { flagOn, flagOff, persisted, hubPresent } = input;

  if (flagOff) {
    return { enabled: false, persist: true, overrodeHub: false, reason: "flag-off" };
  }
  if (flagOn) {
    return {
      enabled: true,
      persist: true,
      overrodeHub: hubPresent,
      reason: "flag-on",
    };
  }
  if (typeof persisted === "boolean") {
    return { enabled: persisted, persist: false, overrodeHub: false, reason: "persisted" };
  }
  if (hubPresent) {
    return { enabled: false, persist: false, overrodeHub: false, reason: "hub-default-off" };
  }
  return { enabled: true, persist: false, overrodeHub: false, reason: "default-on" };
}
