'use strict';
/**
 * server/audit_ledger.js — the append-only record of material change.
 *
 * Three layers stop this ledger from being rewritten, and all three are real:
 *   1. a database trigger raises on UPDATE or DELETE (prevent_ledger_mutation)
 *   2. the app role holds INSERT and SELECT only — no UPDATE, no DELETE grant
 *   3. this module exposes no update or delete function at all
 *
 * Belt, suspenders, and no belt loops. The point is that a bug in the
 * application cannot quietly rewrite history, because the application was
 * never given the verb.
 *
 * A failure to write an audit row is NOT swallowed. If the ledger cannot
 * record what happened, the operation that caused it should fail too —
 * otherwise you end up with state whose history is missing, which is worse
 * than no state at all.
 */

const ACTIONS = new Set([
  'create', 'update', 'status_change', 'import', 'export',
  'strip_forbidden_field', 'review_status_change', 'draft', 'followup_logged',
]);

const ENTITY_TYPES = new Set([
  'request', 'received_record', 'export', 'import', 'source', 'entity',
  'investigation', 'followup', 'system',
]);

/**
 * Append one audit row.
 *
 * @param {object} exec   a Db or a pg client — anything with .query()
 * @param {object} event  { entityType, entityId, action, detail, actor }
 */
async function record(exec, event) {
  const { entityType, entityId = null, action, detail = null, actor = 'local_operator' } = event || {};

  if (!entityType || !action) {
    throw new Error('audit_ledger: entityType and action are required');
  }
  // Unknown values are allowed through but flagged in the detail, rather than
  // rejected: losing an audit row to a vocabulary mismatch would be the worst
  // possible trade.
  const known = ENTITY_TYPES.has(entityType) && ACTIONS.has(action);
  const payload = known ? detail : Object.assign({ _unknown_vocabulary: true }, detail || {});

  const res = await exec.query(
    `INSERT INTO audit_ledger (actor, entity_type, entity_id, action, detail)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING audit_id, at`,
    [actor, entityType, entityId, action, payload ? JSON.stringify(payload) : null]
  );
  return res.rows[0];
}

/** Read the trail for one entity, oldest first. */
async function forEntity(exec, entityType, entityId, limit = 200) {
  const res = await exec.query(
    `SELECT audit_id, at, actor, entity_type, entity_id, action, detail
       FROM audit_ledger
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY audit_id ASC
      LIMIT $3`,
    [entityType, entityId, limit]
  );
  return res.rows;
}

/** Most recent activity across everything — what the daily brief shows. */
async function recent(exec, limit = 50) {
  const res = await exec.query(
    `SELECT audit_id, at, actor, entity_type, entity_id, action, detail
       FROM audit_ledger
      ORDER BY audit_id DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/**
 * Prove the append-only guarantee is actually in force, rather than assuming
 * the migration ran. Attempts an UPDATE inside a savepoint and expects it to
 * fail; rolls back either way so nothing is left behind.
 */
async function verifyAppendOnly(db) {
  return db.withTransaction(async (client) => {
    const probe = await client.query(
      `INSERT INTO audit_ledger (actor, entity_type, entity_id, action, detail)
       VALUES ('local_operator','system','append-only-probe','update',$1)
       RETURNING audit_id`,
      [JSON.stringify({ probe: true })]
    );
    const id = probe.rows[0].audit_id;

    let updateBlocked = false;
    await client.query('SAVEPOINT probe_update');
    try {
      await client.query('UPDATE audit_ledger SET actor = $1 WHERE audit_id = $2', ['tampered', id]);
      await client.query('RELEASE SAVEPOINT probe_update');
    } catch {
      updateBlocked = true;
      await client.query('ROLLBACK TO SAVEPOINT probe_update');
    }

    let deleteBlocked = false;
    await client.query('SAVEPOINT probe_delete');
    try {
      await client.query('DELETE FROM audit_ledger WHERE audit_id = $1', [id]);
      await client.query('RELEASE SAVEPOINT probe_delete');
    } catch {
      deleteBlocked = true;
      await client.query('ROLLBACK TO SAVEPOINT probe_delete');
    }

    // Roll the probe row back out — throwing is how withTransaction rolls back,
    // so instead we return the result and let the caller's transaction abort.
    throw Object.assign(new Error('__probe_rollback__'), {
      probeResult: { updateBlocked, deleteBlocked, ok: updateBlocked && deleteBlocked },
    });
  }).catch((e) => {
    if (e && e.probeResult) return e.probeResult;
    throw e;
  });
}

module.exports = { record, forEntity, recent, verifyAppendOnly, ACTIONS, ENTITY_TYPES };
