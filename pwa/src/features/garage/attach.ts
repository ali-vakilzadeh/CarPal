'use client';
// Attaches finished uploads of a group as they become ready (record evidence, issue photos): each ready upload is
// handed to `attach` once and then leaves the upload list (its asset stays, it is used now).
import type { MediaAsset } from '@carpal/api-contracts';
import { useEffect, useRef, useState } from 'react';
import { removeUpload, useUploads } from '@/features/media';

export function useAttachWhenReady(group: string, attach: ((asset: MediaAsset) => Promise<void>) | null) {
  const uploads = useUploads(group);
  const handled = useRef(new Set<string>());
  const [failed, setFailed] = useState(0);
  useEffect(() => {
    if (!attach) return;
    for (const u of uploads) {
      if (u.state.phase !== 'ready' || !u.state.asset || handled.current.has(u.id)) continue;
      handled.current.add(u.id);
      const asset = u.state.asset;
      attach(asset)
        .then(() => removeUpload(u.id, { keep: true }))
        .catch(() => {
          handled.current.delete(u.id);
          setFailed((n) => n + 1);
        });
    }
  }, [uploads, attach]);
  return { failed };
}
