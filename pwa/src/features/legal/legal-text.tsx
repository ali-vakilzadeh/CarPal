// Renders a parsed legal text (P13.T7). Shared by the server-rendered /<locale>/privacy and /<locale>/terms pages and
// the sign-up "Read" dialogs, so it has no hooks. The texts are English only so far: the article is lang="en"
// dir="ltr" in both locales, and the page says so in Persian.
import { Fragment, type ReactNode } from 'react';
import { plainText, type Block, type Inline, type LegalDocument } from './markdown';

export type LegalKind = 'privacy' | 'terms';

/** Values the deployment knows for the texts' placeholders; any other placeholder is shown as written. */
export interface LegalFill {
  supportEmail: string;
  domain: string;
}

function placeholder(name: string, fill: LegalFill): ReactNode {
  if (name === 'SUPPORT EMAIL')
    return (
      <a className="pwa-link" href={`mailto:${fill.supportEmail}`}>
        {fill.supportEmail}
      </a>
    );
  if (name === 'DOMAIN') return fill.domain;
  return <span className="pwa-legal-placeholder">[{name}]</span>;
}

function Runs({ inline, fill }: { inline: readonly Inline[]; fill: LegalFill }) {
  return (
    <>
      {inline.map((r, i) =>
        r.kind === 'strong' ? (
          <strong key={i}>{r.text}</strong>
        ) : r.kind === 'placeholder' ? (
          <Fragment key={i}>{placeholder(r.name, fill)}</Fragment>
        ) : (
          <Fragment key={i}>{r.text}</Fragment>
        ),
      )}
    </>
  );
}

function BlockView({ block: b, fill, headingOffset }: { block: Block; fill: LegalFill; headingOffset: number }) {
  if (b.kind === 'heading') {
    const level = Math.min(6, b.level + headingOffset);
    const Tag = `h${level}` as 'h2';
    return (
      <Tag id={b.id} className={level <= 2 ? 'pwa-text-h2' : 'pwa-text-label'}>
        <Runs inline={b.inline} fill={fill} />
      </Tag>
    );
  }
  if (b.kind === 'paragraph')
    return (
      <p className="pwa-text-body">
        <Runs inline={b.inline} fill={fill} />
      </p>
    );
  if (b.kind === 'list') {
    const Tag = b.ordered ? 'ol' : 'ul';
    return (
      <Tag className="pwa-legal-list">
        {b.items.map((item, i) => (
          <li key={i} className="pwa-text-body">
            <Runs inline={item} fill={fill} />
          </li>
        ))}
      </Tag>
    );
  }
  // An empty corner cell means the first column names the rows.
  const rowHeads = !!b.head[0] && !plainText(b.head[0]).trim();
  return (
    <div className="pwa-legal-table">
      <table>
        <thead>
          <tr>
            {b.head.map((c, i) =>
              // An empty corner cell is not a header (axe empty-table-header): a plain cell.
              plainText(c).trim() ? (
                <th key={i} scope="col">
                  <Runs inline={c} fill={fill} />
                </th>
              ) : (
                <td key={i} />
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) =>
                i === 0 && rowHeads ? (
                  <th key={i} scope="row">
                    <Runs inline={c} fill={fill} />
                  </th>
                ) : (
                  <td key={i}>
                    <Runs inline={c} fill={fill} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The body of a legal text. `headingOffset` shifts heading levels (0 on the page, where ## is an h2 under the page's
 * h1; 1 in a dialog, whose title is the h2).
 */
export function LegalBody({ doc, fill, headingOffset = 0 }: { doc: LegalDocument; fill: LegalFill; headingOffset?: number }) {
  return (
    <div className="pwa-legal-body" lang="en" dir="ltr">
      {doc.blocks.map((b, i) => (
        <BlockView key={i} block={b} fill={fill} headingOffset={headingOffset} />
      ))}
    </div>
  );
}
