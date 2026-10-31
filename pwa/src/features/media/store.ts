'use client';
// Uploads in this tab (P7.T2): a small external store, so an upload keeps going when the form that started it goes
// away — Docs/21 C-GARAGE-05 "upload in progress (save still allowed; uploads finish in background)". Screens read
// the uploads of their group (e.g. "record:<vehicle id>") and wait for each one with whenReady() before attaching it.
import type { MediaAsset, UploadPurpose } from '@carpal/api-contracts';
import { useSyncExternalStore } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { convertHeicToJpeg, inspectFile, putSigned, sha256Base64 } from './browser-io';
import { initialState, runUpload, waitForScan, type UploadDeps, type UploadFailure, type UploadState } from './engine';

export interface UploadItem {
  id: string;
  group: string;
  purpose: UploadPurpose;
  name: string;
  state: UploadState;
  /** Object URL of the chosen image for the thumbnail (revoked on remove). */
  previewUrl: string | null;
}

interface Entry extends UploadItem {
  controller: AbortController;
  api: ApiClient;
  ownerId: string;
  ownerType?: 'user' | 'organization';
  original: File;
  settled: Promise<UploadState>;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let snapshot: readonly UploadItem[] = [];
let seq = 0;

function publish() {
  snapshot = [...entries.values()].map(({ id, group, purpose, name, state, previewUrl }) => ({
    id,
    group,
    purpose,
    name,
    state,
    previewUrl,
  }));
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Overridable for tests (the engine's browser parts). */
export let browserDeps: Omit<UploadDeps, 'api'> = {
  inspect: inspectFile,
  convertHeic: convertHeicToJpeg,
  sha256: sha256Base64,
  put: putSigned,
};
export function setBrowserDeps(deps: Omit<UploadDeps, 'api'>) {
  browserDeps = deps;
}

function launch(e: Entry): Promise<UploadState> {
  return runUpload(
    { file: e.original, purpose: e.purpose, ownerId: e.ownerId, ownerType: e.ownerType, signal: e.controller.signal },
    { ...browserDeps, api: e.api },
    (s) => {
      const cur = entries.get(e.id);
      if (!cur) return;
      cur.state = s;
      publish();
    },
  ).catch(() => e.state);
}

export function startUploads(
  files: Iterable<File>,
  o: { group: string; purpose: UploadPurpose; ownerId: string; ownerType?: 'user' | 'organization'; api: ApiClient },
): string[] {
  const ids: string[] = [];
  for (const file of files) {
    const id = `up-${++seq}`;
    const previewUrl = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
    const entry: Entry = {
      id,
      group: o.group,
      purpose: o.purpose,
      name: file.name,
      state: initialState(file),
      previewUrl,
      controller: new AbortController(),
      api: o.api,
      ownerId: o.ownerId,
      ownerType: o.ownerType,
      original: file,
      settled: Promise.resolve(initialState(file)),
    };
    entries.set(id, entry);
    entry.settled = launch(entry);
    ids.push(id);
  }
  publish();
  return ids;
}

export function retryUpload(id: string) {
  const e = entries.get(id);
  if (!e || e.state.phase !== 'failed') return;
  e.controller = new AbortController();
  e.state = initialState(e.original);
  e.settled = launch(e);
  publish();
}

/** After a timeout: look at the scan once more without sending the file again. */
export function checkAgain(id: string) {
  const e = entries.get(id);
  const mediaId = e?.state.asset?.id;
  if (!e || !mediaId) return retryUpload(id);
  const set = (patch: Partial<UploadState>) => {
    e.state = { ...e.state, ...patch };
    publish();
    return e.state;
  };
  set({ phase: 'processing', failure: null });
  e.settled = waitForScan(mediaId, e.state, set, (failure: UploadFailure) => set({ phase: 'failed', failure }), { api: e.api });
}

/**
 * Removes an upload from the list. A finished asset that nothing uses yet is deleted (best effort), unless `keep`
 * says it was attached somewhere.
 */
export function removeUpload(id: string, o: { keep?: boolean } = {}) {
  const e = entries.get(id);
  if (!e) return;
  e.controller.abort();
  entries.delete(id);
  if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
  if (!o.keep && e.state.phase === 'ready' && e.state.asset) {
    void e.api.api('media.delete', { path: { media_id: e.state.asset.id } }).catch(() => undefined);
  }
  publish();
}

/**
 * Hands a group's uploads over to whoever waits on them (whenReady): they leave the group's list but keep running,
 * and drop out of the store once settled — their assets are kept (they are being attached).
 */
export function releaseGroup(group: string) {
  for (const e of [...entries.values()]) {
    if (e.group !== group) continue;
    e.group = `released:${group}`;
    void e.settled.then(() => {
      if (entries.get(e.id) !== e) return;
      entries.delete(e.id);
      if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
      publish();
    });
  }
  publish();
}

/** Throws a group's uploads away (a discarded draft): stops them and deletes finished assets. */
export function discardGroup(group: string) {
  for (const e of [...entries.values()]) if (e.group === group) removeUpload(e.id);
}

/** The ready asset of an upload, or null when it failed or was removed. */
export async function whenReady(id: string): Promise<MediaAsset | null> {
  const e = entries.get(id);
  if (!e) return null;
  const s = await e.settled;
  return s.phase === 'ready' ? s.asset : null;
}

export function uploadsOf(group: string): readonly UploadItem[] {
  return snapshot.filter((u) => u.group === group);
}

const EMPTY: readonly UploadItem[] = [];
const cache = new Map<string, { from: readonly UploadItem[]; list: readonly UploadItem[] }>();

export function useUploads(group: string): readonly UploadItem[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      const hit = cache.get(group);
      if (hit && hit.from === snapshot) return hit.list;
      const list = snapshot.some((u) => u.group === group) ? uploadsOf(group) : EMPTY;
      const same = hit && hit.list.length === list.length && hit.list.every((u, i) => u === list[i]);
      const next = same ? hit.list : list;
      cache.set(group, { from: snapshot, list: next });
      return next;
    },
    () => EMPTY,
  );
}

/** Test helper: forget every upload. */
export function resetUploads() {
  for (const e of entries.values()) e.controller.abort();
  entries.clear();
  cache.clear();
  publish();
}
