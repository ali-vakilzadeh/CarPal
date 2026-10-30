// W-NOTIF-01 notifications (P9.T1): the header bell, the page, the in-app texts and the deep-link table.
export { NotificationsBell, NotificationsScreen, NotificationItem, useUnreadCount } from './notifications';
export { unreadBadge, unreadPollDelay, UNREAD_POLL_MS } from './polling';
export { renderNotification, isConsumerTemplate, CONSUMER_TEMPLATE_KEYS } from './catalog';
export { notificationDestination, NOTIFICATION_TABS, TAB_CATEGORIES } from './links';
