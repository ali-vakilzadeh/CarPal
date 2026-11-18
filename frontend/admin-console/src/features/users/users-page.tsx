'use client';
// User lookup (AC10.T1, Docs/23 A-USR-01 as an exact lookup, DI-03; Docs/40 admin.users_search). Staff find a user by
// exactly one identifier — email, phone, name or user id — for the work item they came from (?purpose=, GD-10): the
// backend answers only with the item's own users (SEC-ADM-5, backend S14), so a search for anyone else is an empty
// page, and the search itself is a logged personal-data read. Results are masked (contacts, full name); opening one
// carries the purpose on. No browsable list, no enforcement from the results (Docs/23).
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import type { UserSearch } from '@carpal/api-contracts';
import { maskEmail, maskName, maskPhone, PurposeGate, purposeKind, withPurpose } from '@/components/admin';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import type { AccessPurpose } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useT } from '@/lib/i18n/client';
import { userStatus } from './user-parts';
import { LOOKUP_KINDS, lookupBody, type LookupKind } from './user-logic';

export function UsersPage() {
  const t = useT();
  return (
    <div className="adm-page" data-testid="users-page">
      <h1 className="adm-page-title">{t('admin.users.title')}</h1>
      <p className="adm-measure">{t('admin.users.intro')}</p>
      <PurposeGate>{(purpose) => <Lookup purpose={purpose} />}</PurposeGate>
    </div>
  );
}

function Lookup({ purpose }: { purpose: AccessPurpose }) {
  const t = useT();
  const uid = useId();
  const [kind, setKind] = useState<LookupKind>('email');
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<'required' | 'invalid' | null>(null);
  const [search, setSearch] = useState<UserSearch | null>(null);
  const result = useApiQuery('admin.users_search', search ? { body: search, purpose } : undefined, { enabled: !!search, retry: false });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = lookupBody(kind, text);
    if ('problem' in r) {
      setProblem(r.problem);
      return;
    }
    setProblem(null);
    setSearch(r.body);
  };

  return (
    <>
      <p className="adm-muted" data-testid="users-purpose">
        {t('admin.users.readFor', { kind: t(`admin.orgs.purpose.kind.${purposeKind(purpose)}`) })}
      </p>
      <form className="adm-search" role="search" aria-label={t('admin.users.search.label')} onSubmit={submit}>
        <div className="cp-field">
          <label className="cp-field-label" htmlFor={`${uid}-kind`}>
            {t('admin.users.search.by')}
          </label>
          <div className="cp-field-box">
            <select
              id={`${uid}-kind`}
              className="cp-field-input adm-select"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as LookupKind);
                setProblem(null);
              }}
            >
              {LOOKUP_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`admin.users.search.kind.${k}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <TextField
          label={t('admin.users.search.text')}
          hint={t(`admin.users.search.hint.${kind}`)}
          error={problem ? t(`admin.users.search.problem.${problem}`) : undefined}
          value={text}
          dir={kind === 'name' ? 'auto' : 'ltr'}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="primary" icon="search" loading={result.isFetching}>
          {t('admin.users.search.go')}
        </Button>
      </form>
      <p className="adm-muted">{t('admin.users.search.logged')}</p>
      {search ? (
        result.isError ? (
          <p data-testid="users-error">{t('admin.users.search.error')}</p>
        ) : result.data ? (
          result.data.items.length ? (
            <ul className="adm-stack" data-testid="users-results" aria-label={t('admin.users.results')}>
              {result.data.items.map((u) => (
                <li key={u.id}>
                  <Link href={withPurpose(`/users/${u.id}`, purpose)} data-testid="user-result">
                    <Bidi>{u.display_name ?? maskName(u.full_name)}</Bidi>
                  </Link>{' '}
                  <span className="adm-muted">
                    <Bidi ltr>{maskEmail(u.email)}</Bidi>
                    {u.phone ? (
                      <>
                        {' · '}
                        <Bidi ltr>{maskPhone(u.phone)}</Bidi>
                      </>
                    ) : null}
                    {' · '}
                    {userStatus(u.status, t)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="users-none">{t('admin.users.none')}</p>
          )
        ) : (
          <p className="adm-muted">{t('admin.kit.table.loading')}</p>
        )
      ) : null}
    </>
  );
}
