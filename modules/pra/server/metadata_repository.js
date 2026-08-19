'use strict';
/**
 * server/metadata_repository.js — every read and write, in one place.
 *
 * TWO RULES THIS FILE ENFORCES
 *
 * 1. METADATA ONLY. There is no code path here that writes file bytes,
 *    extracted text, OCR output, or a preview into the database. Raw files live
 *    in the operator's Received_Records folder and are referenced by a RELATIVE
 *    path and a SHA-256. The schema has no content column to write to; this
 *    layer does not try to invent one.
 *
 * 2. MULTI-ROW WRITES ARE ATOMIC. Anything that touches more than one table
 *    goes through db.withTransaction, on one checked-out connection. Creating a
 *    received_record writes the record, its history row, and an audit row —
 *    all three land or none do. An earlier build issued BEGIN/COMMIT through
 *    the pool, which does not guarantee the same connection, and a crash could
 *    leave a record with no history. That is the bug this structure exists to
 *    prevent, and repo_atomicity.test.js proves it stays fixed.
 */

const audit = require('./audit_ledger.js');

// Statuses from migration 0001. Kept here so a bad status fails in JS with a
// clear message rather than as a Postgres CHECK violation.
const REQUEST_STATUSES = [
  'draft', 'planned', 'submitted', 'acknowledged', 'pending',
  'received', 'partial', 'denied', 'revised', 'published', 'closed',
];

const REVIEW_STATUSES = [
  'uploaded', 'needs_review', 'redaction_needed', 'redacted',
  'approved_internal', 'approved_public', 'rejected_private_data',
];

const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\/|\\\\)/;

class RepositoryError extends Error {}

function assertRelative(p, field) {
  if (p && ABSOLUTE_PATH.test(p)) {
    throw new RepositoryError(
      `${field} must be a relative path. An absolute path leaks your machine layout `
      + `and breaks portability if the evidence folder moves. Got: ${p}`
    );
  }
}

class MetadataRepository {
  constructor(db) {
    this.db = db;
  }

  // ------------------------------------------------------------ reference
  async listAgencies({ jurisdiction = null, search = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (jurisdiction) { params.push(jurisdiction); where.push(`(a.jurisdiction = $${params.length} OR a.jurisdiction_id = $${params.length})`); }
    if (search) { params.push(`%${search}%`); where.push(`(a.name ILIKE $${params.length} OR a.system_role ILIKE $${params.length})`); }
    params.push(limit);
    const res = await this.db.query(
      `SELECT a.agency_id, a.name, a.agency_type, a.jurisdiction, a.public_records_email,
              a.public_records_url, a.verified_status, a.system_role
         FROM agencies a
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.name
        LIMIT $${params.length}`,
      params
    );
    return res.rows;
  }

  async getFilingRoutes(agencyId) {
    const res = await this.db.query(
      `SELECT * FROM v_filing_routes WHERE agency_id = $1 ORDER BY is_primary DESC NULLS LAST`,
      [agencyId]
    );
    return res.rows;
  }

  async listTemplates(kind = null) {
    const res = kind
      ? await this.db.query('SELECT * FROM request_templates WHERE kind = $1 ORDER BY name', [kind])
      : await this.db.query('SELECT * FROM request_templates ORDER BY kind, name');
    return res.rows;
  }

  async listDeadlineRules({ activeOnly = true } = {}) {
    const res = await this.db.query(
      `SELECT * FROM deadline_rules ${activeOnly ? 'WHERE active' : ''} ORDER BY days NULLS LAST`
    );
    return res.rows;
  }

  // ------------------------------------------------------------- requests
  /**
   * Create a request plus its opening history row plus an audit row, atomically.
   */
  async createRequest(input) {
    const {
      requestId, agencyId = null, subject = null, scopeText = null,
      status = 'draft', investigationId = null, portalId = null,
      recordTypeId = null, templateId = null, priority = 'normal',
      dateRangeStart = null, dateRangeEnd = null, notes = null,
      actor = 'local_operator',
    } = input || {};

    if (!requestId) throw new RepositoryError('createRequest: requestId is required');
    if (!REQUEST_STATUSES.includes(status)) {
      throw new RepositoryError(`createRequest: unknown status "${status}". Known: ${REQUEST_STATUSES.join(', ')}`);
    }

    return this.db.withTransaction(async (client) => {
      const res = await client.query(
        `INSERT INTO requests
           (request_id, agency_id, status, subject, scope_text, investigation_id,
            portal_id, record_type_id, template_id, priority,
            date_range_start, date_range_end, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [requestId, agencyId, status, subject, scopeText, investigationId,
         portalId, recordTypeId, templateId, priority, dateRangeStart, dateRangeEnd, notes]
      );

      await client.query(
        `INSERT INTO request_history (request_id, from_status, to_status, actor, note)
         VALUES ($1, NULL, $2, $3, $4)`,
        [requestId, status, actor, 'created']
      );

      await audit.record(client, {
        entityType: 'request', entityId: requestId, action: 'create',
        detail: { status, agency_id: agencyId, subject }, actor,
      });

      return res.rows[0];
    });
  }

  /**
   * Change a request's status, writing the history row and audit row with it,
   * and setting the matching clock column in the same transaction.
   */
  async setRequestStatus(requestId, toStatus, { note = null, actor = 'local_operator', at = null } = {}) {
    if (!REQUEST_STATUSES.includes(toStatus)) {
      throw new RepositoryError(`setRequestStatus: unknown status "${toStatus}"`);
    }

    // Which clock column each status stamps, if it is not already set.
    const CLOCK = {
      submitted: 'submitted_at',
      acknowledged: 'acknowledged_at',
      received: 'fulfilled_at',
      partial: 'first_response_at',
      denied: 'first_response_at',
      closed: 'closed_at',
    };

    return this.db.withTransaction(async (client) => {
      const cur = await client.query('SELECT status FROM requests WHERE request_id = $1 FOR UPDATE', [requestId]);
      if (!cur.rowCount) throw new RepositoryError(`no such request: ${requestId}`);
      const fromStatus = cur.rows[0].status;

      const col = CLOCK[toStatus];
      const stamp = at || new Date();
      const sql = col
        ? `UPDATE requests SET status=$1, ${col}=COALESCE(${col}, $2) WHERE request_id=$3 RETURNING *`
        : 'UPDATE requests SET status=$1 WHERE request_id=$3 RETURNING *';
      const params = col ? [toStatus, stamp, requestId] : [toStatus, null, requestId];
      const res = await client.query(sql, params);

      // first_response_at is the anchor the clock re-baselines on, so any
      // status that represents the office answering sets it if unset.
      if (['acknowledged', 'received', 'partial', 'denied'].includes(toStatus)) {
        await client.query(
          'UPDATE requests SET first_response_at = COALESCE(first_response_at, $1) WHERE request_id = $2',
          [stamp, requestId]
        );
      }

      await client.query(
        `INSERT INTO request_history (request_id, from_status, to_status, actor, note)
         VALUES ($1,$2,$3,$4,$5)`,
        [requestId, fromStatus, toStatus, actor, note]
      );

      await audit.record(client, {
        entityType: 'request', entityId: requestId, action: 'status_change',
        detail: { from: fromStatus, to: toStatus, note }, actor,
      });

      return res.rows[0];
    });
  }

  async getRequest(requestId) {
    const res = await this.db.query('SELECT * FROM requests WHERE request_id = $1', [requestId]);
    return res.rows[0] || null;
  }

  async listRequests({ status = null, investigationId = null, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (investigationId) { params.push(investigationId); where.push(`investigation_id = $${params.length}`); }
    params.push(limit);
    const res = await this.db.query(
      `SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.rows;
  }

  /** The morning view: everything open, with its clock. */
  async requestClock() {
    return (await this.db.query('SELECT * FROM v_request_clock ORDER BY days_without_response DESC NULLS LAST')).rows;
  }

  async needsAttention() {
    return (await this.db.query('SELECT * FROM v_needs_attention ORDER BY days_without_response DESC NULLS LAST')).rows;
  }

  // ------------------------------------------------------ received records
  /**
   * Register a received file as METADATA. The bytes stay on disk.
   * Record + history + audit, atomically.
   */
  async addReceivedRecord(input) {
    const {
      id, requestId, originalFilename = null, safeDisplayName = null,
      fileType = null, fileSizeBytes = null, recommendedFileFolder = null,
      sha256 = null, receivedOn = null, pageCount = null,
      operatorNotes = null, actor = 'local_operator',
    } = input || {};

    if (!id) throw new RepositoryError('addReceivedRecord: id is required');
    if (!requestId) throw new RepositoryError('addReceivedRecord: requestId is required');
    assertRelative(recommendedFileFolder, 'recommended_file_folder');

    const sizeDisplay = fileSizeBytes == null ? null
      : fileSizeBytes < 1024 ? `${fileSizeBytes} B`
        : fileSizeBytes < 1048576 ? `${(fileSizeBytes / 1024).toFixed(1)} KB`
          : `${(fileSizeBytes / 1048576).toFixed(1)} MB`;

    return this.db.withTransaction(async (client) => {
      const res = await client.query(
        `INSERT INTO received_records
           (id, request_id, original_filename, safe_display_name, file_type,
            file_size_bytes, file_size_display, review_status,
            recommended_file_folder, sha256, received_on, page_count, operator_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'uploaded',$8,$9,$10,$11,$12)
         RETURNING *`,
        [id, requestId, originalFilename, safeDisplayName, fileType,
         fileSizeBytes, sizeDisplay, recommendedFileFolder, sha256,
         receivedOn, pageCount, operatorNotes]
      );

      await client.query(
        `INSERT INTO upload_review_history (received_record_id, from_status, to_status, actor, note)
         VALUES ($1, NULL, 'uploaded', $2, 'registered')`,
        [id, actor]
      );

      await audit.record(client, {
        entityType: 'received_record', entityId: id, action: 'create',
        detail: { request_id: requestId, file_type: fileType, sha256 }, actor,
      });

      return res.rows[0];
    });
  }

  async setReviewStatus(recordId, toStatus, { note = null, actor = 'local_operator' } = {}) {
    if (!REVIEW_STATUSES.includes(toStatus)) {
      throw new RepositoryError(`setReviewStatus: unknown review status "${toStatus}"`);
    }
    return this.db.withTransaction(async (client) => {
      const cur = await client.query('SELECT review_status FROM received_records WHERE id = $1 FOR UPDATE', [recordId]);
      if (!cur.rowCount) throw new RepositoryError(`no such received_record: ${recordId}`);
      const from = cur.rows[0].review_status;

      const res = await client.query(
        'UPDATE received_records SET review_status = $1 WHERE id = $2 RETURNING *',
        [toStatus, recordId]
      );
      await client.query(
        `INSERT INTO upload_review_history (received_record_id, from_status, to_status, actor, note)
         VALUES ($1,$2,$3,$4,$5)`,
        [recordId, from, toStatus, actor, note]
      );
      await audit.record(client, {
        entityType: 'received_record', entityId: recordId, action: 'review_status_change',
        detail: { from, to: toStatus, note }, actor,
      });
      return res.rows[0];
    });
  }

  /**
   * Rename the display name only. The original filename is evidence-chain
   * metadata and is never overwritten.
   */
  async renameDisplayName(recordId, safeDisplayName, { actor = 'local_operator' } = {}) {
    return this.db.withTransaction(async (client) => {
      const res = await client.query(
        'UPDATE received_records SET safe_display_name = $1 WHERE id = $2 RETURNING *',
        [safeDisplayName, recordId]
      );
      if (!res.rowCount) throw new RepositoryError(`no such received_record: ${recordId}`);
      await audit.record(client, {
        entityType: 'received_record', entityId: recordId, action: 'update',
        detail: { field: 'safe_display_name', to: safeDisplayName }, actor,
      });
      return res.rows[0];
    });
  }

  async listReceivedRecords(requestId) {
    const res = await this.db.query(
      'SELECT * FROM received_records WHERE request_id = $1 ORDER BY created_at',
      [requestId]
    );
    return res.rows;
  }

  /** Used by the export path — reads REAL state, so the ledger cannot lie. */
  async getAllRequestsWithRecords() {
    const requests = (await this.db.query('SELECT * FROM requests ORDER BY created_at')).rows;
    const records = (await this.db.query('SELECT * FROM received_records ORDER BY created_at')).rows;
    const byRequest = new Map();
    for (const r of records) {
      if (!byRequest.has(r.request_id)) byRequest.set(r.request_id, []);
      byRequest.get(r.request_id).push(r);
    }
    return requests.map((r) => Object.assign({}, r, { records: byRequest.get(r.request_id) || [] }));
  }

  // --------------------------------------------------------- followups
  /** followups is append-only, same trigger as the ledgers. */
  async logFollowup(input) {
    const {
      requestId, direction, channel, summary = null, fullText = null,
      templateId = null, occurredAt = null, actor = 'local_operator',
    } = input || {};
    if (!requestId || !direction || !channel) {
      throw new RepositoryError('logFollowup: requestId, direction and channel are required');
    }
    return this.db.withTransaction(async (client) => {
      const res = await client.query(
        `INSERT INTO followups (request_id, occurred_at, direction, channel, template_id, summary, full_text, actor)
         VALUES ($1, COALESCE($2, now()), $3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [requestId, occurredAt, direction, channel, templateId, summary, fullText, actor]
      );
      if (direction === 'sent') {
        await client.query(
          'UPDATE requests SET followup_count = followup_count + 1 WHERE request_id = $1',
          [requestId]
        );
      }
      await audit.record(client, {
        entityType: 'followup', entityId: String(res.rows[0].followup_id), action: 'followup_logged',
        detail: { request_id: requestId, direction, channel }, actor,
      });
      return res.rows[0];
    });
  }

  // ---------------------------------------------------------- dashboard
  /** The counts the desk shows. One round trip. */
  async dashboardCounts() {
    const res = await this.db.query(`
      SELECT
        (SELECT count(*) FROM requests WHERE status NOT IN ('closed','published'))::int AS open_requests,
        (SELECT count(*) FROM v_needs_attention)::int                                    AS needs_attention,
        (SELECT count(*) FROM sources)::int                                              AS sources,
        (SELECT count(*) FROM v_unverified_sources)::int                                 AS unverified_sources,
        (SELECT count(*) FROM agencies)::int                                             AS agencies,
        (SELECT count(*) FROM portals)::int                                              AS portals,
        (SELECT count(*) FROM jurisdictions)::int                                        AS jurisdictions,
        (SELECT count(*) FROM request_templates)::int                                    AS templates,
        (SELECT count(*) FROM received_records)::int                                     AS received_records,
        (SELECT count(*) FROM portals WHERE verified_status <> 'verified')::int          AS unverified_portals
    `);
    return res.rows[0];
  }
}

module.exports = { MetadataRepository, RepositoryError, REQUEST_STATUSES, REVIEW_STATUSES };
