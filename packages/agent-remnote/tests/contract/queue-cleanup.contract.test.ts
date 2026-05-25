import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { enqueueTxn, openQueueDb } from '../../src/internal/queue/index.js';
import { runCli } from '../helpers/runCli.js';

function parseJson(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Expected JSON stdout');
  return JSON.parse(trimmed);
}

describe('cli contract: queue cleanup', () => {
  it('dry-runs terminal failed/aborted txn cleanup by default', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-remnote-queue-cleanup-'));
    const storeDb = path.join(tmpDir, 'store.sqlite');

    try {
      const db = openQueueDb(storeDb);
      try {
        const failedTxn = enqueueTxn(db, [{ type: 'update_text', payload: { rem_id: 'dead', text: 'x' } }]);
        const abortedTxn = enqueueTxn(db, [{ type: 'update_text', payload: { rem_id: 'aborted', text: 'x' } }]);
        const readyTxn = enqueueTxn(db, [{ type: 'update_text', payload: { rem_id: 'ready', text: 'x' } }]);

        db.prepare(`UPDATE queue_txns SET status='failed', finished_at=updated_at WHERE txn_id=?`).run(failedTxn);
        db.prepare(`UPDATE queue_txns SET status='aborted', finished_at=updated_at WHERE txn_id=?`).run(abortedTxn);
        expect(readyTxn).toMatch(/[0-9a-f-]{36}/);
      } finally {
        db.close();
      }

      const res = await runCli(['--json', '--store-db', storeDb, 'queue', 'cleanup'], {
        env: { REMNOTE_TMUX_REFRESH: '0' },
        timeoutMs: 15_000,
      });

      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe('');
      const parsed = parseJson(res.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.dry_run).toBe(true);
      expect(parsed.data.txns).toBe(2);
      expect(parsed.data.ops).toBe(2);
      expect(parsed.data.statuses).toEqual(['failed', 'aborted']);

      const db2 = openQueueDb(storeDb);
      try {
        const txns = db2.prepare(`SELECT COUNT(1) AS c FROM queue_txns`).get() as any;
        const ops = db2.prepare(`SELECT COUNT(1) AS c FROM queue_ops`).get() as any;
        expect(Number(txns.c)).toBe(3);
        expect(Number(ops.c)).toBe(3);
      } finally {
        db2.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('deletes terminal failed/aborted txns with --apply and leaves active txns intact', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-remnote-queue-cleanup-'));
    const storeDb = path.join(tmpDir, 'store.sqlite');

    try {
      const db = openQueueDb(storeDb);
      try {
        const failedTxn = enqueueTxn(db, [{ type: 'update_text', payload: { rem_id: 'dead', text: 'x' } }]);
        const abortedTxn = enqueueTxn(db, [{ type: 'update_text', payload: { rem_id: 'aborted', text: 'x' } }]);
        const readyTxn = enqueueTxn(db, [{ type: 'update_text', payload: { rem_id: 'ready', text: 'x' } }]);

        db.prepare(`UPDATE queue_txns SET status='failed', finished_at=updated_at WHERE txn_id=?`).run(failedTxn);
        db.prepare(`UPDATE queue_txns SET status='aborted', finished_at=updated_at WHERE txn_id=?`).run(abortedTxn);

        const res = await runCli(['--json', '--store-db', storeDb, 'queue', 'cleanup', '--apply'], {
          env: { REMNOTE_TMUX_REFRESH: '0' },
          timeoutMs: 15_000,
        });

        expect(res.exitCode).toBe(0);
        expect(res.stderr).toBe('');
        const parsed = parseJson(res.stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.data.dry_run).toBe(false);
        expect(parsed.data.deleted_txns).toBe(2);
        expect(parsed.data.deleted_ops).toBe(2);

        const remaining = db.prepare(`SELECT txn_id, status FROM queue_txns ORDER BY created_at ASC`).all() as any[];
        expect(remaining).toEqual([{ txn_id: readyTxn, status: 'ready' }]);

        const remainingOps = db.prepare(`SELECT COUNT(1) AS c FROM queue_ops WHERE txn_id=?`).get(readyTxn) as any;
        expect(Number(remainingOps.c)).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
