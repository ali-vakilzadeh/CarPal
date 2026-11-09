// Typed admin API client (AC3.T5). Client components: <ApiProvider>, useApiQuery / useApiMutation / useSession /
// useLogout (query.tsx); the generated operation map and role table live in ./generated.
export { createApiClient, fillPath, buildSearch, reasonHeader, purposeOf, pollUntil, EtagCache } from './client';
export type {
  AccessPurpose,
  ApiClient,
  ApiClientOptions,
  CallArgs,
  CallResult,
  Outcome,
  PurposeKind,
  Transport,
  TransportRequest,
} from './client';
export { ApiProblem, problemFrom, parseStepUp, type ApiErrorCode, type StepUpChallenge } from './problem';
export { RETRY, retryDelay, isRetryable, OperationGate } from './retry';
export { uuidv7 } from './uuid';
export { loginUrl, reauthUrl, safeNextPath, saveIntent, consumeIntent, fetchSession, SESSION_QUERY_KEY, type SessionView } from './session';
