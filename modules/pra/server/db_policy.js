'use strict';
/**
 * server/db_policy.js — the boundary that keeps this system local.
 *
 * Sentinel OS holds unpublished investigative material. A reachable copy of an
 * investigative case store is a subpoena target and a breach target at the same
 * time, and you get nothing in return for the exposure. So the database lives on
 * loopback, and this file is the thing that refuses to let that quietly change.
 *
 * It is deliberately dumb and deliberately loud. There is no "allow remote for
 * now" flag, because a flag that exists is a flag that gets set at 1 a.m.
 */

/** Hosts that are genuinely this machine. Anything else is rejected. */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
]);

class PolicyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

/** A Unix-domain socket path is local by definition. */
function isSocketPath(host) {
  return typeof host === 'string' && (host.startsWith('/') || host.startsWith('.'));
}

/**
 * True when `host` is this machine. 127.0.0.0/8 is accepted in full because
 * some setups use 127.0.0.2 and friends; the whole block is loopback.
 */
function isLocalHost(host) {
  if (!host) return false;
  const h = String(host).trim().toLowerCase();
  if (isSocketPath(h)) return true;
  if (LOCAL_HOSTS.has(h)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Validate a connection config before a socket is ever opened.
 * Returns the config unchanged, or throws PolicyViolation.
 */
function assertLocal(config) {
  const host = config && (config.host || config.hostname);

  // A connection string can smuggle a remote host past a host check.
  if (config && config.connectionString) {
    throw new PolicyViolation(
      'db_policy: connectionString is not accepted. Use explicit host/port/database '
      + 'fields so the host can be checked before a socket is opened.'
    );
  }

  if (!host) {
    throw new PolicyViolation(
      'db_policy: no database host configured. Set PGHOST=127.0.0.1 in .env '
      + '(see config/local.example.env).'
    );
  }

  if (!isLocalHost(host)) {
    throw new PolicyViolation(
      `db_policy: refusing to connect to a non-local database host: ${host}\n`
      + '  Sentinel OS is local-only by design. It holds unpublished investigative\n'
      + '  material, and a reachable copy of that is a subpoena target and a breach\n'
      + '  target at once. If you need access from another machine, tunnel to this\n'
      + '  one over SSH — do not move the database.'
    );
  }

  // SSL to loopback is meaningless; warn only if someone asks for verification
  // against a remote CA, which suggests they think this is remote.
  if (config.ssl && config.ssl.rejectUnauthorized === true) {
    throw new PolicyViolation(
      'db_policy: TLS verification is configured, which only makes sense for a '
      + 'remote database. This connection is local. Set PGSSLMODE=disable.'
    );
  }

  return config;
}

module.exports = { assertLocal, isLocalHost, isSocketPath, PolicyViolation, LOCAL_HOSTS };
