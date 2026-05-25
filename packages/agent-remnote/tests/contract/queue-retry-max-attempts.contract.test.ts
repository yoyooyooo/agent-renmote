import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ackRetry, claimNextOp, enqueueTxn, openQueueDb } from '../../src/internal/queue/index.js';

describe('queue contract: retry respects max_attempts', () => {
  it('marks op dead and txn failed when retry exceeds max_attempts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-remnote-retry-max-'));
    const dbPath = path.join(tmpDir, 'store.sqlite');

    try {
      const db = openQueueDb(dbPath);
      try {
        const txnId = enqueueTxn(
          db,
          [{ type: 'update_text', payload: { rem_id: 'r1', text: 'hello' }, maxAttempts: 1 }],
          { dispatchMode: 'serial' },
        );

        const claimed = claimNextOp(db, 'conn-1', 30_000);
        expect(claimed).not.toBeNull();

        const ack = ackRetry(db, {
          opId: String(claimed!.op_id),
          attemptId: String(claimed!.attempt_id),
          lockedBy: 'conn-1',
          error: { code: 'EXEC_ERROR', message: 'boom' },
        });
        expect(ack.ok).toBe(true);

        const op = db
          .prepare(
            `SELECT status, attempt_count, dead_reason, locked_at, lease_expires_at FROM queue_ops WHERE op_id=?`,
          )
          .get(claimed!.op_id) as any;
        expect(String(op.status)).toBe('dead');
        expect(Number(op.attempt_count)).toBe(1);
        expect(String(op.dead_reason)).toContain('boom');
        expect(op.locked_at).toBeNull();
        expect(op.lease_expires_at).toBeNull();

        const txn = db.prepare(`SELECT status FROM queue_txns WHERE txn_id=?`).get(txnId) as any;
        expect(String(txn.status)).toBe('failed');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('cancels remaining pending ops when a serial txn reaches a terminal failure', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-remnote-retry-max-'));
    const dbPath = path.join(tmpDir, 'store.sqlite');

    try {
      const db = openQueueDb(dbPath);
      try {
        const txnId = enqueueTxn(
          db,
          [
            { type: 'update_text', payload: { rem_id: 'r1', text: 'first' }, maxAttempts: 1 },
            { type: 'update_text', payload: { rem_id: 'r2', text: 'second' }, maxAttempts: 1 },
          ],
          { dispatchMode: 'serial' },
        );

        const claimed = claimNextOp(db, 'conn-1', 30_000);
        expect(claimed).not.toBeNull();

        const ack = ackRetry(db, {
          opId: String(claimed!.op_id),
          attemptId: String(claimed!.attempt_id),
          lockedBy: 'conn-1',
          error: { code: 'EXEC_ERROR', message: 'boom' },
        });
        expect(ack.ok).toBe(true);

        const rows = db
          .prepare(`SELECT op_seq, status, dead_reason FROM queue_ops WHERE txn_id=? ORDER BY op_seq ASC`)
          .all(txnId) as any[];

        expect(rows.map((row) => String(row.status))).toEqual(['dead', 'dead']);
        expect(String(rows[0].dead_reason)).toContain('boom');
        expect(String(rows[1].dead_reason)).toContain('txn_failed');
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
