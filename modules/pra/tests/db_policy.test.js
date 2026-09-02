'use strict';
const H = require('./_harness.js');
const p = require('../server/db_policy.js');

module.exports = function run() {
  H.suite('db_policy — the database stays on this machine');

  for (const h of ['127.0.0.1','localhost','::1','127.0.0.2','/var/run/postgresql'])
    H.check(`accepts local host ${h}`, p.isLocalHost(h));

  for (const h of ['db.example.com','10.0.0.5','192.168.1.10','203.0.113.9','rds.amazonaws.com'])
    H.check(`rejects remote host ${h}`, !p.isLocalHost(h));

  H.throws('assertLocal refuses a remote host', () => p.assertLocal({ host: 'db.example.com' }), 'non-local');
  H.throws('assertLocal refuses a connectionString (can smuggle a host)',
    () => p.assertLocal({ connectionString: 'postgres://u:p@evil/db' }), 'connectionString');
  H.throws('assertLocal refuses an empty host', () => p.assertLocal({}), 'no database host');
  H.throws('assertLocal refuses remote TLS verification',
    () => p.assertLocal({ host: '127.0.0.1', ssl: { rejectUnauthorized: true } }), 'TLS');
  H.check('assertLocal passes a local config', !!p.assertLocal({ host: '127.0.0.1', port: 5432 }));
};
