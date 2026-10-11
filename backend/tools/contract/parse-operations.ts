// Parses the operation blocks of Docs/40.API contract.md (grammar: 40 §0.2) into
// the registry of libs/contract/registry.types.ts. Anything the parser does not
// understand is an error: the registry must describe every route exactly.
import type {
  EmittedEvent,
  Host,
  HttpMethod,
  Operation,
  OperationError,
  QueryParam,
  Route,
  RouteScope,
  RouteSecurity,
  SecTag,
  SecTagName,
} from '#libs/contract/registry.types.js';
import { lines, parseH1, parseH2, splitTopLevel, tableAt, ticks, type Line, type Section } from './markdown.js';

export const SEC_TAGS: readonly SecTagName[] = [
  'PUB',
  'USR',
  'ORG',
  'DRV',
  'STF',
  'LNK',
  'AAL2',
  'AAL3',
  'ATT',
  'IDEM',
  'ETAG',
  'RL',
  'ENT',
  'CNS',
  'FLAG',
  'ASYNC',
  'AUD',
  'RSN',
  '4EYES',
  'PURP',
  'PII',
];
/** Tags that say who may call (the alternatives of an `A | B` line). */
export const PRINCIPAL_TAGS: ReadonlySet<SecTagName> = new Set(['PUB', 'USR', 'ORG', 'DRV', 'STF', 'LNK']);

// ------------------------------------------------------------------ aliases
export interface AliasTable {
  /** alias name (without braces) → alternative expansions (each may contain further aliases). */
  expansions: Map<string, string[]>;
}

/** Reads the path alias table of 40 §0.3. */
export function parseAliases(all: Line[]): AliasTable {
  const header = all.findIndex((l) => /^\| Alias \| Expands to \|/.test(l.text));
  if (header < 0) throw new Error('40 §0.3 alias table not found');
  const expansions = new Map<string, string[]>();
  for (const [alias, expandsTo] of tableAt(all, header).slice(1)) {
    const name = /^`\{([A-Za-z]+)\}`/.exec(alias ?? '')?.[1];
    if (!name || name === 'id') continue; // {id}, {x_id}: path parameters, not aliases
    const targets = ticks(expandsTo ?? '').filter((t) => t.startsWith('/') || t.startsWith('{'));
    if (targets.length === 0) throw new Error(`Alias {${name}} has no expansion`);
    expansions.set(name, targets);
  }
  return { expansions };
}

/** Expands every alias in a path; returns one concrete path per alternative (e.g. {V} → 2). */
export function expandPath(path: string, aliases: AliasTable): string[] {
  const m = /\{([A-Za-z]+)\}/.exec(path);
  if (!m) return [path];
  const name = m[1]!;
  const targets = aliases.expansions.get(name);
  if (!targets) {
    // A path parameter such as {vehicle_id}: keep it, expand the rest of the path.
    const head = path.slice(0, m.index + m[0].length);
    return expandPath(path.slice(m.index + m[0].length), aliases).map((rest) => head + rest);
  }
  return targets.flatMap((t) => expandPath(path.slice(0, m.index) + t + path.slice(m.index + m[0].length), aliases));
}

const DUAL_SCOPES: Record<string, [RouteScope, RouteScope]> = {
  V: ['me', 'fleet'],
  A: ['me', 'fleet'],
  RQ: ['me', 'org'],
};

// ------------------------------------------------------------------ modules
/** Owning module per op where the section heading does not name exactly one (41 §2.1). */
export function moduleFor(opId: string, h1: Section): string {
  const [prefix, name = ''] = opId.split('.') as [string, string?];
  if (h1.number === '14' && prefix === 'public') {
    return (
      { org_reviews: 'trust', org_inventory_search: 'inventory', inventory_get: 'inventory', availability: 'appointment' }[name] ??
      'organization'
    );
  }
  if (opId === 'feed.discover') return 'discovery'; // §19 operation owned by discovery (41 §2.1 M7)
  if (h1.number === '21') return 'ai-mcp';
  if (h1.number === '22') return { events: 'analytics', reports: 'admin' }[prefix] ?? 'platform';
  if (h1.number === '23') {
    if (/^(users_search|user_|platform_role_|onboarding_reset|dsr_)/.test(name)) return 'identity';
    if (/^(orgs_search|org_|verifications_queue|verification_decide|location_correct)/.test(name)) return 'organization';
    if (/^(subscription_assign|plans_list|plan_update)$/.test(name)) return 'billing';
    if (/^(taxonomy_|synonym|mapping)/.test(name)) return 'taxonomy';
    if (/^(review_|disputes_|dispute_|badge_)/.test(name)) return 'trust';
    if (/^(audit_search|analytics_dashboard)$/.test(name)) return 'analytics';
    if (name === 'media_download_url') return 'media';
    if (/^(ai_|mcp_)/.test(name)) return 'ai-mcp';
    return 'admin'; // reports, cases, flags, retention, four-eyes, assist sessions
  }
  if (!h1.module) throw new Error(`No module for ${opId} in §${h1.number}`);
  return h1.module;
}

// ------------------------------------------------------------------- hosts
export function hostFor(pathTemplate: string): Host {
  if (pathTemplate.startsWith('<')) return 'storage';
  if (/^\/(oauth|\.well-known)\//.test(pathTemplate) || pathTemplate.startsWith('/v1/auth/')) return 'auth';
  if (pathTemplate.startsWith('{adm}')) return 'admin-api';
  return 'api';
}

// --------------------------------------------------------------- sec tags
const TAG_RE = /^([A-Z0-9]+)(?:\(([^()]*)\))?/;

export function parseTag(raw: string, opId: string): SecTag {
  const m = TAG_RE.exec(raw);
  if (!m || m[0] !== raw) throw new Error(`${opId}: cannot parse sec tag "${raw}"`);
  const tag = m[1] as SecTagName;
  if (!SEC_TAGS.includes(tag)) throw new Error(`${opId}: unknown sec tag "${tag}"`);
  const inner = m[2]?.trim();
  if (inner === undefined) return { tag, args: [] };
  if (/^(if|by|own|no)\b/.test(inner)) return { tag, args: [], qualifier: inner };
  const colon = inner.indexOf(':');
  const argText = colon >= 0 ? inner.slice(0, colon) : inner;
  const qualifier = colon >= 0 ? inner.slice(colon + 1).trim() : undefined;
  return {
    tag,
    args: argText
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    ...(qualifier ? { qualifier } : {}),
  };
}

/** Splits a sec: line into tags and '|' separators. Returns null for prose (e.g. "signed URL only ..."). */
export function tokenizeSec(sec: string, opId: string): (SecTag | '|')[] | null {
  const out: (SecTag | '|')[] = [];
  let s = sec.trim();
  if (!TAG_RE.test(s) || !SEC_TAGS.includes(TAG_RE.exec(s)![1] as SecTagName)) return null;
  while (s.length > 0) {
    if (s.startsWith('|')) {
      out.push('|');
      s = s.slice(1).trimStart();
      continue;
    }
    const m = TAG_RE.exec(s);
    if (!m) throw new Error(`${opId}: cannot parse sec line near "${s}"`);
    out.push(parseTag(m[0], opId));
    s = s.slice(m[0].length).trimStart();
  }
  return out;
}

/**
 * Builds the security alternatives. `X | Y rest...`: X is the {me} principal;
 * principal tags after '|' (ORG, DRV) form the org/fleet principal; every other
 * tag applies to both (observed form of all 64 split lines in 40).
 */
export function securityAlternatives(tokens: (SecTag | '|')[], opId: string): { alternatives: SecTag[][]; shared: SecTag[] } {
  const bar = tokens.indexOf('|');
  const tags = tokens.filter((t): t is SecTag => t !== '|');
  if (tokens.filter((t) => t === '|').length > 1) throw new Error(`${opId}: more than one '|' in sec`);
  if (bar < 0) {
    const principals = tags.filter((t) => PRINCIPAL_TAGS.has(t.tag));
    return { alternatives: [principals], shared: tags.filter((t) => !PRINCIPAL_TAGS.has(t.tag)) };
  }
  const left = tokens.slice(0, bar) as SecTag[];
  const right = tokens.slice(bar + 1) as SecTag[];
  if (left.some((t) => !PRINCIPAL_TAGS.has(t.tag))) throw new Error(`${opId}: non-principal tag before '|'`);
  const rightPrincipals = right.filter((t) => PRINCIPAL_TAGS.has(t.tag));
  if (rightPrincipals.length === 0) throw new Error(`${opId}: no principal after '|'`);
  return { alternatives: [left, rightPrincipals], shared: right.filter((t) => !PRINCIPAL_TAGS.has(t.tag)) };
}

// ------------------------------------------------------------ other fields
export function parseQuery(q: string, opId: string): QueryParam[] {
  return splitTopLevel(q, ',').map((part) => {
    const m = /^([a-z_][a-z0-9_]*)(\?)?(?:\s*:\s*([\s\S]+))?$/.exec(part.trim());
    if (!m) throw new Error(`${opId}: cannot parse query parameter "${part}"`);
    const [, name, opt, typeAndDefault] = m;
    if (!typeAndDefault) return { name: name!, optional: opt === '?', type: null };
    const eq = lastTopLevelEquals(typeAndDefault);
    return eq < 0
      ? { name: name!, optional: opt === '?', type: typeAndDefault.trim() }
      : { name: name!, optional: opt === '?', type: typeAndDefault.slice(0, eq).trim(), default: typeAndDefault.slice(eq + 1).trim() };
  });
}

function lastTopLevelEquals(s: string): number {
  let depth = 0;
  let quote: string | null = null;
  let found = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'") quote = c;
    else if ('(<{['.includes(c)) depth++;
    else if (')>}]'.includes(c)) depth--;
    else if (c === '=' && depth === 0) found = i;
  }
  return found;
}

export function parseErrors(err: string, opId: string): OperationError[] {
  return splitTopLevel(err, ',').map((part) => {
    const m = /^(\d{3})\s+([A-Za-z_]+)(?:\s*\((.*)\))?$/.exec(part.trim());
    if (!m) throw new Error(`${opId}: cannot parse error "${part}"`);
    return { status: Number(m[1]), code: m[2]!, ...(m[3] ? { detail: m[3] } : {}) };
  });
}

export function parseEmits(emit: string, opId: string): EmittedEvent[] {
  if (emit.trim().startsWith('(')) return []; // "(none; consent changes are audited)"
  return splitTopLevel(emit, ',').map((part) => {
    const m = /^([a-z_]+(?:\.[a-z_]+)+)(?:\s*\((.*)\))?$/.exec(part.trim());
    if (!m) throw new Error(`${opId}: cannot parse emitted event "${part}"`);
    return { event: m[1]!, ...(m[2] ? { note: m[2] } : {}) };
  });
}

const REQUEST_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s+->\s+(\d{3})\s*(.*)$/;
const FIELD_RE = /^(in|q|sec|err|emit):\s*(.*)$/;

// ---------------------------------------------------------------- operations
export function parseOperations(doc: string): Operation[] {
  const all = lines(doc);
  const aliases = parseAliases(all);
  const ops: Operation[] = [];
  let h1: Section | null = null;
  let h2: Section | null = null;

  for (let i = 0; i < all.length; i++) {
    const text = all[i]!.text;
    const s1 = parseH1(text);
    if (s1) {
      h1 = s1;
      h2 = null;
      continue;
    }
    const s2 = parseH2(text);
    if (s2) {
      h2 = s2;
      continue;
    }
    const head = /^#### ([a-z_]+\.[a-z_]+)\s*$/.exec(text);
    if (!head) continue;
    const opId = head[1]!;
    const headLine = all[i]!.n;
    if (!h1) throw new Error(`${opId} before any section`);

    // Description paragraph up to the opening fence.
    const summary: string[] = [];
    let j = i + 1;
    while (j < all.length && !all[j]!.text.startsWith('```')) {
      if (all[j]!.text.trim()) summary.push(all[j]!.text.trim());
      j++;
    }
    // Block body up to the closing fence; indented lines continue the previous field.
    // A trailing "// ..." on any line is a note of that field, not part of its value.
    const fields: { key: string; value: string; notes: string[] }[] = [];
    for (j = j + 1; j < all.length && !all[j]!.text.startsWith('```'); j++) {
      const raw = all[j]!.text;
      if (!raw.trim()) continue;
      const { code: l, comment } = splitLineComment(raw);
      if (/^\s/.test(l)) {
        const last = fields[fields.length - 1];
        if (!last) throw new Error(`${opId}: continuation line before any field (line ${all[j]!.n})`);
        // Under the request line, "name: Type" declares a path parameter type.
        const param = last.key === 'request' ? /^\s+([a-z_]+):\s*(.+)$/.exec(l) : null;
        if (param) {
          fields.push({ key: `param:${param[1]}`, value: param[2]!.trim(), notes: comment ? [comment] : [] });
          continue;
        }
        last.value += ' ' + l.trim();
        if (comment) last.notes.push(comment);
        continue;
      }
      const f = FIELD_RE.exec(l);
      const notes = comment ? [comment] : [];
      if (f) fields.push({ key: f[1]!, value: f[2]!.trim(), notes });
      else if (REQUEST_RE.test(l.trim())) fields.push({ key: 'request', value: l.trim(), notes });
      else throw new Error(`${opId}: unrecognized line ${all[j]!.n}: ${raw}`);
    }
    i = j;

    const field = (key: string): { value: string; notes: string[] } | undefined => {
      const found = fields.filter((f) => f.key === key);
      if (found.length > 1) throw new Error(`${opId}: duplicate "${key}:" line`);
      return found[0];
    };
    const get = (key: string): string | undefined => field(key)?.value;
    const note = (key: string): string | undefined => field(key)?.notes.join(' / ') || undefined;
    const request = get('request');
    if (!request) throw new Error(`${opId}: missing request line`);
    const rm = REQUEST_RE.exec(request)!;
    const method = rm[1] as HttpMethod;
    const pathTemplate = rm[2]!;
    const requestNote = note('request'); // e.g. "-> 201 {...}   // 4 h"
    // "FeatureFlag | 202 PendingChange": members starting with a status are other success responses.
    const responseMembers = splitTopLevel(rm[4]!.trim(), '|');
    const alternateResponses = responseMembers
      .map((m) => /^(\d{3})\s+(.+)$/.exec(m))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ status: Number(m[1]), type: m[2]!.trim() }));
    const rest = responseMembers.filter((m) => !/^\d{3}\s/.test(m)).join(' | ');
    const pathParamTypes = Object.fromEntries(
      fields.filter((f) => f.key.startsWith('param:')).map((f) => [f.key.slice('param:'.length), f.value]),
    );

    const sec = get('sec');
    if (!sec) throw new Error(`${opId}: missing sec line`);
    const tokens = tokenizeSec(sec, opId);
    const { alternatives, shared } = tokens ? securityAlternatives(tokens, opId) : { alternatives: [], shared: [] };

    const host = hostFor(pathTemplate);
    const paths = host === 'storage' ? [pathTemplate] : expandPath(pathTemplate, aliases);
    const dual = /^\{(V|A|RQ)\}/.exec(pathTemplate)?.[1];
    let routes: Route[];
    if (dual) {
      if (paths.length !== 2 || alternatives.length !== 2) {
        throw new Error(`${opId}: dual-scope path {${dual}} needs two paths and an "A | B" sec line`);
      }
      routes = paths.map((path, k) => ({
        scope: DUAL_SCOPES[dual]![k]!,
        host,
        method,
        path,
        pathParams: pathParams(path),
        security: { principals: [alternatives[k]!], tags: shared } satisfies RouteSecurity,
      }));
    } else {
      if (paths.length !== 1) throw new Error(`${opId}: unexpected multi-path expansion of ${pathTemplate}`);
      routes = [
        {
          scope: 'single',
          host,
          method,
          path: paths[0]!,
          pathParams: pathParams(paths[0]!),
          security: { principals: alternatives, tags: shared },
        },
      ];
    }

    const input = get('in');
    const q = get('q');
    const err = get('err');
    const emit = get('emit');
    const isType = rest.length > 0 && !/^\(.*\)$/.test(rest);
    ops.push({
      opId,
      section: h2?.number ?? h1.number,
      sectionTitle: h2?.title ?? h1.title,
      module: moduleFor(opId, h1),
      summary: summary.join(' '),
      method,
      pathTemplate,
      routes,
      successStatus: Number(rm[3]),
      responseType: isType ? rest : null,
      ...(!isType && rest ? { responseNote: rest.replace(/^\(|\)$/g, '') } : {}),
      ...(isType && requestNote ? { responseNote: requestNote } : {}),
      ...(alternateResponses.length > 0 ? { alternateResponses } : {}),
      ...(Object.keys(pathParamTypes).length > 0 ? { pathParamTypes } : {}),
      ...parseInput(input),
      ...(note('in') ? { inputNote: note('in') } : {}),
      query: q ? parseQuery(q, opId) : [],
      ...(note('q') ? { queryNote: note('q') } : {}),
      sec,
      errors: err ? parseErrors(err, opId) : [],
      emits: emit ? parseEmits(emit, opId) : [],
      line: headLine,
    });
  }
  return ops;
}

/** Operations staff may run in an assist session ("Allowlisted operations: `org.update`, ..."). */
export function parseAssistAllowlist(doc: string): string[] {
  const line = doc.split(/\r?\n/).find((l) => l.startsWith('Allowlisted operations:'));
  if (!line) throw new Error('Assist-session allowlist not found in 40 (admin.assist_session_start)');
  return ticks(line);
}

/** "TokenRequest (form)" → form body; "raw bytes" → raw upload; "-" / absent → no body. */
function parseInput(input: string | undefined): Pick<Operation, 'inputType' | 'inputEncoding'> {
  if (input === undefined || input === '-') return { inputType: null, inputEncoding: 'none' };
  if (input === 'raw bytes') return { inputType: null, inputEncoding: 'raw' };
  const form = /^(.*)\s+\(form\)$/.exec(input);
  if (form) return { inputType: form[1]!.trim(), inputEncoding: 'form' };
  return { inputType: input, inputEncoding: 'json' };
}

/** Splits "code   // comment" outside single-quoted literals. */
export function splitLineComment(line: string): { code: string; comment?: string } {
  let quote = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i]!;
    if (c === "'") quote = !quote;
    else if (!quote && c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
      return { code: line.slice(0, i).trimEnd(), comment: line.slice(i + 2).trim() };
    }
  }
  return { code: line };
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!);
}
