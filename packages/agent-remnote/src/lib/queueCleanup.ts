import type { QueueDB } from '../internal/queue/index.js';

export type QueueCleanupStatus = 'failed' | 'aborted' | 'succeeded';

export type QueueCleanupItem = {
  readonly txn_id: string;
  readonly status: QueueCleanupStatus;
  readonly op_count: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly finished_at: number | null;
};

export type QueueCleanupPreview = {
  readonly statuses: readonly QueueCleanupStatus[];
  readonly older_than_ms?: number | undefined;
  readonly limit: number;
  readonly txns: number;
  readonly ops: number;
  readonly items: readonly QueueCleanupItem[];
};

export type QueueCleanupResult = QueueCleanupPreview & {
  readonly deleted_txns: number;
  readonly deleted_ops: number;
};

const DEFAULT_STATUSES: readonly QueueCleanupStatus[] = ['failed', 'aborted'];
const ALLOWED_STATUSES = new Set<string>(['failed', 'aborted', 'succeeded']);

function normalizeStatuses(input: readonly QueueCleanupStatus[] | undefined): readonly QueueCleanupStatus[] {
  const source = input && input.length > 0 ? input : DEFAULT_STATUSES;
  const out: QueueCleanupStatus[] = [];
  for (const raw of source) {
    const status = String(raw ?? '').trim();
    if (!ALLOWED_STATUSES.has(status)) continue;
    if (!out.includes(status as QueueCleanupStatus)) out.push(status as QueueCleanupStatus);
  }
  return out.length > 0 ? out : DEFAULT_STATUSES;
}

function normalizeLimit(input: number | undefined): number {
  const n = Number(input ?? 1000);
  return Number.isFinite(n) ? Math.max(1, Math.min(10_000, Math.floor(n))) : 1000;
}

export function previewQueueCleanup(
  db: QueueDB,
  params?: {
    readonly statuses?: readonly QueueCleanupStatus[] | undefined;
    readonly olderThanMs?: number | undefined;
    readonly limit?: number | undefined;
  },
): QueueCleanupPreview {
  const statuses = normalizeStatuses(params?.statuses);
  const limit = normalizeLimit(params?.limit);
  const olderThanMsRaw = Number(params?.olderThanMs);
  const olderThanMs = Number.isFinite(olderThanMsRaw) && olderThanMsRaw >= 0 ? Math.floor(olderThanMsRaw) : undefined;

  const where: string[] = [`x.status IN (${statuses.map(() => '?').join(',')})`];
  const args: unknown[] = [...statuses];
  if (olderThanMs !== undefined) {
    where.push(`x.updated_at <= ?`);
    args.push(Date.now() - olderThanMs);
  }

  const rows = db
    .prepare(
      `SELECT x.txn_id, x.status, COUNT(o.op_id) AS op_count, x.created_at, x.updated_at, x.finished_at
         FROM queue_txns x
         LEFT JOIN queue_ops o ON o.txn_id = x.txn_id
        WHERE ${where.join(' AND ')}
        GROUP BY x.txn_id
        ORDER BY x.updated_at ASC, x.created_at ASC
        LIMIT ?`,
    )
    .all(...args, limit) as any[];

  const items = rows.map((row) => ({
    txn_id: String(row.txn_id),
    status: String(row.status) as QueueCleanupStatus,
    op_count: Number(row.op_count ?? 0),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
  }));

  return {
    statuses,
    ...(olderThanMs !== undefined ? { older_than_ms: olderThanMs } : {}),
    limit,
    txns: items.length,
    ops: items.reduce((sum, item) => sum + item.op_count, 0),
    items,
  };
}

export function cleanupQueueTxns(
  db: QueueDB,
  params?: {
    readonly statuses?: readonly QueueCleanupStatus[] | undefined;
    readonly olderThanMs?: number | undefined;
    readonly limit?: number | undefined;
  },
): QueueCleanupResult {
  const preview = previewQueueCleanup(db, params);
  if (preview.items.length === 0) return { ...preview, deleted_txns: 0, deleted_ops: 0 };

  const txnIds = preview.items.map((item) => item.txn_id);
  const res = db.prepare(`DELETE FROM queue_txns WHERE txn_id IN (${txnIds.map(() => '?').join(',')})`).run(...txnIds);

  return {
    ...preview,
    deleted_txns: Number(res.changes ?? 0),
    deleted_ops: preview.ops,
  };
}
