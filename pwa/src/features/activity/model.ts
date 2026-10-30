// W-ME-01 My Activity view model (P9.T5): tabs and what a requester may do with a stock inquiry (Docs/40 §13.3:
// cancel while it is open, "I picked it up" once the vendor answered or reserved).
import type { InquiryStatus, StockInquiry } from '@carpal/api-contracts';

export const ACTIVITY_TABS = ['reviews', 'posts', 'questions', 'inquiries', 'reports'] as const;
export type ActivityTab = (typeof ACTIVITY_TABS)[number];

export function isActivityTab(v: string | null | undefined): v is ActivityTab {
  return !!v && (ACTIVITY_TABS as readonly string[]).includes(v);
}

const OPEN: readonly InquiryStatus[] = ['sent', 'answered', 'reserved'];

export function inquiryActions(i: Pick<StockInquiry, 'status'>): { cancel: boolean; pickedUp: boolean; message: boolean } {
  const open = OPEN.includes(i.status);
  return { cancel: open, pickedUp: i.status === 'answered' || i.status === 'reserved', message: open };
}

export function inquiryTone(status: InquiryStatus): 'neutral' | 'signal' | 'success' | 'danger' | 'accent' {
  switch (status) {
    case 'answered':
      return 'accent';
    case 'reserved':
      return 'signal';
    case 'completed':
      return 'success';
    case 'unavailable':
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}
