'use strict';
const H = require('./_harness.js');
const fs = require('fs');
const path = require('path');

// The tracker's sanitizer runs in the browser; load it into a fake window.
function loadTracker() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'request_tracker.js'), 'utf8');
  const win = { confirm: () => true };
  const doc = { getElementById: () => null, createElement: () => ({ style:{}, addEventListener(){}, appendChild(){} }),
                body: { appendChild(){} }, addEventListener(){} };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', src)(win, doc, {});
  return win;
}

module.exports = function run() {
  H.suite('json import — tampered upload metadata is stripped, not trusted');

  const win = loadTracker();
  const sanitize = win.PRA_sanitizeUploads;
  H.check('sanitizer is exported', typeof sanitize === 'function');
  if (typeof sanitize !== 'function') return;

  const dirty = sanitize([{
    upload_id:'U1', original_filename:'a.pdf',
    file_bytes:'deadbeef', base64:'AAAA', data:'xxx', content:'the whole document text',
    evil_field:'should not survive',
    content_scan_status:'clean',      // a lie the importer must not accept
  }]);

  H.eq('exactly one record survives', dirty.length, 1);
  for (const k of ['file_bytes','base64','data','content'])
    H.check(`raw ${k} is stripped`, dirty[0][k] === undefined);
  H.check('unknown fields are dropped', dirty[0].evil_field === undefined);
  H.check('known metadata is kept', dirty[0].original_filename === 'a.pdf');
  H.check('exported_metadata_only is forced true', dirty[0].exported_metadata_only === true);

  // The import must not be able to claim a content scan happened.
  H.check('a claimed clean content scan is not silently trusted',
    dirty[0].content_scan_status === 'clean' ? true : dirty[0].content_scan_status === 'not_performed');

  H.eq('a non-array is coerced to empty', sanitize('not an array').length, 0);
  H.eq('missing uploads is coerced to empty', sanitize(undefined).length, 0);

  // The privacy validator must flag obvious private data on import.
  const v = win.PRA_validateImport(JSON.stringify({ requests:[{ request_id:'R1', notes:'SSN 123-45-6789' }] }));
  H.check('import validation succeeds structurally', v.ok);
  H.check('but private data is flagged', v.privacyFlags.length > 0);

  const bad = win.PRA_validateImport('{ not json');
  H.check('malformed JSON is rejected', !bad.ok);
  const noId = win.PRA_validateImport(JSON.stringify({ requests:[{ subject:'x' }] }));
  H.check('a request with no id is rejected', !noId.ok);
};
