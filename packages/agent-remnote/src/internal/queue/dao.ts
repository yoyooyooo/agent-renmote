import type { QueueDB } from './db.js';
import { randomUUID, createHash } from 'node:crypto';
import { sanitizeRemnoteWritePayload } from './sanitize.js';

import { deriveConflictKeys } from '../../kernel/conflicts/index.js';

export type OpType =
  | 'create_rem'
  | 'create_portal'
  | 'create_portal_bulk'
  | 'create_single_rem_with_markdown'
  | 'create_tree_with_markdown'
  | 'replace_selection_with_markdown'
  | 'replace_children_with_markdown'
  | 'create_link_rem'
  | 'create_table'
  | 'add_property'
  | 'set_property_type'
  | 'set_table_filter'
  | 'add_option'
  | 'remove_option'
  | 'table_add_row'
  | 'table_remove_row'
  | 'set_cell_select'
  | 'set_cell_checkbox'
  | 'set_cell_number'
  | 'set_cell_date'
  | 'update_text'
  | 'move_rem'
  | 'move_rem_bulk'
  | 'add_tag'
  | 'add_tag_bulk'
  | 'remove_tag'
  | 'remove_tag_bulk'
  | 'set_attribute'
  | 'table_cell_write'
  | 'add_source'
  | 'add_source_bulk'
  | 'remove_source'
  | 'remove_source_bulk'
  | 'set_todo_status'
  | 'set_todo_status_bulk'
  | 'delete_rem'
  | 'delete_backup_artifact';

export type EnqueueOpInput = {
  type: OpType;
  payload: any;
  idempotencyKey?: string;
  maxAttempts?: number;
  deliverAfterMs?: number;
};

export type OpRow = {
  op_id: string;
  txn_id: string;
  op_seq: number;
  // Joined from `queue_txns.dispatch_mode` in some hot paths (e.g. WS scheduler prefetch).
  // Absent when the row comes from a plain `queue_ops` query.
  txn_dispatch_mode?: string | null;
  type: string;
  payload_json: string;
  status: string;
  idempotency_key: string | null;
  op_hash: string;
  attempt_id: string | null;
  attempt_count: number;
  max_attempts: number;
  deliver_after: number;
  next_attempt_at: number;
  locked_by: string | null;
  locked_at: number | null;
  lease_expires_at: number | null;
  dead_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type BatchClaimCandidate = {
  readonly op_id: string;
  readonly txn_id: string;
  readonly op_seq: number;
  readonly txn_dispatch_mode?: string | null;
  readonly type: string;
  readonly payload_json: string;
  readonly idempotency_key: string | null;
  readonly leaseMs?: number | undefined;
};

export function nowMs() {
  return Date.now();
}

function safeParseJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function markTxnFailedAndCancelPendingOps(
  db: QueueDB,
  params: { readonly txnId: string; readonly failedOpId: string; readonly reason: string; readonly t: number },
): void {
  const cancelReason = `txn_failed:${params.failedOpId}`;
  db.prepare(
    `INSERT OR REPLACE INTO queue_op_results(op_id, error_code, error_message, finished_at)
     SELECT op_id, 'TXN_FAILED', @reason, @t
       FROM queue_ops
      WHERE txn_id=@txn_id AND status='pending'`,
  ).run({
    txn_id: params.txnId,
    reason: params.reason || cancelReason,
    t: params.t,
  });

  db.prepare(
    `UPDATE queue_ops
     SET status='dead',
         dead_reason=@reason,
         locked_at=NULL,
         lease_expires_at=NULL,
         updated_at=@t
     WHERE txn_id=@txn_id AND status='pending'`,
  ).run({
    txn_id: params.txnId,
    reason: cancelReason,
    t: params.t,
  });

  db.prepare(`UPDATE queue_txns SET status='failed', finished_at=@t, updated_at=@t WHERE txn_id=@txn_id`).run({
    t: params.t,
    txn_id: params.txnId,
  });
}

export function stableHash(obj: any) {
  const json = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

export function createTxn(
  db: QueueDB,
  params?: {
    priority?: number;
    idempotencyKey?: string;
    clientId?: string;
    dispatchMode?: 'serial' | 'conflict_parallel';
    meta?: any;
  },
) {
  const txn_id = randomUUID();
  const t = nowMs();
  const meta_json = JSON.stringify(params?.meta ?? {});
  const dispatch_mode = params?.dispatchMode === 'conflict_parallel' ? 'conflict_parallel' : 'serial';
  const stmt = db.prepare(
    `INSERT INTO queue_txns (txn_id, status, dispatch_mode, priority, idempotency_key, client_id, meta_json, op_count, next_seq, created_at, updated_at)
     VALUES (@txn_id, 'pending', @dispatch_mode, @priority, @idempotency_key, @client_id, @meta_json, 0, 0, @t, @t)`,
  );
  stmt.run({
    txn_id,
    dispatch_mode,
    priority: params?.priority ?? 0,
    idempotency_key: params?.idempotencyKey ?? null,
    client_id: params?.clientId ?? null,
    meta_json,
    t,
  });
  return txn_id;
}

export function addOps(db: QueueDB, txn_id: string, ops: EnqueueOpInput[]) {
  const getSeq = db.prepare(`SELECT next_seq FROM queue_txns WHERE txn_id = ?`);
  const updSeq = db.prepare(
    `UPDATE queue_txns SET next_seq = next_seq + 1, op_count = op_count + 1, updated_at = ? WHERE txn_id = ?`,
  );
  const ins = db.prepare(
    `INSERT INTO queue_ops (op_id, txn_id, op_seq, type, payload_json, status, idempotency_key, op_hash, attempt_count, max_attempts, deliver_after, next_attempt_at, created_at, updated_at)
     VALUES (@op_id, @txn_id, @op_seq, @type, @payload_json, 'pending', @idempotency_key, @op_hash, 0, @max_attempts, @deliver_after, @next_attempt_at, @t, @t)`,
  );
  const t = nowMs();
  const trx = db.transaction(() => {
    let seq = (getSeq.get(txn_id) as any)?.next_seq as number;
    if (typeof seq !== 'number') throw new Error(`txn not found: ${txn_id}`);
    for (const op of ops) {
      seq += 1;
      const sanitizedPayload = sanitizeRemnoteWritePayload(op.payload ?? {});
      const payload_json = JSON.stringify(sanitizedPayload);
      const op_hash = stableHash({ type: op.type, payload: sanitizedPayload });
      const op_id = randomUUID();
      const deliver_after = nowMs() + (op.deliverAfterMs ?? 0);
      const next_attempt_at = deliver_after;
      ins.run({
        op_id,
        txn_id,
        op_seq: seq,
        type: op.type,
        payload_json,
        idempotency_key: op.idempotencyKey ?? null,
        op_hash,
        max_attempts: op.maxAttempts ?? 10,
        deliver_after,
        next_attempt_at,
        t,
      });
      updSeq.run(t, txn_id);
    }
  });
  trx();
}

export function commitTxn(db: QueueDB, txn_id: string) {
  const t = nowMs();
  const upd = db.prepare(
    `UPDATE queue_txns SET status = 'ready', committed_at = @t, updated_at = @t WHERE txn_id = @txn_id`,
  );
  upd.run({ t, txn_id });
}

export function enqueueTxn(
  db: QueueDB,
  ops: EnqueueOpInput[],
  options?: {
    priority?: number;
    idempotencyKey?: string;
    clientId?: string;
    dispatchMode?: 'serial' | 'conflict_parallel';
    meta?: any;
  },
) {
  const trx = db.transaction(() => {
    const txn_id = createTxn(db, options);
    addOps(db, txn_id, ops);
    commitTxn(db, txn_id);
    return txn_id;
  });
  return trx();
}

export type AckResult =
  | { readonly ok: true; readonly op_id: string; readonly attempt_id: string; readonly duplicate: boolean }
  | {
      readonly ok: false;
      readonly op_id: string;
      readonly attempt_id: string;
      readonly reason: 'not_found' | 'stale_ack' | 'invalid_attempt';
      readonly current?: {
        readonly status: string;
        readonly attempt_id: string | null;
        readonly locked_by: string | null;
      };
    };

export class IdMapConflictError extends Error {
  readonly _tag = 'IdMapConflictError';
  readonly clientTempId: string;
  readonly existing: {
    readonly remote_id: string | null;
    readonly remote_type: string | null;
    readonly source_txn: string | null;
  };
  readonly incoming: {
    readonly remote_id: string;
    readonly remote_type: string | null;
    readonly source_txn: string | null;
  };

  constructor(params: {
    readonly clientTempId: string;
    readonly existing: {
      readonly remote_id: string | null;
      readonly remote_type: string | null;
      readonly source_txn: string | null;
    };
    readonly incoming: {
      readonly remote_id: string;
      readonly remote_type: string | null;
      readonly source_txn: string | null;
    };
  }) {
    super('Id map conflict detected');
    this.name = 'IdMapConflictError';
    this.clientTempId = params.clientTempId;
    this.existing = params.existing;
    this.incoming = params.incoming;
  }
}

function upsertOpAttempt(
  db: QueueDB,
  params: {
    readonly opId: string;
    readonly attemptId: string;
    readonly connId?: string | null;
    readonly status: string;
    readonly detail?: unknown;
  },
): void {
  const t = nowMs();
  const detail_json = JSON.stringify(params.detail ?? {});
  try {
    db.prepare(
      `INSERT INTO queue_op_attempts(op_id, attempt_id, conn_id, status, detail_json, created_at, updated_at)
       VALUES(@op_id, @attempt_id, @conn_id, @status, @detail_json, @t, @t)
       ON CONFLICT(op_id, attempt_id) DO UPDATE SET
         status=excluded.status,
         detail_json=excluded.detail_json,
         updated_at=excluded.updated_at,
         conn_id=COALESCE(excluded.conn_id, queue_op_attempts.conn_id)`,
    ).run({
      op_id: params.opId,
      attempt_id: params.attemptId,
      conn_id: params.connId ?? null,
      status: params.status,
      detail_json,
      t,
    });
  } catch {}
}

export function recordOpAttempt(
  db: QueueDB,
  params: {
    readonly opId: string;
    readonly attemptId: string;
    readonly connId?: string | null;
    readonly status: string;
    readonly detail?: unknown;
  },
): void {
  upsertOpAttempt(db, params);
}

export function claimNextOp(db: QueueDB, lockedBy: string, leaseMs = 30_000): OpRow | null {
  const t = nowMs();
  // Select a pending op whose txn is ready.
  // - Default: ops within the same txn are executed sequentially by op_seq.
  // - If `queue_op_dependencies` is populated, we only dispatch ops whose dependencies are all succeeded.
  const row = db
    .prepare(
      `SELECT o.*, x.dispatch_mode AS txn_dispatch_mode FROM queue_ops o
       JOIN queue_txns x ON x.txn_id = o.txn_id
       WHERE o.status = 'pending' AND o.next_attempt_at <= @t AND x.status IN ('ready','in_progress')
         AND (
           COALESCE(x.dispatch_mode, 'serial') != 'serial'
           OR (
             NOT EXISTS (SELECT 1 FROM queue_ops oi WHERE oi.txn_id = o.txn_id AND oi.status = 'in_flight')
             AND NOT EXISTS (SELECT 1 FROM queue_ops oprev WHERE oprev.txn_id = o.txn_id AND oprev.op_seq < o.op_seq AND oprev.status != 'succeeded')
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM queue_op_dependencies d
           JOIN queue_ops od ON od.op_id = d.depends_on_op_id
           WHERE d.op_id = o.op_id AND od.status != 'succeeded'
         )
       ORDER BY x.priority ASC, o.created_at ASC, o.op_seq ASC
       LIMIT 1`,
    )
    .get({ t }) as any;

  if (!row) return null;

  const attempt_id = randomUUID();
  const lease_expires_at = t + leaseMs;
  const upd = db.prepare(
    `UPDATE queue_ops
     SET status='in_flight',
         attempt_id=@attempt_id,
         locked_by=@locked_by,
         locked_at=@t,
         lease_expires_at=@lease_expires_at,
         updated_at=@t
     WHERE op_id=@op_id AND status='pending'`,
  );
  const res = upd.run({ attempt_id, locked_by: lockedBy, t, lease_expires_at, op_id: row.op_id });
  if (res.changes === 0) return null;

  // mark txn in progress
  db.prepare(
    `UPDATE queue_txns SET status='in_progress', updated_at=@t WHERE txn_id=@txn_id AND status!='in_progress'`,
  ).run({
    t,
    txn_id: row.txn_id,
  });

  upsertOpAttempt(db, {
    opId: String(row.op_id),
    attemptId: attempt_id,
    connId: lockedBy,
    status: 'claimed',
    detail: { lease_ms: leaseMs, claimed_at: t },
  });

  return { ...(row as OpRow), attempt_id, status: 'in_flight', locked_by: lockedBy, locked_at: t, lease_expires_at };
}

export function peekEligibleOps(db: QueueDB, peekLimit = 200): readonly OpRow[] {
  const t = nowMs();
  const limit = Math.max(1, Math.min(1000, Math.floor(peekLimit)));
  const rows = db
    .prepare(
      `SELECT o.*, x.dispatch_mode AS txn_dispatch_mode FROM queue_ops o
       JOIN queue_txns x ON x.txn_id = o.txn_id
       WHERE o.status = 'pending' AND o.next_attempt_at <= @t AND x.status IN ('ready','in_progress')
         AND (
           COALESCE(x.dispatch_mode, 'serial') != 'serial'
           OR (
             NOT EXISTS (SELECT 1 FROM queue_ops oi WHERE oi.txn_id = o.txn_id AND oi.status = 'in_flight')
             AND NOT EXISTS (SELECT 1 FROM queue_ops oprev WHERE oprev.txn_id = o.txn_id AND oprev.op_seq < o.op_seq AND oprev.status != 'succeeded')
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM queue_op_dependencies d
           JOIN queue_ops od ON od.op_id = d.depends_on_op_id
           WHERE d.op_id = o.op_id AND od.status != 'succeeded'
         )
       ORDER BY x.priority ASC, o.created_at ASC, o.op_seq ASC
       LIMIT ${limit}`,
    )
    .all({ t }) as any[];
  return rows as OpRow[];
}

export function claimOpById(db: QueueDB, opId: string, lockedBy: string, leaseMs = 30_000): OpRow | null {
  const t = nowMs();
  const row = db
    .prepare(
      `SELECT o.*, x.dispatch_mode AS txn_dispatch_mode FROM queue_ops o
       JOIN queue_txns x ON x.txn_id = o.txn_id
       WHERE o.op_id = @op_id AND o.status = 'pending' AND o.next_attempt_at <= @t AND x.status IN ('ready','in_progress')
         AND (
           COALESCE(x.dispatch_mode, 'serial') != 'serial'
           OR (
             NOT EXISTS (SELECT 1 FROM queue_ops oi WHERE oi.txn_id = o.txn_id AND oi.status = 'in_flight')
             AND NOT EXISTS (SELECT 1 FROM queue_ops oprev WHERE oprev.txn_id = o.txn_id AND oprev.op_seq < o.op_seq AND oprev.status != 'succeeded')
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM queue_op_dependencies d
           JOIN queue_ops od ON od.op_id = d.depends_on_op_id
           WHERE d.op_id = o.op_id AND od.status != 'succeeded'
         )
       LIMIT 1`,
    )
    .get({ t, op_id: opId }) as any;

  if (!row) return null;

  const attempt_id = randomUUID();
  const lease_expires_at = t + leaseMs;
  const upd = db.prepare(
    `UPDATE queue_ops
     SET status='in_flight',
         attempt_id=@attempt_id,
         locked_by=@locked_by,
         locked_at=@t,
         lease_expires_at=@lease_expires_at,
         updated_at=@t
     WHERE op_id=@op_id AND status='pending'`,
  );
  const res = upd.run({ attempt_id, locked_by: lockedBy, t, lease_expires_at, op_id: opId });
  if (res.changes === 0) return null;

  db.prepare(
    `UPDATE queue_txns SET status='in_progress', updated_at=@t WHERE txn_id=@txn_id AND status!='in_progress'`,
  ).run({
    t,
    txn_id: row.txn_id,
  });

  upsertOpAttempt(db, {
    opId: String(opId),
    attemptId: attempt_id,
    connId: lockedBy,
    status: 'claimed',
    detail: { lease_ms: leaseMs, claimed_at: t, mode: 'by_id' },
  });

  return { ...(row as OpRow), attempt_id, status: 'in_flight', locked_by: lockedBy, locked_at: t, lease_expires_at };
}

export function claimSelectedOpsBatch(
  db: QueueDB,
  params: {
    readonly lockedBy: string;
    readonly selected: readonly BatchClaimCandidate[];
    readonly defaultLeaseMs?: number | undefined;
  },
): readonly OpRow[] {
  const t = nowMs();
  const lockedBy = params.lockedBy;
  const defaultLeaseMs = params.defaultLeaseMs ?? 30_000;

  const trx = db.transaction(() => {
    const claimed: OpRow[] = [];
    const updateOp = db.prepare(
      `UPDATE queue_ops
       SET status='in_flight',
           attempt_id=@attempt_id,
           locked_by=@locked_by,
           locked_at=@t,
           lease_expires_at=@lease_expires_at,
           updated_at=@t
       WHERE op_id=@op_id AND status='pending'`,
    );
    const updateTxn = db.prepare(
      `UPDATE queue_txns SET status='in_progress', updated_at=@t WHERE txn_id=@txn_id AND status!='in_progress'`,
    );

    for (const candidate of params.selected) {
      const attempt_id = randomUUID();
      const leaseMs =
        typeof candidate.leaseMs === 'number' && Number.isFinite(candidate.leaseMs) && candidate.leaseMs > 0
          ? Math.floor(candidate.leaseMs)
          : defaultLeaseMs;
      const lease_expires_at = t + leaseMs;
      const res = updateOp.run({
        attempt_id,
        locked_by: lockedBy,
        t,
        lease_expires_at,
        op_id: candidate.op_id,
      });
      if (res.changes === 0) continue;

      updateTxn.run({ t, txn_id: candidate.txn_id });

      upsertOpAttempt(db, {
        opId: candidate.op_id,
        attemptId: attempt_id,
        connId: lockedBy,
        status: 'claimed',
        detail: { lease_ms: leaseMs, claimed_at: t, mode: 'batch' },
      });

      claimed.push({
        op_id: candidate.op_id,
        txn_id: candidate.txn_id,
        op_seq: candidate.op_seq,
        txn_dispatch_mode: candidate.txn_dispatch_mode ?? null,
        type: candidate.type,
        payload_json: candidate.payload_json,
        status: 'in_flight',
        idempotency_key: candidate.idempotency_key,
        op_hash: '',
        attempt_id,
        attempt_count: 0,
        max_attempts: 0,
        deliver_after: 0,
        next_attempt_at: 0,
        locked_by: lockedBy,
        locked_at: t,
        lease_expires_at,
        dead_reason: null,
        created_at: t,
        updated_at: t,
      });
    }

    return claimed;
  });

  return trx();
}

export function listInFlightOps(db: QueueDB, limit = 200): readonly OpRow[] {
  const t = nowMs();
  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = db
    .prepare(
      `SELECT o.*, x.dispatch_mode AS txn_dispatch_mode FROM queue_ops o
       JOIN queue_txns x ON x.txn_id = o.txn_id
       WHERE o.status='in_flight'
         AND (o.lease_expires_at IS NULL OR o.lease_expires_at > @t)
       ORDER BY o.locked_at ASC
       LIMIT ${lim}`,
    )
    .all({ t }) as any[];
  return rows as OpRow[];
}

export function ackSuccess(
  db: QueueDB,
  params: { readonly opId: string; readonly attemptId: string; readonly lockedBy: string; readonly result: any },
): AckResult {
  const t = nowMs();
  const trx = db.transaction(() => {
    const current = db
      .prepare(`SELECT txn_id, status, attempt_id, locked_by FROM queue_ops WHERE op_id=?`)
      .get(params.opId) as any;
    if (!current) {
      return { ok: false, op_id: params.opId, attempt_id: params.attemptId, reason: 'not_found' } satisfies AckResult;
    }

    const cur = {
      status: String(current.status ?? ''),
      attempt_id: (current.attempt_id as string | null) ?? null,
      locked_by: (current.locked_by as string | null) ?? null,
    };

    if (cur.attempt_id === params.attemptId && cur.locked_by === params.lockedBy && cur.status === 'succeeded') {
      return { ok: true, op_id: params.opId, attempt_id: params.attemptId, duplicate: true } satisfies AckResult;
    }

    if (cur.attempt_id !== params.attemptId) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'invalid_attempt',
        current: cur,
      } satisfies AckResult;
    }

    const res = db
      .prepare(
        `UPDATE queue_ops
         SET status='succeeded', locked_at=NULL, lease_expires_at=NULL, updated_at=@t
         WHERE op_id=@op_id AND status='in_flight' AND locked_by=@locked_by AND attempt_id=@attempt_id`,
      )
      .run({ t, op_id: params.opId, locked_by: params.lockedBy, attempt_id: params.attemptId });
    if (res.changes === 0) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'stale_ack',
        current: cur,
      } satisfies AckResult;
    }

    db.prepare(
      `INSERT OR REPLACE INTO queue_op_results(op_id, result_json, finished_at) VALUES(@op_id, @result_json, @t)`,
    ).run({
      op_id: params.opId,
      result_json: JSON.stringify(params.result ?? {}),
      t,
    });

    upsertOpAttempt(db, {
      opId: params.opId,
      attemptId: params.attemptId,
      connId: params.lockedBy,
      status: 'succeeded',
      detail: { acked_at: t },
    });

    const txn_id = String(current.txn_id);
    const remain = db
      .prepare(`SELECT 1 FROM queue_ops WHERE txn_id=? AND status!='succeeded' LIMIT 1`)
      .get(txn_id) as any;
    if (!remain) {
      db.prepare(`UPDATE queue_txns SET status='succeeded', finished_at=@t, updated_at=@t WHERE txn_id=@txn_id`).run({
        t,
        txn_id,
      });
    }

    return { ok: true, op_id: params.opId, attempt_id: params.attemptId, duplicate: false } satisfies AckResult;
  });
  return trx();
}

export function ackRetry(
  db: QueueDB,
  params: {
    readonly opId: string;
    readonly attemptId: string;
    readonly lockedBy: string;
    readonly error: { readonly code?: string; readonly message?: string; readonly retryAfterMs?: number };
  },
): AckResult {
  const t = nowMs();
  const trx = db.transaction(() => {
    const current = db
      .prepare(`SELECT txn_id, status, attempt_id, locked_by, attempt_count, max_attempts FROM queue_ops WHERE op_id=?`)
      .get(params.opId) as any;
    if (!current) {
      return { ok: false, op_id: params.opId, attempt_id: params.attemptId, reason: 'not_found' } satisfies AckResult;
    }

    const cur = {
      status: String(current.status ?? ''),
      attempt_id: (current.attempt_id as string | null) ?? null,
      locked_by: (current.locked_by as string | null) ?? null,
    };

    if (
      cur.attempt_id === params.attemptId &&
      cur.locked_by === params.lockedBy &&
      (cur.status === 'pending' || cur.status === 'dead')
    ) {
      return { ok: true, op_id: params.opId, attempt_id: params.attemptId, duplicate: true } satisfies AckResult;
    }

    if (cur.attempt_id !== params.attemptId) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'invalid_attempt',
        current: cur,
      } satisfies AckResult;
    }

    const attempt = Number(current.attempt_count ?? 0) + 1;
    const maxAttemptsRaw = Number(current.max_attempts ?? 10);
    const maxAttempts = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0 ? Math.floor(maxAttemptsRaw) : 10;

    if (attempt >= maxAttempts) {
      const reason = params.error.message ?? params.error.code ?? 'max attempts exceeded';
      const res = db
        .prepare(
          `UPDATE queue_ops
           SET status='dead',
               attempt_count=@attempt,
               dead_reason=@reason,
               locked_at=NULL,
               lease_expires_at=NULL,
               updated_at=@t
           WHERE op_id=@op_id AND status='in_flight' AND locked_by=@locked_by AND attempt_id=@attempt_id`,
        )
        .run({
          attempt,
          reason,
          t,
          op_id: params.opId,
          locked_by: params.lockedBy,
          attempt_id: params.attemptId,
        });

      if (res.changes === 0) {
        return {
          ok: false,
          op_id: params.opId,
          attempt_id: params.attemptId,
          reason: 'stale_ack',
          current: cur,
        } satisfies AckResult;
      }

      db.prepare(
        `INSERT OR REPLACE INTO queue_op_results(op_id, error_code, error_message, finished_at) VALUES(@op_id, @code, @message, @t)`,
      ).run({ op_id: params.opId, code: params.error.code ?? null, message: params.error.message ?? null, t });

      upsertOpAttempt(db, {
        opId: params.opId,
        attemptId: params.attemptId,
        connId: params.lockedBy,
        status: 'dead',
        detail: {
          acked_at: t,
          retry_after_ms: null,
          max_attempts: maxAttempts,
          exhausted_at_attempt: attempt,
        },
      });

      markTxnFailedAndCancelPendingOps(db, {
        txnId: String(current.txn_id),
        failedOpId: params.opId,
        reason,
        t,
      });

      return { ok: true, op_id: params.opId, attempt_id: params.attemptId, duplicate: false } satisfies AckResult;
    }

    const base = Math.min(60_000, Math.pow(2, attempt) * 1000);
    const jitter = Math.round(base * (0.1 + Math.random() * 0.2));
    const delay = params.error.retryAfterMs ?? base + jitter;
    const next = t + delay;

    const res = db
      .prepare(
        `UPDATE queue_ops
         SET status='pending',
             attempt_count=@attempt,
             next_attempt_at=@next,
             locked_at=NULL,
             lease_expires_at=NULL,
             updated_at=@t
         WHERE op_id=@op_id AND status='in_flight' AND locked_by=@locked_by AND attempt_id=@attempt_id`,
      )
      .run({ attempt, next, t, op_id: params.opId, locked_by: params.lockedBy, attempt_id: params.attemptId });

    if (res.changes === 0) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'stale_ack',
        current: cur,
      } satisfies AckResult;
    }

    db.prepare(
      `INSERT OR REPLACE INTO queue_op_results(op_id, error_code, error_message, finished_at) VALUES(@op_id, @code, @message, @t)`,
    ).run({ op_id: params.opId, code: params.error.code ?? null, message: params.error.message ?? null, t });

    upsertOpAttempt(db, {
      opId: params.opId,
      attemptId: params.attemptId,
      connId: params.lockedBy,
      status: 'retry',
      detail: { acked_at: t, retry_after_ms: delay },
    });

    return { ok: true, op_id: params.opId, attempt_id: params.attemptId, duplicate: false } satisfies AckResult;
  });
  return trx();
}

export function ackDead(
  db: QueueDB,
  params: {
    readonly opId: string;
    readonly attemptId: string;
    readonly lockedBy: string;
    readonly error: { readonly code?: string; readonly message?: string };
  },
): AckResult {
  const t = nowMs();
  const trx = db.transaction(() => {
    const current = db
      .prepare(`SELECT txn_id, status, attempt_id, locked_by FROM queue_ops WHERE op_id=?`)
      .get(params.opId) as any;
    if (!current) {
      return { ok: false, op_id: params.opId, attempt_id: params.attemptId, reason: 'not_found' } satisfies AckResult;
    }

    const cur = {
      status: String(current.status ?? ''),
      attempt_id: (current.attempt_id as string | null) ?? null,
      locked_by: (current.locked_by as string | null) ?? null,
    };

    if (cur.attempt_id === params.attemptId && cur.locked_by === params.lockedBy && cur.status === 'dead') {
      return { ok: true, op_id: params.opId, attempt_id: params.attemptId, duplicate: true } satisfies AckResult;
    }

    if (cur.attempt_id !== params.attemptId) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'invalid_attempt',
        current: cur,
      } satisfies AckResult;
    }

    const reason = params.error.message ?? params.error.code ?? 'dead';
    const res = db
      .prepare(
        `UPDATE queue_ops
         SET status='dead', dead_reason=@reason, locked_at=NULL, lease_expires_at=NULL, updated_at=@t
         WHERE op_id=@op_id AND status='in_flight' AND locked_by=@locked_by AND attempt_id=@attempt_id`,
      )
      .run({ reason, t, op_id: params.opId, locked_by: params.lockedBy, attempt_id: params.attemptId });
    if (res.changes === 0) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'stale_ack',
        current: cur,
      } satisfies AckResult;
    }

    db.prepare(
      `INSERT OR REPLACE INTO queue_op_results(op_id, error_code, error_message, finished_at) VALUES(@op_id, @code, @message, @t)`,
    ).run({ op_id: params.opId, code: params.error.code ?? null, message: params.error.message ?? null, t });

    upsertOpAttempt(db, {
      opId: params.opId,
      attemptId: params.attemptId,
      connId: params.lockedBy,
      status: 'dead',
      detail: { acked_at: t, error_code: params.error.code ?? null },
    });

    markTxnFailedAndCancelPendingOps(db, {
      txnId: String(current.txn_id),
      failedOpId: params.opId,
      reason,
      t,
    });

    return { ok: true, op_id: params.opId, attempt_id: params.attemptId, duplicate: false } satisfies AckResult;
  });
  return trx();
}

export function upsertIdMap(
  db: QueueDB,
  entries: { client_temp_id: string; remote_id: string; remote_type?: string; source_txn?: string }[],
) {
  const t = nowMs();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO queue_id_map(client_temp_id, remote_id, remote_type, source_txn, updated_at)
     VALUES(@client_temp_id, @remote_id, @remote_type, @source_txn, @t)`,
  );
  const get = db.prepare(
    `SELECT remote_id, remote_type, source_txn FROM queue_id_map WHERE client_temp_id=@client_temp_id LIMIT 1`,
  );
  const safeUpdate = db.prepare(
    `UPDATE queue_id_map
     SET remote_id=COALESCE(remote_id, @remote_id),
         remote_type=COALESCE(remote_type, @remote_type),
         source_txn=COALESCE(source_txn, @source_txn),
         updated_at=@t
     WHERE client_temp_id=@client_temp_id`,
  );
  const trx = db.transaction(() => {
    for (const e of entries) {
      const client_temp_id = typeof e?.client_temp_id === 'string' ? e.client_temp_id.trim() : '';
      const remote_id = typeof e?.remote_id === 'string' ? e.remote_id.trim() : '';
      if (!client_temp_id || !remote_id) continue;

      const remote_type = typeof e?.remote_type === 'string' ? e.remote_type.trim() : '';
      const source_txn = typeof e?.source_txn === 'string' ? e.source_txn.trim() : '';

      const inserted = insert.run({
        client_temp_id,
        remote_id,
        remote_type: remote_type || null,
        source_txn: source_txn || null,
        t,
      });
      if (inserted.changes > 0) continue;

      const existing = get.get({ client_temp_id }) as any;
      const existingRemoteId = typeof existing?.remote_id === 'string' ? existing.remote_id : null;
      if (existingRemoteId && existingRemoteId !== remote_id) {
        throw new IdMapConflictError({
          clientTempId: client_temp_id,
          existing: {
            remote_id: existingRemoteId,
            remote_type: typeof existing?.remote_type === 'string' ? existing.remote_type : null,
            source_txn: typeof existing?.source_txn === 'string' ? existing.source_txn : null,
          },
          incoming: {
            remote_id,
            remote_type: remote_type || null,
            source_txn: source_txn || null,
          },
        });
      }

      safeUpdate.run({
        client_temp_id,
        remote_id,
        remote_type: remote_type || null,
        source_txn: source_txn || null,
        t,
      });
    }
  });
  trx();
}

export function getRemoteIdsByClientTempIds(
  db: QueueDB,
  clientTempIds: readonly string[],
): Readonly<Record<string, string>> {
  const ids = clientTempIds.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
  if (ids.length === 0) return {};

  const uniq: string[] = [];
  for (const id of ids) if (!uniq.includes(id)) uniq.push(id);

  const placeholders = uniq.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT client_temp_id, remote_id FROM queue_id_map WHERE client_temp_id IN (${placeholders})`)
    .all(...uniq) as any[];

  const out: Record<string, string> = {};
  for (const r of rows) {
    const client_temp_id = typeof r?.client_temp_id === 'string' ? r.client_temp_id.trim() : '';
    const remote_id = typeof r?.remote_id === 'string' ? r.remote_id.trim() : '';
    if (!client_temp_id || !remote_id) continue;
    out[client_temp_id] = remote_id;
  }
  return out;
}

export function queueStats(db: QueueDB) {
  const now = nowMs();
  const q = (sql: string) => db.prepare(sql).get() as any;
  const pending =
    q(
      `SELECT COUNT(1) as c
       FROM queue_ops o
       JOIN queue_txns x ON x.txn_id = o.txn_id
       WHERE o.status='pending' AND o.next_attempt_at<=${now} AND x.status IN ('ready','in_progress')`,
    )?.c ?? 0;
  const in_flight = q(`SELECT COUNT(1) as c FROM queue_ops WHERE status='in_flight'`)?.c ?? 0;
  const dead = q(`SELECT COUNT(1) as c FROM queue_ops WHERE status='dead'`)?.c ?? 0;
  const ready_txns = q(`SELECT COUNT(1) as c FROM queue_txns WHERE status IN ('ready','in_progress')`)?.c ?? 0;
  return { pending, in_flight, dead, ready_txns };
}

export type ConflictClusterRisk = 'low' | 'medium' | 'high';

export type ConflictCluster = {
  readonly conflict_key: string;
  readonly op_count: number;
  readonly txn_count: number;
  readonly op_types: readonly string[];
  readonly sample_ops: readonly {
    readonly op_id: string;
    readonly txn_id: string;
    readonly op_seq: number;
    readonly op_type: string;
    readonly status: string;
  }[];
  readonly risk: ConflictClusterRisk;
  readonly note?: string;
};

export type QueueConflictsReport = {
  readonly peek_limit: number;
  readonly scanned_ops: number;
  readonly truncated: boolean;
  readonly clusters_total: number;
  readonly clusters_returned: number;
  readonly clusters_truncated: boolean;
  readonly clusters: readonly ConflictCluster[];
};

function riskScore(risk: ConflictClusterRisk): number {
  switch (risk) {
    case 'high':
      return 2;
    case 'medium':
      return 1;
    default:
      return 0;
  }
}

function computeConflictClusterRisk(params: {
  readonly conflictKey: string;
  readonly opTypes: ReadonlySet<string>;
  readonly opCount: number;
}): { readonly risk: ConflictClusterRisk; readonly note?: string } {
  const hasDelete = params.opTypes.has('delete_rem') || params.opTypes.has('delete_backup_artifact');
  if (hasDelete && params.opCount > 0) {
    return {
      risk: 'high',
      note: 'destructive delete op mixed with other ops; execution order matters and may require manual review',
    };
  }

  if (params.conflictKey.startsWith('global:')) {
    return { risk: 'medium', note: 'global conflict key; these operations should be serialized' };
  }

  if (params.opTypes.size > 1) {
    return { risk: 'medium' };
  }

  return { risk: 'low' };
}

export function queueConflicts(
  db: QueueDB,
  params?: { readonly peekLimit?: number | undefined; readonly maxClusters?: number | undefined },
): QueueConflictsReport {
  const t = nowMs();
  const peek_limit = Math.max(1, Math.min(5000, Math.floor(params?.peekLimit ?? 500)));
  const maxClusters = Math.max(1, Math.min(500, Math.floor(params?.maxClusters ?? 50)));

  const rows = db
    .prepare(
      `SELECT o.* FROM queue_ops o
       JOIN queue_txns x ON x.txn_id = o.txn_id
       WHERE o.status = 'pending' AND o.next_attempt_at <= @t AND x.status IN ('ready','in_progress')
       ORDER BY x.priority ASC, o.created_at ASC, o.op_seq ASC
       LIMIT ${peek_limit}`,
    )
    .all({ t }) as any[];

  const clusters = new Map<
    string,
    {
      readonly opIds: Set<string>;
      readonly txnIds: Set<string>;
      readonly opTypes: Set<string>;
      readonly sample_ops: Array<{
        readonly op_id: string;
        readonly txn_id: string;
        readonly op_seq: number;
        readonly op_type: string;
        readonly status: string;
      }>;
    }
  >();

  for (const r of rows) {
    const op_id = String(r.op_id ?? '');
    const txn_id = String(r.txn_id ?? '');
    const op_type = String(r.type ?? '');
    const op_seq = Number(r.op_seq ?? 0);
    const status = String(r.status ?? '');
    const payload = safeParseJson(String(r.payload_json ?? ''));

    const keys = deriveConflictKeys(op_type, payload);
    for (const k of keys) {
      const key = String(k ?? '').trim();
      if (!key) continue;
      let entry = clusters.get(key);
      if (!entry) {
        entry = { opIds: new Set<string>(), txnIds: new Set<string>(), opTypes: new Set<string>(), sample_ops: [] };
        clusters.set(key, entry);
      }

      entry.opTypes.add(op_type);
      entry.txnIds.add(txn_id);

      if (!entry.opIds.has(op_id)) {
        entry.opIds.add(op_id);
        if (entry.sample_ops.length < 5) {
          entry.sample_ops.push({ op_id, txn_id, op_seq, op_type, status });
        }
      }
    }
  }

  const out: ConflictCluster[] = [];
  for (const [conflictKey, entry] of clusters.entries()) {
    const op_count = entry.opIds.size;
    if (op_count < 2) continue;
    const txn_count = entry.txnIds.size;
    const op_types = Array.from(entry.opTypes).filter(Boolean).sort();

    const riskComputed = computeConflictClusterRisk({
      conflictKey,
      opTypes: entry.opTypes,
      opCount: op_count,
    });

    out.push({
      conflict_key: conflictKey,
      op_count,
      txn_count,
      op_types,
      sample_ops: entry.sample_ops,
      risk: riskComputed.risk,
      note: riskComputed.note,
    });
  }

  out.sort((a, b) => {
    const r = riskScore(b.risk) - riskScore(a.risk);
    if (r !== 0) return r;
    const c = b.op_count - a.op_count;
    if (c !== 0) return c;
    const t2 = b.txn_count - a.txn_count;
    if (t2 !== 0) return t2;
    return a.conflict_key.localeCompare(b.conflict_key);
  });

  const clusters_total = out.length;
  const clusters_truncated = clusters_total > maxClusters;
  const clusters_returned = Math.min(clusters_total, maxClusters);

  return {
    peek_limit,
    scanned_ops: rows.length,
    truncated: rows.length >= peek_limit,
    clusters_total,
    clusters_returned,
    clusters_truncated,
    clusters: out.slice(0, maxClusters),
  };
}

export function getTxnIdByOpId(db: QueueDB, op_id: string): string | undefined {
  const row = db.prepare(`SELECT txn_id FROM queue_ops WHERE op_id=?`).get(op_id) as any;
  return row?.txn_id as string | undefined;
}

export function recoverExpiredLeases(db: QueueDB) {
  const t = nowMs();
  const rows = db
    .prepare(
      `SELECT op_id, attempt_id, locked_by, lease_expires_at FROM queue_ops
       WHERE status='in_flight' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    )
    .all(t) as any[];
  if (!rows || rows.length === 0) return 0;
  const upd = db.prepare(
    `UPDATE queue_ops
     SET status='pending', locked_at=NULL, lease_expires_at=NULL, next_attempt_at=@t, updated_at=@t
     WHERE op_id=@op_id
       AND status='in_flight'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= @t
       AND attempt_id IS @attempt_id
       AND locked_by IS @locked_by`,
  );
  let recovered = 0;
  const trx = db.transaction(() => {
    for (const r of rows) {
      const opId = String(r.op_id);
      const attemptId = typeof r.attempt_id === 'string' ? r.attempt_id : '';
      const connId = typeof r.locked_by === 'string' ? r.locked_by : null;
      if (!attemptId) continue;
      const res = upd.run({ t, op_id: opId, attempt_id: attemptId, locked_by: connId });
      if (res.changes > 0) {
        recovered += 1;
        upsertOpAttempt(db, {
          opId,
          attemptId,
          connId,
          status: 'lease_expired',
          detail: { recovered_at: t, lease_expires_at: Number(r.lease_expires_at ?? 0) },
        });
      }
    }
  });
  trx();
  return recovered;
}

export type LeaseExtendResult =
  | { readonly ok: true; readonly op_id: string; readonly attempt_id: string; readonly lease_expires_at: number }
  | {
      readonly ok: false;
      readonly op_id: string;
      readonly attempt_id: string;
      readonly reason: 'not_found' | 'not_in_flight' | 'stale_attempt';
      readonly current?: {
        readonly status: string;
        readonly attempt_id: string | null;
        readonly locked_by: string | null;
        readonly lease_expires_at: number | null;
      };
    };

export function extendLease(
  db: QueueDB,
  params: { readonly opId: string; readonly attemptId: string; readonly lockedBy: string; readonly extendMs: number },
): LeaseExtendResult {
  const t = nowMs();
  const extendMs = Math.max(0, Math.floor(params.extendMs));
  const trx = db.transaction(() => {
    const current = db
      .prepare(`SELECT status, attempt_id, locked_by, lease_expires_at FROM queue_ops WHERE op_id=?`)
      .get(params.opId) as any;
    if (!current) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'not_found',
      } satisfies LeaseExtendResult;
    }

    const cur = {
      status: String(current.status ?? ''),
      attempt_id: (current.attempt_id as string | null) ?? null,
      locked_by: (current.locked_by as string | null) ?? null,
      lease_expires_at: typeof current.lease_expires_at === 'number' ? current.lease_expires_at : null,
    };

    if (cur.status !== 'in_flight') {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'not_in_flight',
        current: cur,
      } satisfies LeaseExtendResult;
    }

    if (cur.attempt_id !== params.attemptId || cur.locked_by !== params.lockedBy) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'stale_attempt',
        current: cur,
      } satisfies LeaseExtendResult;
    }

    const prevLease =
      typeof cur.lease_expires_at === 'number' && Number.isFinite(cur.lease_expires_at) ? cur.lease_expires_at : 0;
    const nextLease = Math.max(prevLease, t + extendMs);

    const res = db
      .prepare(
        `UPDATE queue_ops
         SET lease_expires_at=@lease_expires_at, updated_at=@t
         WHERE op_id=@op_id AND status='in_flight' AND locked_by=@locked_by AND attempt_id=@attempt_id`,
      )
      .run({
        lease_expires_at: nextLease,
        t,
        op_id: params.opId,
        locked_by: params.lockedBy,
        attempt_id: params.attemptId,
      });

    if (res.changes === 0) {
      return {
        ok: false,
        op_id: params.opId,
        attempt_id: params.attemptId,
        reason: 'stale_attempt',
        current: cur,
      } satisfies LeaseExtendResult;
    }

    upsertOpAttempt(db, {
      opId: params.opId,
      attemptId: params.attemptId,
      connId: params.lockedBy,
      status: 'lease_extended',
      detail: { extended_at: t, extend_ms: extendMs, lease_expires_at: nextLease },
    });

    return {
      ok: true,
      op_id: params.opId,
      attempt_id: params.attemptId,
      lease_expires_at: nextLease,
    } satisfies LeaseExtendResult;
  });

  return trx();
}
