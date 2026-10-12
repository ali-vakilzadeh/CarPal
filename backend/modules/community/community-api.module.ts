// Community operations (40 §19) on the api host, except feed.discover
// (discovery module). Needs CommunityModule, OrganizationModule,
// IdentityModule, MediaModule, TaxonomyModule, TrustModule and VehicleModule
// (global) in the same application.
import { Module } from '@nestjs/common';
import {
  CommentsCreateHandler,
  CommentsDeleteHandler,
  CommentsListHandler,
  CommunityTargets,
  Reactions,
  ReactionsDeleteHandler,
  ReactionsPutHandler,
} from './application/comment-ops.js';
import { CommunityCards } from './application/common.js';
import {
  FavoritesDeleteHandler,
  FavoritesListHandler,
  FavoritesPutHandler,
  FollowsDeleteHandler,
  FollowsListHandler,
  FollowsPutHandler,
  ShowcasesGetHandler,
} from './application/follow-ops.js';
import {
  PostRules,
  PostsCreateHandler,
  PostsDeleteHandler,
  PostsOrgListHandler,
  PostsPublicListHandler,
  PostsPublishHandler,
  PostsUpdateHandler,
  PostViews,
} from './application/post-ops.js';
import {
  AnswersAcceptHandler,
  AnswersCreateHandler,
  AnswersDeleteHandler,
  QnaViews,
  QuestionsCreateHandler,
  QuestionsGetHandler,
  QuestionsSearchHandler,
  QuestionsUpdateHandler,
} from './application/qna-ops.js';

@Module({
  providers: [
    CommunityCards,
    CommunityTargets,
    Reactions,
    PostViews,
    PostRules,
    QnaViews,
    // follows, favourites, showcases
    FollowsListHandler,
    FollowsPutHandler,
    FollowsDeleteHandler,
    FavoritesListHandler,
    FavoritesPutHandler,
    FavoritesDeleteHandler,
    ShowcasesGetHandler,
    // posts
    PostsOrgListHandler,
    PostsCreateHandler,
    PostsUpdateHandler,
    PostsPublishHandler,
    PostsDeleteHandler,
    PostsPublicListHandler,
    // comments and reactions
    CommentsListHandler,
    CommentsCreateHandler,
    CommentsDeleteHandler,
    ReactionsPutHandler,
    ReactionsDeleteHandler,
    // questions and answers
    QuestionsCreateHandler,
    QuestionsSearchHandler,
    QuestionsGetHandler,
    QuestionsUpdateHandler,
    AnswersCreateHandler,
    AnswersAcceptHandler,
    AnswersDeleteHandler,
  ],
})
export class CommunityApiModule {}
