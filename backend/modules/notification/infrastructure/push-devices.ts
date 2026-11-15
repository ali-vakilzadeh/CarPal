// PushDevicesRead (backend S23, BR-16): a user's push devices for admin.user_sessions, without the token.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { iso, isoOrNull } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { PushDevicesRead, type StaffPushDeviceView } from '../interface/push-devices.js';

@Injectable()
export class DbPushDevices extends PushDevicesRead {
  async forUser(scope: TxScope, userId: string, limit: number): Promise<StaffPushDeviceView[]> {
    const rows = await scope.db
      .selectFrom('notification.push_device_tokens')
      .select(['id', 'platform', 'app_version', 'locale', 'status', 'created_at', 'last_seen_at'])
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .orderBy(sql`status = 'active'`, 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform as StaffPushDeviceView['platform'],
      app_version: r.app_version,
      locale: r.locale,
      status: r.status as StaffPushDeviceView['status'],
      created_at: iso(r.created_at),
      last_seen_at: isoOrNull(r.last_seen_at),
    }));
  }
}
