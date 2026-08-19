'use strict';
/**
 * server/request_drafter.js — fills a template, screens it, and refuses to
 * call it sendable when it should not be.
 *
 * THE THREE REFUSALS
 *
 * 1. AN UNFILLED PLACEHOLDER IS NEVER SENDABLE. A letter that goes out reading
 *    "{{agency_name}}" tells the office you are not paying attention, and every
 *    later letter in the thread is read in that light.
 *
 * 2. PRIVATE DATA IN THE SCOPE IS NEVER SENDABLE. This system requests public
 *    records. An SSN, an account number, or a private home address in the scope
 *    text means either you are asking for something you should not, or you have
 *    pasted something you should not have. Both stop the draft.
 *
 * 3. A HIGH PRIVACY-RISK RECORD TYPE REQUIRES ACKNOWLEDGEMENT. Not a block —
 *    some high-risk requests are entirely legitimate — but you have to say so
 *    deliberately rather than let it slide past.
 *
 * The drafter never sends. It produces text; you read it, and you send it.
 */

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

// Patterns that mean private data has landed in a request. Same family the
// tracker's import validator uses, kept deliberately consistent.
const PRIVATE_PATTERNS = [
  [/\b\d{3}-\d{2}-\d{4}\b/, 'looks like a Social Security number'],
  [/\b(?:\d[ -]*?){13,16}\b/, 'looks like a payment card number'],
  [/\baccount\s*(?:number|no|#)\s*[:#]?\s*\d{4,}/i, 'looks like an account number'],
  [/\brouting\s*(?:number|no|#)\s*[:#]?\s*\d{4,}/i, 'looks like a routing number'],
  [/\b(?:date\s+of\s+birth|d\.?o\.?b\.?)\b\s*[:#]?\s*\d/i, 'looks like a date of birth'],
  [new RegExp(
    '\\b\\d+\\s+(?:[NSEW]{1,2}\\.?\\s+)?(?:[A-Za-z][A-Za-z.\\-]*\\s+){0,3}'
    + '(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court'
    + '|Pl|Place|Ter|Terr|Terrace|Cir|Circle|Way|Pkwy|Parkway|Trl|Trail)\\.?\\b', 'i'),
   'looks like a street address — if this is a private residence, remove it'],
];

/** Substitute {{name}} from values. Unknown names are left in place on purpose. */
function fill(template, values) {
  return String(template || '').replace(PLACEHOLDER, (match, name) => {
    const v = values[name];
    return (v === undefined || v === null || v === '') ? match : String(v);
  });
}

/** Which placeholders are still unfilled in the produced text. */
function unfilled(text) {
  const out = new Set();
  let m;
  const re = new RegExp(PLACEHOLDER.source, 'gi');
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return Array.from(out);
}

/** Screen text for private data. Returns [{pattern, why, excerpt}]. */
function screenPrivate(text) {
  const findings = [];
  for (const [re, why] of PRIVATE_PATTERNS) {
    const m = re.exec(String(text || ''));
    if (m) {
      findings.push({
        why,
        excerpt: m[0].length > 40 ? `${m[0].slice(0, 37)}…` : m[0],
      });
    }
  }
  return findings;
}

function dateRangeClause(start, end) {
  if (!start && !end) return 'Please include all records regardless of date.';
  if (start && end) return `Please limit this request to records dated between ${start} and ${end}, inclusive.`;
  if (start) return `Please limit this request to records dated ${start} or later.`;
  return `Please limit this request to records dated ${end} or earlier.`;
}

function requesterBlock(name, contact) {
  if (!name && !contact) {
    return '[YOUR NAME]\n[YOUR EMAIL OR MAILING ADDRESS]\n\n'
         + '(Ohio does not require a requester to identify themselves. This block is\n'
         + 'only so the office knows where to deliver the records.)';
  }
  return [name || '[YOUR NAME]', contact || '[YOUR EMAIL OR MAILING ADDRESS]'].join('\n');
}

/**
 * Draft a letter.
 *
 * @param {object} template  a request_templates row
 * @param {object} ctx       { agency, request, recordType, operator, extra }
 * @returns {object} { subject, body, sendable, blockers, warnings, unfilled, citation }
 */
function draft(template, ctx = {}) {
  if (!template || !template.body) {
    throw new Error('draft: a template row with a body is required');
  }
  const { agency = {}, request = {}, recordType = null, operator = {}, extra = {} } = ctx;

  const values = Object.assign({
    agency_name: agency.name || null,
    agency_email: agency.public_records_email || null,
    request_id: request.request_id || null,
    subject: request.subject || null,
    scope_text: request.scope_text || (recordType && recordType.template_language) || null,
    submitted_date: request.submitted_at ? new Date(request.submitted_at).toISOString().slice(0, 10) : null,
    response_date: request.first_response_at ? new Date(request.first_response_at).toISOString().slice(0, 10) : null,
    followup_date: extra.followup_date || null,
    days_open: request.submitted_at
      ? Math.floor((Date.now() - new Date(request.submitted_at).getTime()) / 86400000)
      : null,
    fee_quoted: request.fee_quoted != null ? `$${Number(request.fee_quoted).toFixed(2)}` : null,
    date_range_clause: dateRangeClause(request.date_range_start, request.date_range_end),
    requester_block: requesterBlock(operator.name, operator.contact),
  }, extra);

  const body = fill(template.body, values);
  const subject = fill(template.subject_line || '', values);

  const missing = unfilled(`${subject}\n${body}`);
  const privateFindings = screenPrivate(`${subject}\n${values.scope_text || ''}\n${body}`);

  const blockers = [];
  const warnings = [];

  if (missing.length) {
    blockers.push({
      code: 'UNFILLED_PLACEHOLDER',
      message: `${missing.length} placeholder(s) not filled: ${missing.join(', ')}`,
      detail: 'A letter containing {{...}} tells the office you are not paying attention.',
    });
  }

  for (const f of privateFindings) {
    blockers.push({
      code: 'PRIVATE_DATA',
      message: `${f.why}: "${f.excerpt}"`,
      detail: 'This system requests PUBLIC records. Remove private data before sending.',
    });
  }

  if (recordType && recordType.privacy_risk_level === 'high') {
    blockers.push({
      code: 'HIGH_PRIVACY_RISK',
      message: `record type "${recordType.name}" is marked high privacy risk`,
      detail: 'Confirm deliberately with acknowledgeHighRisk:true if this request is appropriate.',
    });
  }
  if (recordType && recordType.privacy_risk_level === 'medium') {
    warnings.push({
      code: 'MEDIUM_PRIVACY_RISK',
      message: `record type "${recordType.name}" is medium privacy risk — ask for aggregate or redacted data if that answers the question`,
    });
  }

  if (extra.acknowledgeHighRisk === true) {
    const i = blockers.findIndex((b) => b.code === 'HIGH_PRIVACY_RISK');
    if (i >= 0) {
      const [b] = blockers.splice(i, 1);
      warnings.push({ code: 'HIGH_PRIVACY_RISK_ACKNOWLEDGED', message: b.message });
    }
  }

  if (!agency.public_records_email && !agency.public_records_url) {
    warnings.push({
      code: 'NO_KNOWN_ROUTE',
      message: 'no records email or portal on file for this agency — look up the custodian before sending',
    });
  }
  if (agency.verified_status && agency.verified_status !== 'verified') {
    warnings.push({
      code: 'UNVERIFIED_AGENCY',
      message: `agency record is "${agency.verified_status}" — confirm the office and custodian before filing`,
    });
  }

  // The citation warning rides on every draft, always.
  warnings.push({
    code: 'VERIFY_CITATION',
    message: `re-check ${template.statute_citation || 'every statutory citation'} against codes.ohio.gov before sending`,
    detail: 'A wrong citation hands the office a reason to dismiss the request.',
  });

  return {
    template_id: template.template_id,
    kind: template.kind,
    citation: template.statute_citation || null,
    subject,
    body,
    unfilled: missing,
    blockers,
    warnings,
    // The whole point: sendable is false unless every blocker is cleared.
    sendable: blockers.length === 0,
  };
}

module.exports = {
  draft, fill, unfilled, screenPrivate, dateRangeClause, requesterBlock, PRIVATE_PATTERNS,
};
