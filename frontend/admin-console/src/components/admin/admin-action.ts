'use client';
// useAdminAction (AC5.T2/T4, GD-11, SEC-ADM-3): the one way kit screens send a mutating admin operation. It refuses
// to send an RSN operation without a valid reason (3–500 characters; the ReasonDialog builds it), runs the call
// through the step-up (an AAL3 / STEP_UP_REQUIRED answer saves the action in the BFF and repeats it once after the
// security key), and reports the outcome: applied, waiting for a second staff member (202 PendingChange; kept in the
// in-memory "my requests" list), accepted as a background job, or a problem the screen explains
// (SELF_APPROVAL_FORBIDDEN, expired/decided, someone changed it meanwhile).
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingChange } from '@carpal/api-contracts';
import { useIntentHandler, useStepUp } from '@/features/shell';
import type { CallArgs, CallRest, Outcome } from '@/lib/api/client';
import { ADMIN_OPERATIONS, type AdminOperationId, type AdminResponse } from '@/lib/api/generated';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { isValidReason } from '@/lib/config/reasons';

export type ActionState<T> =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'stepping-up' }
  | { status: 'done'; outcome: Outcome<T> }
  | { status: 'failed'; problem: ApiProblem };

/** The args a kit action sends: the reason is required for RSN operations (type and runtime). */
export type ActionArgs<Id extends AdminOperationId> = CallArgs<Id> & { reason: string };

export class ReasonMissingError extends Error {
  constructor(opId: string) {
    super(`${opId}: a reason of 3-500 characters is required (SEC-ADM-3)`);
    this.name = 'ReasonMissingError';
  }
}

/** Four-eyes changes this staff member requested in this tab (memory only, cleared with the cache, GD-12). */
export const MY_CHANGES_KEY = ['kit', 'my-four-eyes-changes'] as const;

export function rememberMyChange(queryClient: QueryClient, change: PendingChange): void {
  const list = queryClient.getQueryData<PendingChange[]>(MY_CHANGES_KEY) ?? [];
  queryClient.setQueryData<PendingChange[]>(MY_CHANGES_KEY, [change, ...list.filter((c) => c.change_id !== change.change_id)].slice(0, 50));
}

/** Intent type of a replayed action (a-z, digits, '_' and '.'). */
export const actionIntentType = (opId: AdminOperationId) => `act.${opId}`;

interface IntentDraft {
  args: Record<string, unknown>;
}

export function useAdminAction<Id extends AdminOperationId>(
  opId: Id,
  o: { onOutcome?: (outcome: Outcome<AdminResponse<Id>>) => void; target?: string } = {},
) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const [state, setState] = useState<ActionState<AdminResponse<Id>>>({ status: 'idle' });
  const op = ADMIN_OPERATIONS[opId];
  const options = useRef(o);
  useEffect(() => {
    options.current = o;
  });

  const send = useCallback(
    async (args: ActionArgs<Id>, replay: boolean): Promise<ActionState<AdminResponse<Id>>> => {
      if (op.reason && !isValidReason(args.reason)) throw new ReasonMissingError(opId);
      setState({ status: 'busy' });
      // The signal cannot be saved for a replay; everything else is plain data (ids, body, purpose, reason).
      const { signal: _signal, ...plain } = args as ActionArgs<Id> & { signal?: AbortSignal };
      const run = () => api.act(opId, ...([plain] as unknown as CallRest<Id>));
      let next: ActionState<AdminResponse<Id>>;
      try {
        if (replay) next = { status: 'done', outcome: await run() };
        else {
          const r = await stepUp({
            type: actionIntentType(opId),
            ...(options.current.target ? { target: options.current.target.slice(0, 200) } : {}),
            draft: { args: plain } satisfies IntentDraft,
            run,
          });
          next = r.steppingUp ? { status: 'stepping-up' } : { status: 'done', outcome: r.value };
        }
      } catch (err) {
        if (!(err instanceof ApiProblem)) throw err;
        next = { status: 'failed', problem: err };
      }
      if (next.status === 'done' && next.outcome.kind === 'pending') rememberMyChange(queryClient, next.outcome.change);
      setState(next);
      if (next.status === 'done') options.current.onOutcome?.(next.outcome);
      return next;
    },
    [api, opId, op.reason, queryClient, stepUp],
  );

  // After the security key: repeat the saved action once, with the same arguments and reason.
  useIntentHandler<IntentDraft>(actionIntentType(opId), async (intent) => {
    const args = intent.draft?.args as ActionArgs<Id> | undefined;
    if (!args) return;
    await send(args, true);
  });

  const run = useCallback((args: ActionArgs<Id>) => send(args, false), [send]);
  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return { run, reset, state };
}
