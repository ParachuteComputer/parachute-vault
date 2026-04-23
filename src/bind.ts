/**
 * Resolve the hostname the HTTP server binds to.
 *
 * Default is `127.0.0.1` — loopback-only at the socket level. The auth gate
 * protects vault data regardless, but listening only on loopback is a
 * defense-in-depth default that matches the threat model in
 * `docs/auth-model.md` §4. Supported remote-access paths (Tailscale Serve,
 * Cloudflare Tunnel) proxy from loopback, so the default does not break any
 * documented exposure path.
 *
 * Escape hatch: `VAULT_BIND`. Set to `0.0.0.0` for Docker bridge networking
 * or an intentional LAN setup; set to a specific interface IP for
 * multi-homed hosts. Empty/whitespace values are treated as unset.
 */
export function resolveBindHostname(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VAULT_BIND?.trim();
  if (override) return override;
  return "127.0.0.1";
}
