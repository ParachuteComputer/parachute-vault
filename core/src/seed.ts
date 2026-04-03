import { Database } from "bun:sqlite";

/**
 * Seed initial database state. Currently a no-op — vaults start blank.
 * Clients (e.g., parachute-daily) create the tags they need on connect.
 */
export function seedBuiltins(db: Database): void {
  // Intentionally empty. Tags are created on use.
}
