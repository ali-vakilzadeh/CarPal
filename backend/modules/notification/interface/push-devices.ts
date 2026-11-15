// A user's push devices for staff (backend S23, admin console BR-16; 40 admin.user_sessions, StaffPushDevice): the
// identity module lists them next to the sessions on A-USR-02 Sessions & devices. Never the device token.
import type { TxScope } from '#libs/tenancy/index.js';

/** 40 StaffPushDevice. */
export interface StaffPushDeviceView {
  id: string;
  platform: 'ios' | 'android' | 'web';
  app_version: string | null;
  locale: string | null;
  status: 'active' | 'revoked';
  created_at: string;
  last_seen_at: string | null;
}

export abstract class PushDevicesRead {
  /** The user's devices, active first, then newest; at most `limit` (staff transaction). */
  abstract forUser(scope: TxScope, userId: string, limit: number): Promise<StaffPushDeviceView[]>;
}
