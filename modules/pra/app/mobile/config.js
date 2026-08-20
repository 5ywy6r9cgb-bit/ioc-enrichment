'use strict';
/**
 * config.js — the one file to edit per deployment.
 *
 * local_service.js binds to 127.0.0.1 ONLY, on purpose (see its own header
 * comment) — an investigative case store has no business listening on a
 * network interface. That means "reach it from a phone" is a NETWORK
 * problem, not a code problem, and the honest fix is a private tunnel that
 * makes the phone look like it's on localhost too:
 *
 *   Recommended: Tailscale (or WireGuard) between the Mac and the phone,
 *   then run a tunnel/reverse-proxy bound to the Tailscale interface that
 *   forwards to 127.0.0.1:4317 — the service itself never changes its bind.
 *   `tailscale serve` does exactly this and also supplies TLS, which Web
 *   Push requires for a non-localhost origin.
 *
 * Until SENTINEL_API_BASE below points at a real reachable address, this
 * shell will correctly show "not reachable" — that is the honest state,
 * not a bug.
 */
window.SENTINEL_CONFIG = {
  SENTINEL_API_BASE: 'http://127.0.0.1:4317',
};
