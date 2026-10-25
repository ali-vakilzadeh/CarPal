// Typed API client (GD-09). Client components: <ApiProvider>, useApiQuery / useApiMutation / useApiInfiniteQuery,
// useSession; server components use src/server/ssr/api.ts.
export { createApiClient, selectRoute, fillPath, buildSearch, EtagCache, POW_PURPOSE } from './client';
export type { ApiClient, ApiClientOptions, CallArgs, CallResult, Transport, TransportRequest, PowPurpose } from './client';
export { ApiProblem, problemFrom, parseStepUp, type ApiErrorCode, type StepUpChallenge } from './problem';
export { RETRY, retryDelay, isRetryable, OperationGate } from './retry';
export { uuidv7 } from './uuid';
