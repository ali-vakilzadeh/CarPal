'use client';
// Modal dialog on the native <dialog> element (AC4), copied from pwa/src/components/shell/dialog.tsx (modal variant
// only; classes adm-dialog-*): showModal() gives the top layer, an inert page behind, a focus trap and Esc; closing
// returns focus to the opener. The caller owns `open`. `dismissible={false}` keeps Esc and the scrim from closing it
// (the idle warning must be answered or run out).
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
  className?: string;
  /** data-dialog hook for tests. */
  name?: string;
  dismissible?: boolean;
  /** 'alertdialog' for a dialog that interrupts (idle warning). */
  role?: 'dialog' | 'alertdialog';
}

export function Dialog({ open, onClose, title, children, footer, className, name, dismissible = true, role }: DialogProps) {
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
      className={cx('adm-dialog', className)}
      aria-labelledby={titleId}
      role={role}
      data-dialog={name}
      onCancel={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="adm-dialog-frame">
          <div className="adm-dialog-head">
            <h2 id={titleId} className="adm-dialog-title">
              {title}
            </h2>
            {dismissible ? <IconButton icon="close" label={t('common.actions.close')} onClick={onClose} /> : null}
          </div>
          <div className="adm-dialog-body">{children}</div>
          {footer ? <div className="adm-dialog-foot">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
