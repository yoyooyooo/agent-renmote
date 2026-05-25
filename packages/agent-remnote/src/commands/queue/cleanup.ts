import { Command } from '@effect/cli';
import * as Options from '@effect/cli/Options';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { failInRemoteMode } from '../_remoteMode.js';
import { writeFailure, writeSuccess } from '../_shared.js';
import { AppConfig } from '../../services/AppConfig.js';
import { CliError } from '../../services/Errors.js';
import { Queue } from '../../services/Queue.js';

type CleanupStatus = 'failed' | 'aborted' | 'succeeded';

function optionToUndefined<A>(opt: Option.Option<A>): A | undefined {
  return Option.isSome(opt) ? opt.value : undefined;
}

function buildApplyAction(params: {
  readonly statuses: readonly CleanupStatus[];
  readonly olderThanHours?: number | undefined;
  readonly limit: number;
}): string {
  const statusArgs = params.statuses.map((status) => `--status ${status}`).join(' ');
  const olderArg =
    params.olderThanHours === undefined ? '' : ` --older-than-hours ${Math.floor(params.olderThanHours)}`;
  return `agent-remnote queue cleanup --apply ${statusArgs}${olderArg} --limit ${params.limit}`.trim();
}

export const queueCleanupCommand = Command.make(
  'cleanup',
  {
    apply: Options.boolean('apply'),
    status: Options.choice('status', ['failed', 'aborted', 'succeeded'] as const).pipe(Options.repeated),
    olderThanHours: Options.integer('older-than-hours').pipe(Options.optional, Options.map(optionToUndefined)),
    limit: Options.integer('limit').pipe(Options.withDefault(1000)),
  },
  ({ apply, status, olderThanHours, limit }) =>
    Effect.gen(function* () {
      if (olderThanHours !== undefined && olderThanHours < 0) {
        return yield* Effect.fail(
          new CliError({
            code: 'INVALID_ARGS',
            message: '--older-than-hours must be a non-negative integer',
            exitCode: 2,
          }),
        );
      }
      if (limit < 1) {
        return yield* Effect.fail(
          new CliError({
            code: 'INVALID_ARGS',
            message: '--limit must be >= 1',
            exitCode: 2,
          }),
        );
      }

      yield* failInRemoteMode({
        command: 'queue cleanup',
        reason: 'queue cleanup mutates the local store database directly',
      });

      const cfg = yield* AppConfig;
      const queue = yield* Queue;
      const statuses = status.length > 0 ? (status as readonly CleanupStatus[]) : (['failed', 'aborted'] as const);
      const olderThanMs = olderThanHours === undefined ? undefined : olderThanHours * 60 * 60 * 1000;
      const result = yield* queue.cleanup({
        dbPath: cfg.storeDb,
        apply,
        statuses,
        olderThanMs,
        limit,
      });

      const data = {
        dry_run: !apply,
        ...result,
        ...(apply
          ? {}
          : {
              nextActions:
                (result as any).txns > 0
                  ? [buildApplyAction({ statuses, olderThanHours, limit: (result as any).limit ?? limit })]
                  : undefined,
            }),
      };

      yield* writeSuccess({
        data,
        ids: Array.isArray((result as any).items) ? (result as any).items.map((item: any) => String(item.txn_id)) : [],
        md: [
          `- dry_run: ${data.dry_run ? 'true' : 'false'}`,
          `- statuses: ${statuses.join(',')}`,
          `- txns: ${(result as any).txns ?? 0}`,
          `- ops: ${(result as any).ops ?? 0}`,
          ...(apply ? [`- deleted_txns: ${(result as any).deleted_txns ?? 0}`] : []),
        ].join('\n'),
      });
    }).pipe(Effect.catchAll(writeFailure)),
).pipe(Command.withDescription('Dry-run by default. Use --apply to delete terminal queue transactions.'));
