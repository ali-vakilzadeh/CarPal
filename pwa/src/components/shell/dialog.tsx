'use client';
// Modal surfaces on the native <dialog> element: showModal() gives the top layer, an inert page behind, a focus
// trap and Esc; closing returns focus to the opener. variant 'modal' = centred box (640 px max, Docs/22),
// 'drawer' = full-height panel from the inline-start edge (guest menu on phones), 'sheet' = bottom sheet on phones.
// Clicking the scrim closes. The caller owns `open` (often from the URL, see url-modal.tsx).
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from '@/components/ds/cx';
import { IconButton } from '@/components/ds/icon-button';
import { useT } from '@/lib/i18n/client';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  variant?: 'modal' | 'drawer' | 'sheet';
  /** Hides the visual heading (it stays the accessible name). */
  hideTitle?: boolean;
  className?: string;
  /** Extra data-testid-like hook for tests and the URL modal name. */
  name?: string;
}

export function Dialog({ open, onClose, title, children, footer, variant = 'modal', hideTitle, className, name }: DialogProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    } else if (!open && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('pwa-dialog', `is-${variant}`, className)}
      aria-labelledby={titleId}
      data-dialog={name}
      onCancel={(e) => {
        // Esc: let the owner decide (it updates `open`, which closes the element).
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="pwa-dialog-frame">
          <div className="pwa-dialog-head">
            <h2 id={titleId} className={cx('pwa-dialog-title', hideTitle && 'sr-only')}>
              {title}
            </h2>
            <IconButton icon="close" label={t('common.actions.close')} onClick={onClose} />
          </div>
          <div className="pwa-dialog-body">{children}</div>
          {footer ? <div className="pwa-dialog-foot">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
