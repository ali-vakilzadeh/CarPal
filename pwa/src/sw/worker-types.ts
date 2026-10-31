// The few service-worker globals the worker uses. The project's TypeScript program uses the DOM library (pages and
// components); the WebWorker library cannot be loaded next to it, so the worker declares what it needs here.

export interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}

export interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}

export interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
  readonly source: { postMessage(message: unknown): void } | null;
  readonly ports: readonly MessagePort[];
}

export interface PushEvent extends ExtendableEvent {
  readonly data: { text(): string } | null;
}

export interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification;
}

export interface WindowClient {
  readonly url: string;
  focus(): Promise<WindowClient>;
  navigate(url: string): Promise<WindowClient | null>;
}

export interface Clients {
  matchAll(o?: { type?: 'window' | 'all'; includeUncontrolled?: boolean }): Promise<readonly WindowClient[]>;
  openWindow(url: string): Promise<WindowClient | null>;
  claim(): Promise<void>;
}

export interface WorkerScope {
  readonly location: Location;
  readonly registration: ServiceWorkerRegistration;
  readonly clients: Clients;
  readonly caches: CacheStorage;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', l: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', l: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', l: (e: ExtendableMessageEvent) => void): void;
  addEventListener(type: 'push', l: (e: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', l: (e: NotificationEvent) => void): void;
  fetch: typeof fetch;
}
