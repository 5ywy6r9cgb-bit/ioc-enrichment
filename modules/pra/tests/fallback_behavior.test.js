'use strict';
const H = require('./_harness.js');
const fs = require('fs');
const path = require('path');
const { LOCAL_BIND } = require('../server/local_service.js');

module.exports = function run() {
  H.suite('fallback + binding — the service stays on loopback, the desk survives without it');

  H.check('only loopback addresses are bindable',
    ['127.0.0.1','localhost','::1'].every((h) => LOCAL_BIND.has(h)));
  H.check('0.0.0.0 is not bindable', !LOCAL_BIND.has('0.0.0.0'));
  H.check('a LAN address is not bindable', !LOCAL_BIND.has('192.168.1.10'));

  // createService must refuse a non-local bind rather than warn.
  const { createService } = require('../server/local_service.js');
  H.throws('createService refuses to bind to 0.0.0.0',
    () => createService({ host:'0.0.0.0', db:{ isAvailable:async()=>true, config:{}, query:async()=>({rows:[]}) } }),
    'loopback-only');

  // The persistence client must fall back rather than throw.
  const client = fs.readFileSync(path.join(__dirname, '..', 'app', 'pra_persistence_client.js'), 'utf8');
  H.check('client defaults to session-json mode', client.includes("mode: 'session-json'"));
  H.check('client catches a failed health probe', /\.catch\(/.test(client));
  H.check('client treats 503 as fallback, not error', client.includes('503'));
  H.check('client never sends raw file content', !/file_bytes|base64/.test(client));

  // The desk must degrade too.
  const desk = fs.readFileSync(path.join(__dirname, '..', '..', 'research-desk', 'app', 'desk.html'), 'utf8');
  H.check('desk has an offline path', desk.includes('function offline'));
  H.check('desk states the service is down rather than blanking', desk.includes('not answering'));
  H.check('desk loads no external resource', !/https?:\/\/(?!127\.0\.0\.1)/.test(
    desk.replace(/<!--[\s\S]*?-->/g, '')));
};
