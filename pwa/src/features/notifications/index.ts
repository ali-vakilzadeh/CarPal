// W-NOTIF-01 notifications (P9.T1): the header bell, the page, the in-app texts and the deep-link table.
export { NotificationsBell, NotificationsScreen, NotificationItem, useUnreadCount } from './notifications';
export { countFailures, unreadBadge, unreadPollDelay, UNREAD_POLL_MS } from './polling';
// templateVars: the CarPal Workshop renders business notifications with the same value words (provider plan PW1.T6).
export { renderNotification, isConsumerTemplate, templateVars, CONSUMER_TEMPLATE_KEYS } from './catalog';
export { notificationDestination, NOTIFICATION_TABS, TAB_CATEGORIES } from './links';
