// community module (41 §2.1 M11; 40 §19). Two Nest modules share this folder:
//   CommunityModule     (global, every deployable) CommunityRead for the search
//                       indexer, the Discover feed and the notification
//                       dispatcher, and the media attachment targets post
//                       (P*/V* of the author organization), question and
//                       answer (their author).
//   CommunityApiModule  §19 operations on the api host (community-api.module.ts)
import { Global, Injectable, Module, Optional, type OnModuleInit } from '@nestjs/common';
import { AttachmentTargets } from '#modules/media/interface/media.js';
import { DbCommunityRead } from './infrastructure/community-read.js';
import { CommunityRead } from './interface/community.js';
import { CommunityAdminRegistrations } from './application/admin-registrations.js';

@Injectable()
export class CommunityRegistrations implements OnModuleInit {
  constructor(@Optional() private readonly targets?: AttachmentTargets) {}

  onModuleInit(): void {
    this.targets?.register('post', async (scope, id) => {
      const p = await scope.db
        .selectFrom('community.posts')
        .select('author_organization_id')
        .where('id', '=', id)
        .where('status', '<>', 'removed')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return p ? { owner: { type: 'organization', id: p.author_organization_id }, groups: ['P*', 'V*'] } : null;
    });
    this.targets?.register('question', async (scope, id) => {
      const q = await scope.db
        .selectFrom('community.questions')
        .select('author_user_id')
        .where('id', '=', id)
        .where('author_user_id', '=', scope.context.userId ?? '00000000-0000-7000-8000-000000000000')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return q ? { owner: { type: 'user', id: q.author_user_id }, groups: [] } : null;
    });
    this.targets?.register('answer', async (scope, id) => {
      const a = await scope.db
        .selectFrom('community.answers')
        .select('author_user_id')
        .where('id', '=', id)
        .where('author_user_id', '=', scope.context.userId ?? '00000000-0000-7000-8000-000000000000')
        .where('status', '<>', 'removed')
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return a ? { owner: { type: 'user', id: a.author_user_id }, groups: [] } : null;
    });
  }
}

@Global()
@Module({
  providers: [{ provide: CommunityRead, useClass: DbCommunityRead }, CommunityRegistrations, CommunityAdminRegistrations],
  exports: [CommunityRead],
})
export class CommunityModule {}
