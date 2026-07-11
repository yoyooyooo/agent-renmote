import { describe, expect, it } from 'vitest';

import { buildPartialCreateReceipt } from '../../src/lib/business-semantics/receiptBuilders.js';

describe('receipt builders', () => {
  it('keeps rem create partial success when txn cleanup cancels later non-portal ops', () => {
    const receipt = buildPartialCreateReceipt({
      txnId: 'txn-1',
      remClientTempId: 'tmp:target',
      portalClientTempId: 'tmp:portal',
      intent: {
        isDocument: false,
        contentPlacement: { kind: 'standalone' },
        source: { kind: 'markdown' },
        portalPlacement: { kind: 'at' },
      },
      detail: {
        id_map: [{ client_temp_id: 'tmp:target', remote_id: 'RID-target', remote_type: 'rem' }],
        ops: [
          { op_id: 'op-create', type: 'create_rem', status: 'succeeded' },
          {
            op_id: 'op-tree',
            type: 'create_tree_with_markdown',
            status: 'dead',
            result: { error_code: 'TXN_FAILED', error_message: 'portal insertion failed in test' },
          },
          {
            op_id: 'op-portal',
            type: 'create_portal',
            status: 'dead',
            result: { error_code: 'PORTAL_FAILED', error_message: 'portal insertion failed in test' },
          },
        ],
      },
    });

    expect(receipt?.partial_success).toBe(true);
    expect(receipt?.durable_target?.rem_id).toBe('RID-target');
    expect(receipt?.portal?.created).toBe(false);
    expect(String(receipt?.warnings?.join(' '))).toContain('portal insertion failed');
  });
});
