'use client';
// "Understood as" (Docs/90 S-SHARED-01 Behaviour, Docs/21 C-SEARCH-01 zone 1): how the text was interpreted, as chips
// the user can edit — remove a chip (✕) or add one from the taxonomy (+ Add). Either re-runs the session through
// search.refine with intent_override; the ranking rules stay the same. The target chip (what is searched for) cannot
// be removed; the mode tabs change it.
import type { IntentChip, InterpretedIntent } from '@carpal/api-contracts';
import { useId, useRef, useState } from 'react';
import { Icon } from '@/components/ds/icon';
import { useT } from '@/lib/i18n/client';
import { chipKind } from './request';
import { useSuggestions } from './suggest';

export function UnderstoodAs({
  intent,
  onRemove,
  onAdd,
  disabled,
}: {
  intent: InterpretedIntent;
  onRemove: (index: number, chip: IntentChip) => void;
  onAdd: (chip: IntentChip) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="pwa-understood" role="group" aria-label={t('search.chips.label')}>
      <span className="pwa-text-caption">{t('search.chips.label')}</span>
      <ul className="pwa-plain-list pwa-chips">
        {intent.chips.map((c, i) => (
          <li key={`${c.kind}-${c.node_id ?? c.text ?? i}`}>
            <span className="cp-chip is-static pwa-intent-chip">
              <span dir="auto">{c.label.text}</span>
              {c.removable ? (
                <button
                  type="button"
                  className="pwa-chip-remove"
                  aria-label={t('search.chips.remove', { label: c.label.text })}
                  disabled={disabled}
                  onClick={() => onRemove(i, c)}
                >
                  <Icon name="close" size={16} />
                </button>
              ) : null}
            </span>
          </li>
        ))}
        <li>
          <ChipAdder onAdd={onAdd} disabled={disabled} />
        </li>
      </ul>
    </div>
  );
}

function ChipAdder({ onAdd, disabled }: { onAdd: (chip: IntentChip) => void; disabled?: boolean }) {
  const t = useT();
  const id = `chip-add-${useId().replace(/:/g, '')}`;
  const [text, setText] = useState('');
  const [active, setActive] = useState(-1);
  const popover = useRef<HTMLDivElement>(null);
  const suggestions = useSuggestions(text)
    .filter((s) => chipKind(s.node.type) !== null)
    .slice(0, 8);

  const pick = (i: number) => {
    const s = suggestions[i];
    if (!s) return;
    onAdd({ kind: chipKind(s.node.type)!, node_id: s.node.id, label: s.node.name, removable: true });
    setText('');
    setActive(-1);
    popover.current?.hidePopover?.();
  };

  return (
    <>
      <button type="button" className="cp-chip" popoverTarget={id} aria-haspopup="dialog" disabled={disabled}>
        <Icon name="plus" size={18} />
        <span>{t('search.chips.add')}</span>
      </button>
      <div ref={popover} id={id} popover="auto" role="dialog" className="pwa-popover" aria-label={t('search.chips.addTitle')}>
        <label className="pwa-text-label" htmlFor={`${id}-input`}>
          {t('search.chips.addTitle')}
        </label>
        <input
          id={`${id}-input`}
          className="cp-field-input pwa-field-plain"
          dir="auto"
          autoComplete="off"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault();
              setActive((i) => (i + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault();
              setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(active >= 0 ? active : 0);
            }
          }}
        />
        <ul id={`${id}-list`} role="listbox" className="pwa-search-list" aria-label={t('shell.header.suggestions')}>
          {suggestions.map((s, i) => (
            <li
              key={s.node.id}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'pwa-search-option is-active' : 'pwa-search-option'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span dir="auto">{s.node.name.text}</span>
              <span className="pwa-text-caption">{t(`search.chips.kind.${chipKind(s.node.type)!}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
