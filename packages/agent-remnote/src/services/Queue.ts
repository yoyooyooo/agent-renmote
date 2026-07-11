import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { CliError, isCliError } from './Errors.js';
import {
  cleanupQueueTxns as applyQueueCleanup,
  previewQueueCleanup,
  type QueueCleanupStatus,
} from '../lib/queueCleanup.js';

import {
  enqueueTxn,
  getTxnIdByOpId,
  openQueueDb,
  QueueSchemaError,
  queueConflicts as getQueueConflicts,
  queueStats as getQueueStats,
} from '../adapters/core.js';

export type QueueStats = ReturnType<typeof getQueueStats>;
export type QueueConflictsReport = ReturnType<typeof getQueueConflicts>;
export type QueueCleanupPreview = ReturnType<typeof previewQueueCleanup>;
export type QueueCleanupResult = ReturnType<typeof applyQueueCleanup>;

export type EnqueueOpInput = {
  readonly type: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string | undefined;
  readonly maxAttempts?: number | undefined;
  readonly deliverAfterMs?: number | undefined;
};

export type EnqueueTxnOptions = {
  readonly priority?: number | undefined;
  readonly clientId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly dispatchMode?: 'serial' | 'conflict_parallel' | undefined;
  readonly meta?: unknown;
};

export type InspectResult = {
  readonly txn: any;
  readonly ops: readonly any[];
  readonly id_map: readonly any[];
};

export interface QueueService {
  readonly enqueue: (params: {
    readonly dbPath: string;
    readonly ops: readonly EnqueueOpInput[];
    readonly options?: EnqueueTxnOptions | undefined;
  }) => Effect.Effect<
    { readonly txn_id: string; readonly op_ids: readonly string[]; readonly deduped?: boolean },
    CliError
  >;
  readonly stats: (params: { readonly dbPath: string }) => Effect.Effect<QueueStats, CliError>;
  readonly conflicts: (params: {
    readonly dbPath: string;
    readonly limit?: number | undefined;
    readonly maxClusters?: number | undefined;
  }) => Effect.Effect<
    QueueConflictsReport & { readonly warnings?: readonly string[]; readonly nextActions?: readonly string[] },
    CliError
  >;
  readonly inspect: (params: {
    readonly dbPath: string;
    readonly txnId?: string | undefined;
    readonly opId?: string | undefined;
  }) => Effect.Effect<InspectResult, CliError>;
  readonly cleanup: (params: {
    readonly dbPath: string;
    readonly apply?: boolean | undefined;
    readonly statuses?: readonly QueueCleanupStatus[] | undefined;
    readonly olderThanMs?: number | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<QueueCleanupPreview | QueueCleanupResult, CliError>;
}

export class Queue extends Context.Tag('Queue')<Queue, QueueService>() {}

function safeParseJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function cliErrorFromQueueSchema(dbPath: string, error: QueueSchemaError): CliError {
  const code =
    error.code === 'QUEUE_SCHEMA_NEWER'
      ? 'QUEUE_SCHEMA_NEWER'
      : error.code === 'QUEUE_SCHEMA_INVALID'
        ? 'QUEUE_SCHEMA_INVALID'
        : 'QUEUE_SCHEMA_UNKNOWN';
  return new CliError({
    code,
    message: error.message,
    exitCode: 1,
    details: { db_path: dbPath, ...(error.details || {}) },
    hint: [
      ...(Array.isArray(error.nextActions) ? error.nextActions : []),
      'Override the store db path with --store-db (or set REMNOTE_STORE_DB)',
    ],
  });
}

function isTxnIdempotencyKeyConflict(error: unknown): boolean {
  const anyError = error as any;
  const code = typeof anyError?.code === 'string' ? anyError.code : '';
  const message = typeof anyError?.message === 'string' ? anyError.message : '';
  return (
    (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') &&
    (message.includes('queue_txns.idempotency_key') || message.includes('txns.idempotency_key'))
  );
}

export const QueueLive = Layer.succeed(Queue, {
  enqueue: ({ dbPath, ops, options }) =>
    Effect.try({
      try: () => {
        const db = openQueueDb(dbPath);
        try {
          try {
            const txn_id = enqueueTxn(db, ops as any, options as any);
            const opRows = db
              .prepare(`SELECT op_id FROM queue_ops WHERE txn_id=? ORDER BY op_seq ASC`)
              .all(txn_id) as any[];
            const op_ids = opRows.map((r) => String(r.op_id));
            return { txn_id, op_ids };
          } catch (error) {
            const idempotencyKey = options?.idempotencyKey?.trim();
            if (idempotencyKey && isTxnIdempotencyKeyConflict(error)) {
              const existing = db
                .prepare(`SELECT txn_id FROM queue_txns WHERE idempotency_key=?`)
                .get(idempotencyKey) as any;
              const txn_id = existing?.txn_id ? String(existing.txn_id) : '';
              if (txn_id) {
                const opRows = db
                  .prepare(`SELECT op_id FROM queue_ops WHERE txn_id=? ORDER BY op_seq ASC`)
                  .all(txn_id) as any[];
                const op_ids = opRows.map((r) => String(r.op_id));
                return { txn_id, op_ids, deduped: true };
              }
            }
            throw error;
          }
        } finally {
          db.close();
        }
      },
      catch: (error) => {
        if (isCliError(error)) return error;
        if (error instanceof QueueSchemaError) return cliErrorFromQueueSchema(dbPath, error);
        return new CliError({
          code: 'QUEUE_UNAVAILABLE',
          message: 'Store database is unavailable',
          exitCode: 1,
          details: { db_path: dbPath, error: String((error as any)?.message || error) },
          hint: [
            'agent-remnote doctor',
            'agent-remnote config print',
            'Override the store db path with --store-db (or set REMNOTE_STORE_DB)',
          ],
        });
      },
    }),
  stats: ({ dbPath }) =>
    Effect.try({
      try: () => {
        const db = openQueueDb(dbPath);
        try {
          return getQueueStats(db);
        } finally {
          db.close();
        }
      },
      catch: (error) => {
        if (isCliError(error)) return error;
        if (error instanceof QueueSchemaError) return cliErrorFromQueueSchema(dbPath, error);
        return new CliError({
          code: 'QUEUE_UNAVAILABLE',
          message: 'Store database is unavailable',
          exitCode: 1,
          details: { db_path: dbPath, error: String((error as any)?.message || error) },
          hint: [
            'agent-remnote doctor',
            'agent-remnote config print',
            'Override the store db path with --store-db (or set REMNOTE_STORE_DB)',
          ],
        });
      },
    }),
  conflicts: ({ dbPath, limit, maxClusters }) =>
    Effect.try({
      try: () => {
        const db = openQueueDb(dbPath);
        try {
          const report = getQueueConflicts(db, { peekLimit: limit, maxClusters });

          const warnings: string[] = [];
          if ((report as any)?.truncated) {
            warnings.push(
              `Only the first ${(report as any).peek_limit ?? ''} pending ops were scanned; increase --limit for a wider scan`,
            );
          }
          if ((report as any)?.clusters_truncated) {
            warnings.push(
              `Only the top ${(report as any).clusters_returned ?? ''} conflict clusters are shown; increase --max-clusters to show more`,
            );
          }

          const txnIds = new Set<string>();
          const clusters = Array.isArray((report as any)?.clusters) ? ((report as any).clusters as any[]) : [];
          for (const c of clusters) {
            const sampleOps = Array.isArray((c as any)?.sample_ops) ? ((c as any).sample_ops as any[]) : [];
            for (const o of sampleOps) {
              const txnId = typeof o?.txn_id === 'string' ? o.txn_id.trim() : '';
              if (!txnId) continue;
              txnIds.add(txnId);
              if (txnIds.size >= 3) break;
            }
            if (txnIds.size >= 3) break;
          }

          const nextActions: string[] = ['agent-remnote queue stats'];
          for (const txnId of txnIds) {
            nextActions.push(`agent-remnote queue inspect --txn ${txnId}`);
            nextActions.push(`agent-remnote queue progress --txn ${txnId}`);
          }

          return { ...(report as any), warnings, nextActions } as any;
        } finally {
          db.close();
        }
      },
      catch: (error) => {
        if (isCliError(error)) return error;
        if (error instanceof QueueSchemaError) return cliErrorFromQueueSchema(dbPath, error);
        return new CliError({
          code: 'QUEUE_UNAVAILABLE',
          message: 'Store database is unavailable',
          exitCode: 1,
          details: { db_path: dbPath, error: String((error as any)?.message || error) },
          hint: [
            'agent-remnote doctor',
            'agent-remnote config print',
            'Override the store db path with --store-db (or set REMNOTE_STORE_DB)',
          ],
        });
      },
    }),
  inspect: ({ dbPath, txnId, opId }) =>
    Effect.try({
      try: () => {
        const db = openQueueDb(dbPath);
        try {
          let resolvedTxnId = txnId;
          if (!resolvedTxnId && opId) {
            resolvedTxnId = getTxnIdByOpId(db, opId);
          }
          if (!resolvedTxnId) {
            throw new CliError({
              code: 'INVALID_ARGS',
              message: 'You must provide either --txn or --op',
              exitCode: 2,
            });
          }

          const txn = db.prepare(`SELECT * FROM queue_txns WHERE txn_id=?`).get(resolvedTxnId) as any;
          if (!txn) {
            throw new CliError({
              code: 'INVALID_ARGS',
              message: `Transaction not found: ${resolvedTxnId}`,
              exitCode: 2,
            });
          }

          const ops = db
            .prepare(`SELECT * FROM queue_ops WHERE txn_id=? ORDER BY op_seq ASC`)
            .all(resolvedTxnId) as any[];
          const results =
            ops.length === 0
              ? []
              : (db
                  .prepare(`SELECT * FROM queue_op_results WHERE op_id IN (${ops.map(() => '?').join(',')})`)
                  .all(...ops.map((o) => o.op_id)) as any[]);
          const resMap = new Map<string, any>();
          for (const r of results) resMap.set(String(r.op_id), r);

          const idMap = db.prepare(`SELECT * FROM queue_id_map WHERE source_txn=?`).all(resolvedTxnId) as any[];

          const detail = ops.map((o) => ({
            op_id: String(o.op_id),
            seq: o.op_seq,
            type: o.type,
            status: o.status,
            attempts: o.attempt_count,
            next_attempt_at: o.next_attempt_at,
            payload: safeParseJson(o.payload_json),
            result: resMap.get(String(o.op_id)) || null,
          }));

          return { txn, ops: detail, id_map: idMap };
        } finally {
          db.close();
        }
      },
      catch: (error) => {
        if (isCliError(error)) return error;
        if (error instanceof QueueSchemaError) return cliErrorFromQueueSchema(dbPath, error);
        return new CliError({
          code: 'QUEUE_UNAVAILABLE',
          message: 'Store database is unavailable',
          exitCode: 1,
          details: { db_path: dbPath, error: String((error as any)?.message || error) },
          hint: [
            'agent-remnote doctor',
            'agent-remnote config print',
            'Override the store db path with --store-db (or set REMNOTE_STORE_DB)',
          ],
        });
      },
    }),
  cleanup: ({ dbPath, apply, statuses, olderThanMs, limit }) =>
    Effect.try({
      try: () => {
        const db = openQueueDb(dbPath);
        try {
          const params = { statuses, olderThanMs, limit };
          return apply ? applyQueueCleanup(db, params) : previewQueueCleanup(db, params);
        } finally {
          db.close();
        }
      },
      catch: (error) => {
        if (isCliError(error)) return error;
        if (error instanceof QueueSchemaError) return cliErrorFromQueueSchema(dbPath, error);
        return new CliError({
          code: 'QUEUE_UNAVAILABLE',
          message: 'Store database is unavailable',
          exitCode: 1,
          details: { db_path: dbPath, error: String((error as any)?.message || error) },
          hint: [
            'agent-remnote doctor',
            'agent-remnote config print',
            'Override the store db path with --store-db (or set REMNOTE_STORE_DB)',
          ],
        });
      },
    }),
} satisfies QueueService);
