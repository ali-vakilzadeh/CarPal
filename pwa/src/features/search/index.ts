// Search (P6: S-SHARED-01 search entry, W-SRCH-01 results with map): the request model and URL rules (request.ts),
// browser memory (storage.ts), the result card shared with the directory pages and the client screens.
export * from './request';
export { SearchScreen, type SearchScreenProps } from './search-page';
export { ResultCardView, resultHref, distanceText } from './result-card';
export { RecentSearches } from './recent';
export { addRecent, readRecent, readStoredSearch, storeSearch, type RecentSearch } from './storage';
export { UnderstoodAs } from './chips';
export { FilterPanel } from './filter-panel';
export { LocationChip, currentPosition, useLocationConsent } from './location';
export { GuestCarChip, QueryField, useGuestCarLabel } from './search-bar';
export { SafetyNotice } from './search-states';
export { sessionKey, useResultEvent, useSearchActions, type SearchView } from './use-search';
export * from './filters';
