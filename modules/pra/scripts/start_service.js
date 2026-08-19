#!/usr/bin/env node
'use strict';
/**
 * scripts/start_service.js — start the localhost bridge.
 *
 *   npm run service          →  http://127.0.0.1:4317
 *
 * Then open the desk (modules/research-desk/app/desk.html) and it will find it.
 */

const { createService } = require('../server/local_service.js');

const { server, db, host, port } = createService();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use.`);
    console.error('  Another copy of the service is probably running. Find it with:');
    console.error(`    lsof -nP -iTCP:${port} -sTCP:LISTEN\n`);
  } else {
    console.error(`\n  service failed to start: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(port, host, async () => {
  const available = await db.isAvailable();
  console.log('');
  console.log('  Sentinel PRA — local service');
  console.log(`    listening   http://${host}:${port}   (loopback only)`);
  console.log(`    database    ${available ? `${db.config.database} @ ${db.config.host}` : 'UNREACHABLE'}`);
  if (!available) {
    console.log(`    note        ${db.lastError()}`);
    console.log('                The desk will fall back to session/JSON behavior.');
  }
  console.log('');
  console.log('  Open the desk:  modules/research-desk/app/desk.html');
  console.log('  Stop:           Ctrl-C');
  console.log('');
});

async function shutdown(signal) {
  console.log(`\n  ${signal} — shutting down`);
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
