function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function findRemoteId(idMap: unknown, clientTempId: string | undefined): string | undefined {
  if (!clientTempId || !Array.isArray(idMap)) return undefined;
  const match = idMap.find((entry: any) => String(entry?.client_temp_id ?? '') === clientTempId);
  const remoteId = normalizeString(match?.remote_id);
  return remoteId || undefined;
}

export function parseResultJson(raw: any): any {
  const resultJson = raw?.result_json;
  if (typeof resultJson === 'string' && resultJson.trim()) {
    try {
      return JSON.parse(resultJson);
    } catch {}
  }
  return null;
}

function resultErrorCode(op: any): string {
  return normalizeString(op?.result?.error_code);
}

export function buildPartialCreateReceipt(params: {
  readonly txnId: string;
  readonly detail: any;
  readonly remClientTempId?: string;
  readonly portalClientTempId?: string;
  readonly intent: {
    readonly isDocument: boolean;
    readonly contentPlacement: { readonly kind: string };
    readonly source: { readonly kind: string; readonly sourceOrigin?: string };
    readonly portalPlacement: { readonly kind: string };
  };
}): any | undefined {
  const idMap = Array.isArray(params.detail?.id_map) ? params.detail.id_map : [];
  const remId = findRemoteId(idMap, params.remClientTempId);
  if (!remId) return undefined;

  const ops = Array.isArray(params.detail?.ops) ? params.detail.ops : [];
  const nonPortalFailed = ops.some((op: any) => {
    if (String(op?.type ?? '') === 'create_portal') return false;
    if (String(op?.status ?? '') === 'succeeded') return false;
    return resultErrorCode(op) !== 'TXN_FAILED';
  });
  const portalOp = ops.find((op: any) => String(op?.type ?? '') === 'create_portal');
  const portalFailed = portalOp && String(opPortalStatus(portalOp)) !== 'succeeded';
  if (nonPortalFailed || !portalFailed) return undefined;

  const portalResult = parseResultJson(portalOp?.result);
  const portalError =
    normalizeString(portalResult?.error) ||
    normalizeString(portalOp?.result?.error_message) ||
    'portal insertion failed after durable target creation';
  const portalRemId = findRemoteId(idMap, params.portalClientTempId);

  return {
    partial_success: true,
    txn_id: params.txnId,
    op_ids: ops.map((op: any) => String(op?.op_id ?? '')).filter(Boolean),
    status: 'partial_success',
    id_map: idMap,
    ...(params.remClientTempId ? { rem_client_temp_id: params.remClientTempId } : {}),
    ...(params.portalClientTempId ? { portal_client_temp_id: params.portalClientTempId } : {}),
    rem_id: remId,
    durable_target: {
      rem_id: remId,
      is_document: params.intent.isDocument,
      placement_kind: params.intent.contentPlacement.kind,
    },
    source_context: {
      source_kind: params.intent.source.kind,
      ...(params.intent.source.kind === 'targets' ? { source_origin: params.intent.source.sourceOrigin } : {}),
    },
    portal: {
      requested: params.intent.portalPlacement.kind !== 'none',
      created: false,
      ...(portalRemId ? { rem_id: portalRemId } : {}),
      ...(params.intent.portalPlacement.kind !== 'none' ? { placement_kind: params.intent.portalPlacement.kind } : {}),
    },
    warnings: [portalError],
    nextActions: [`agent-remnote queue inspect --txn ${params.txnId}`],
  };
}

function opPortalStatus(op: any): string {
  return String(op?.status ?? '').trim();
}

export function buildMovePromotionReceipt(params: {
  readonly out: any;
  readonly detail: any;
  readonly intent: {
    readonly remId: string;
    readonly isDocument: boolean;
    readonly contentPlacement: { readonly kind: string };
    readonly portalPlacement: { readonly kind: string };
  };
  readonly portalClientTempId?: string;
}): any {
  const idMap = Array.isArray(params.detail?.id_map)
    ? params.detail.id_map
    : Array.isArray(params.out?.id_map)
      ? params.out.id_map
      : [];
  const portalRemId = findRemoteId(idMap, params.portalClientTempId);
  const moveOp = Array.isArray(params.detail?.ops)
    ? params.detail.ops.find((op: any) => String(op?.type ?? '').trim() === 'move_rem')
    : Array.isArray(params.out?.ops)
      ? params.out.ops.find((op: any) => String(op?.type ?? '').trim() === 'move_rem')
      : null;
  const moveResult = parseResultJson(moveOp?.result);

  const warnings = [
    ...((Array.isArray(params.out?.warnings) ? params.out.warnings : []) as string[]),
    ...((Array.isArray(moveResult?.warnings) ? moveResult.warnings : []) as string[]),
  ];
  const nextActions = [
    ...((Array.isArray(params.out?.nextActions) ? params.out.nextActions : []) as string[]),
    ...((Array.isArray(moveResult?.nextActions) ? moveResult.nextActions : []) as string[]),
  ];

  const inPlacePortalId = normalizeString(moveResult?.portal_id) || undefined;
  const portalPlacementKind =
    params.intent.portalPlacement.kind === 'none' ? undefined : params.intent.portalPlacement.kind;
  const portalCreated =
    params.intent.portalPlacement.kind === 'in_place_single_rem'
      ? moveResult?.portal_created === true
      : Boolean(portalRemId);
  const effectivePortalRemId =
    params.intent.portalPlacement.kind === 'in_place_single_rem' ? inPlacePortalId : portalRemId;

  return {
    ...(params.out as any),
    rem_id: params.intent.remId,
    durable_target: {
      rem_id: params.intent.remId,
      is_document: params.intent.isDocument,
      placement_kind: params.intent.contentPlacement.kind,
    },
    source_context: {
      source_kind: 'targets',
      source_origin: 'move_single_rem',
      ...(normalizeString(moveResult?.source_parent_id)
        ? { parent_id: normalizeString(moveResult?.source_parent_id) }
        : {}),
    },
    portal: {
      requested: params.intent.portalPlacement.kind !== 'none',
      created: portalCreated,
      ...(effectivePortalRemId ? { rem_id: effectivePortalRemId } : {}),
      ...(portalPlacementKind ? { placement_kind: portalPlacementKind } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(nextActions.length > 0 ? { nextActions } : {}),
  };
}

export function extractReplaceBackupSummary(txnDetail: any):
  | {
      readonly policy: string;
      readonly deleted: boolean;
      readonly rem_id: string | null;
      readonly hidden?: boolean | undefined;
      readonly cleanup_state?: string | undefined;
    }
  | undefined {
  const ops = Array.isArray(txnDetail?.ops) ? txnDetail.ops : [];
  const replaceOp = ops.find((op: any) =>
    ['replace_children_with_markdown', 'replace_selection_with_markdown'].includes(String(op?.type ?? '').trim()),
  );
  if (!replaceOp) return undefined;

  const result = parseResultJson(replaceOp.result);
  if (!result || typeof result !== 'object') return undefined;

  return {
    policy:
      typeof result.backup_policy === 'string' && result.backup_policy.trim() ? result.backup_policy.trim() : 'none',
    deleted: result.backup_deleted !== false,
    rem_id:
      typeof result.backup_rem_id === 'string' && result.backup_rem_id.trim() ? result.backup_rem_id.trim() : null,
    ...(result.backup_hidden === true ? { hidden: true } : {}),
    ...(typeof result.backup_cleanup_state === 'string' && result.backup_cleanup_state.trim()
      ? { cleanup_state: result.backup_cleanup_state.trim() }
      : {}),
  };
}
