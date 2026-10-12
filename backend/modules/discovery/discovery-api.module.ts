// Discovery operations on the api host (40 §14.2 and feed.discover).
import { Module } from '@nestjs/common';
import { FeedDiscoverHandler } from './application/feed-ops.js';
import { MapPinsHandler } from './application/map-ops.js';
import {
  SafetyCheckHandler,
  SearchPageHandler,
  SearchRefineHandler,
  SearchResultEventHandler,
  SearchRunHandler,
} from './application/search-ops.js';

@Module({
  providers: [
    SearchRunHandler,
    SearchPageHandler,
    SearchRefineHandler,
    SearchResultEventHandler,
    MapPinsHandler,
    SafetyCheckHandler,
    FeedDiscoverHandler,
  ],
})
export class DiscoveryApiModule {}
