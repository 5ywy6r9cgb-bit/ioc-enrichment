'use strict';
/**
 * chain.js — diagnose a broken certificate chain, and complete it safely.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 *
 * A records portal serves its own certificate but not the intermediate that
 * signs it. Browsers hide the defect by fetching the missing certificate from
 * the URL in the leaf's Authority Information Access extension. Node does not
 * chase AIA, so it sees a chain that dead-ends and refuses the connection.
 *
 * The operator then finds `NODE_TLS_REJECT_UNAUTHORIZED=0`, and from that
 * moment every document this desk fetches is one that cannot be cited —
 * with nothing in the ledger to record that anything changed.
 *
 * So: fetch the certificate the server should have sent, and hand it to Node
 * as an additional trust anchor. Verification stays ON. Nothing is bypassed.
 * The chain is completed with the real intermediate, which is precisely what
 * a browser does.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE UNVERIFIED CONNECTION, AND WHY IT IS NOT A LOOPHOLE
 *
 * Reading a server's certificate requires connecting to it, and if the chain
 * were verifiable we would not be here. So the DIAGNOSTIC connection sets
 * rejectUnauthorized:false.
 *
 * That connection reads certificates and nothing else. It never returns a
 * document, never writes to the evidence tree, and never touches the
 * provenance ledger. A certificate obtained this way is not trusted on its
 * own either — it is only useful if it actually signs the leaf and chains to
 * a root Node already trusts, and the REAL fetch afterwards is the thing that
 * proves it, because that fetch verifies normally or fails.
 */

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');

/** DER bytes → the PEM text Node's `ca` option and NODE_EXTRA_CA_CERTS take. */
function derToPem(der) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${b64.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * What the server actually presented.
 *
 * Returns the leaf plus every certificate above it that the server bothered
 * to send. `served` is the count, and a count of 1 on a certificate that is
 * not self-signed IS the diagnosis.
 */
function inspect(host, opts = {}) {
  const port = opts.port || 443;
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      // Diagnostic only. See the header. This connection yields certificates,
      // never a document, and writes nothing to the evidence tree.
      rejectUnauthorized: false,
      timeout: opts.timeout || 15000,
    }, () => {
      const leaf = socket.getPeerCertificate(true);
      const chain = [];
      const seen = new Set();
      let cur = leaf;
      while (cur && cur.raw && !seen.has(cur.fingerprint256)) {
        seen.add(cur.fingerprint256);
        chain.push(cur);
        cur = cur.issuerCertificate;
      }
      const authorized = socket.authorized;
      const reason = socket.authorizationError ? String(socket.authorizationError) : null;
      socket.end();
      resolve({ ok: true, host, authorized, reason, chain, served: chain.length, leaf });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, host, error: 'timed out' }); });
    socket.on('error', (e) => resolve({ ok: false, host, error: e.message }));
  });
}

/** The AIA "CA Issuers" URLs on a certificate, if it published any. */
function issuerUrls(cert) {
  const ia = cert && cert.infoAccess;
  if (!ia) return [];
  const key = Object.keys(ia).find((k) => /CA Issuers/i.test(k));
  if (!key) return [];
  return (ia[key] || [])
    .map((v) => String(v).trim())
    // http:// is the norm for AIA and is not a risk here: a certificate is
    // self-authenticating. It is only useful if it signs the leaf and chains
    // to a root already trusted, and the verified fetch afterwards is what
    // proves that. It is still never executed, parsed as anything but a
    // certificate, or trusted on the strength of where it came from.
    .filter((v) => /^https?:\/\//i.test(v));
}

/** Download one certificate. Verified transport where the URL allows it. */
function fetchCert(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : require('http');
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        const text = buf.toString('utf8');
        // Served either as PEM already, or as raw DER.
        if (/-----BEGIN CERTIFICATE-----/.test(text)) return resolve(text);
        try { return resolve(derToPem(buf)); } catch { return resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * Diagnose, and write a PEM that completes the chain if one can be built.
 *
 * Returns what it found and what it wrote. Deliberately does NOT retry the
 * original fetch: completing a chain and then trusting your own completion in
 * the same breath hides whether it actually worked. The operator re-runs the
 * real command, and that command either verifies or does not.
 */
async function complete(host, opts = {}) {
  const seen = await inspect(host, opts);
  if (!seen.ok) return seen;

  const pems = seen.chain.map((c) => derToPem(c.raw));
  const fetched = [];

  // Walk up from the topmost certificate the server sent, asking each one who
  // signed it, until nothing more publishes an issuer.
  let top = seen.chain[seen.chain.length - 1];
  for (let hop = 0; hop < 4 && top; hop++) {
    const urls = issuerUrls(top);
    if (!urls.length) break;
    let got = null;
    for (const u of urls) {
      got = await fetchCert(u);
      if (got) { fetched.push({ url: u }); break; }
    }
    if (!got) break;
    pems.push(got);
    try {
      const parsed = new (require('crypto').X509Certificate)(got);
      // Stop at a root: it signs itself, so there is nothing above it.
      if (parsed.issuer === parsed.subject) break;
      top = { infoAccess: null, raw: parsed.raw };
      top.infoAccess = parsed.infoAccess
        ? Object.fromEntries(String(parsed.infoAccess).split('\n').filter(Boolean)
            .map((l) => l.split(':')).map(([k, ...r]) => [k.trim(), [r.join(':').trim()]]))
        : null;
    } catch { break; }
  }

  let written = null;
  if (!opts.noWrite) {
    const dir = opts.dir || path.join('evidence', 'chains');
    fs.mkdirSync(dir, { recursive: true });
    written = path.join(dir, `${host.replace(/[^A-Za-z0-9.-]/g, '_')}.pem`);
    fs.writeFileSync(written, pems.join(''));
  }

  return {
    ok: true,
    host,
    authorized: seen.authorized,
    reason: seen.reason,
    served: seen.served,
    // The diagnosis, in one boolean: a lone non-self-signed leaf means the
    // server left the intermediate out.
    intermediateMissing: seen.served === 1
      && !!seen.leaf && seen.leaf.subject
      && JSON.stringify(seen.leaf.subject) !== JSON.stringify(seen.leaf.issuer),
    fetched,
    certificates: pems.length,
    written,
    subject: seen.leaf && seen.leaf.subject ? seen.leaf.subject.CN || '' : '',
    issuer: seen.leaf && seen.leaf.issuer ? seen.leaf.issuer.CN || '' : '',
    validTo: seen.leaf ? seen.leaf.valid_to : '',
  };
}

module.exports = { inspect, complete, derToPem, issuerUrls, fetchCert };
