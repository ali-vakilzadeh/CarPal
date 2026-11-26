// Part lines (PRV-GD-08; Workshop PW-JOB-01 Close job, Web UI P-REQ-02 completion): the optional simple part lines of
// a completed job — name, part number, quantity (Docs/40 PartUsed; Docs/11 Ch.7 keeps the part number on the service
// record). Controlled: the caller keeps the rows and checks them; words come as props. Design-system field markup.
import { useId } from 'react';
import { cx } from './cx';

export interface PartLine {
  name: string;
  partNumber: string;
  quantity: string;
}

export interface PartLinesWords {
  legend: string;
  name: string;
  partNumber: string;
  quantity: string;
  add: string;
  /** Accessible name of a row's remove button, e.g. "Remove part 2". */
  remove: (n: number) => string;
}

export interface PartLinesProps {
  rows: readonly PartLine[];
  onChange: (rows: PartLine[]) => void;
  words: PartLinesWords;
  /** A server or form error for the lines, shown under them. */
  error?: string;
  className?: string;
}

export const emptyPartLine = (): PartLine => ({ name: '', partNumber: '', quantity: '1' });

export function PartLines({ rows, onChange, words, error, className }: PartLinesProps) {
  const id = useId();
  const update = (i: number, patch: Partial<PartLine>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const field = (i: number, key: keyof PartLine, label: string, extra: { maxLength?: number; inputMode?: 'numeric'; dir?: 'ltr' }) => {
    const fid = `${id}-${i}-${key}`;
    return (
      <div className="cp-field bui-part-field" data-part-field={key}>
        <label className="cp-field-label" htmlFor={fid}>
          {label}
        </label>
        <div className="cp-field-box">
          <input
            id={fid}
            className="cp-field-input"
            dir={extra.dir ?? 'auto'}
            value={rows[i]![key]}
            maxLength={extra.maxLength}
            inputMode={extra.inputMode}
            onChange={(e) => update(i, { [key]: e.target.value })}
          />
        </div>
      </div>
    );
  };
  return (
    <fieldset className={cx('bui-parts', className)} aria-describedby={error ? `${id}-err` : undefined}>
      <legend className="cp-field-label">{words.legend}</legend>
      {rows.map((_, i) => (
        <div key={i} className="bui-part-row" data-testid="part-line">
          {field(i, 'name', words.name, { maxLength: 160 })}
          {field(i, 'partNumber', words.partNumber, { maxLength: 100, dir: 'ltr' })}
          {field(i, 'quantity', words.quantity, { inputMode: 'numeric', maxLength: 5 })}
          <button
            type="button"
            className="cp-btn cp-btn-ghost cp-btn-sm bui-part-remove"
            aria-label={words.remove(i + 1)}
            onClick={() => onChange(rows.filter((__, j) => j !== i))}
          >
            <span className="cp-btn-label" aria-hidden="true">
              ✕
            </span>
          </button>
        </div>
      ))}
      {error ? (
        <p id={`${id}-err`} className="cp-field-hint bui-error" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <button type="button" className="cp-btn cp-btn-ghost cp-btn-sm" onClick={() => onChange([...rows, emptyPartLine()])}>
          <span className="cp-btn-label">{words.add}</span>
        </button>
      </div>
    </fieldset>
  );
}
