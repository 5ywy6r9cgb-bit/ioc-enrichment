'use strict';
const H = require('./_harness.js');
const xl = require('../server/export_ledger.js');

module.exports = function run() {
  H.suite('json export — metadata only, at every nesting depth');

  const FORBIDDEN = ['file_bytes','base64','content','data','ocr_text','extracted_text','body_text','preview'];
  for (const key of FORBIDDEN) {
    H.throws(`rejects "${key}" at the top level`,
      () => xl.assertMetadataOnly({ [key]: 'x' }), 'file content');
    H.throws(`rejects "${key}" nested three deep`,
      () => xl.assertMetadataOnly({ requests: [{ records: [{ [key]: 'x' }] }] }), 'file content');
  }

  H.check('an empty forbidden field is allowed through',
    (() => { try { xl.assertMetadataOnly({ content: '' }); return true; } catch { return false; } })());

  H.check('legitimate metadata passes', (() => {
    try {
      xl.assertMetadataOnly({
        requests: [{
          request_id:'R1', subject:'x', status:'submitted',
          records: [{ id:'RR1', sha256:'a'.repeat(64), file_type:'pdf', page_count: 12,
                      recommended_file_folder:'Received_Records/2026/' }],
        }],
      });
      return true;
    } catch { return false; }
  })());
};
