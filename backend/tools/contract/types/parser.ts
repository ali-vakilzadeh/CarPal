// Parser for the TypeScript-like type notation of Docs/40 (§0.1): type
// definitions in ```ts blocks and type expressions on in:/response lines.
//
//   type Name<P> = Expr
//   Expr   := '|'? Inter ('|' Inter)*
//   Inter  := Post ('&' Post)*
//   Post   := Prim ('[]')* | Prim '[' 'string-literal' ']'  (indexed access X['field'])
//   Prim   := 'literal' | number | Name ('<' Expr (',' Expr)* '>')? | '{' Field* '}' | '(' Expr ')'
//   Field  := name '?'? ':' Expr (';' | ',')?
// Comments ("// ...") attach to the field (or definition) that ends on the same line,
// or to the previous field when the comment stands on its own line.

export type TypeNode =
  | { k: 'lit'; value: string | number | boolean | null }
  | { k: 'ref'; name: string; args: TypeNode[] }
  | { k: 'obj'; fields: Field[] }
  | { k: 'union'; members: TypeNode[] }
  | { k: 'inter'; members: TypeNode[] }
  | { k: 'array'; of: TypeNode }
  | { k: 'index'; of: TypeNode; key: string };

export interface Field {
  name: string;
  optional: boolean;
  type: TypeNode;
  comment?: string;
}

export interface TypeDef {
  name: string;
  params: string[];
  type: TypeNode;
  comment?: string;
  /** 1-based line in the source document. */
  line: number;
}

interface Token {
  t: 'ident' | 'num' | 'str' | 'punct' | 'comment' | 'eof';
  v: string;
  line: number;
}

export class TypeSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = 'TypeSyntaxError';
  }
}

export function tokenize(src: string, firstLine = 1): Token[] {
  const out: Token[] = [];
  let line = firstLine;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out.push({ t: 'comment', v: src.slice(i + 2, stop).trim(), line });
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new TypeSyntaxError('unterminated /* comment', line);
      const body = src.slice(i + 2, end);
      out.push({ t: 'comment', v: body.trim(), line });
      line += body.split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new TypeSyntaxError('unterminated string literal', line);
      out.push({ t: 'str', v: src.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num && (c === '-' || /\d/.test(c))) {
      out.push({ t: 'num', v: num[0], line });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'ident', v: id[0], line });
      i += id[0].length;
      continue;
    }
    if ('{}<>()[]|&;,:?='.includes(c)) {
      out.push({ t: 'punct', v: c, line });
      i++;
      continue;
    }
    throw new TypeSyntaxError(`unexpected character "${c}"`, line);
  }
  out.push({ t: 'eof', v: '', line });
  return out;
}

class Parser {
  private pos = 0;
  /** Comments seen since the last consumed token, waiting for an owner. */
  private pending: Token[] = [];
  constructor(private readonly toks: Token[]) {}

  private skipComments(): void {
    while (this.toks[this.pos]?.t === 'comment') this.pending.push(this.toks[this.pos++]!);
  }
  peek(): Token {
    this.skipComments();
    return this.toks[this.pos]!;
  }
  next(): Token {
    this.skipComments();
    return this.toks[this.pos++]!;
  }
  /** The last consumed non-comment token. */
  private last(): Token | undefined {
    for (let p = this.pos - 1; p >= 0; p--) if (this.toks[p]!.t !== 'comment') return this.toks[p];
    return undefined;
  }
  is(v: string): boolean {
    const t = this.peek();
    return (t.t === 'punct' || t.t === 'ident') && t.v === v;
  }
  expect(v: string): Token {
    const t = this.next();
    if (t.v !== v || (t.t !== 'punct' && t.t !== 'ident')) throw new TypeSyntaxError(`expected "${v}", got "${t.v || t.t}"`, t.line);
    return t;
  }
  /** Comments on the same line as `line` (after it), consumed. */
  takeTrailingComments(line: number): string | undefined {
    // Peek ahead without consuming non-comment tokens.
    const texts: string[] = [];
    while (this.toks[this.pos]?.t === 'comment' && this.toks[this.pos]!.line === line) texts.push(this.toks[this.pos++]!.v);
    const keep = this.pending.filter((c) => c.line === line);
    this.pending = this.pending.filter((c) => c.line !== line);
    return [...keep.map((c) => c.v), ...texts].join(' ') || undefined;
  }
  /** Comments standing on their own lines (not consumed by any field). */
  takeLooseComments(): string[] {
    const out = this.pending.map((c) => c.v);
    this.pending = [];
    return out;
  }
  atEnd(): boolean {
    return this.peek().t === 'eof';
  }
  lineOfLast(): number {
    return this.last()?.line ?? 0;
  }

  expr(): TypeNode {
    if (this.is('|')) this.next(); // leading '|' of a multi-line union
    const members = [this.inter()];
    while (this.is('|')) {
      this.next();
      members.push(this.inter());
    }
    return members.length === 1 ? members[0]! : { k: 'union', members: members.flatMap((m) => (m.k === 'union' ? m.members : [m])) };
  }

  inter(): TypeNode {
    const members = [this.post()];
    while (this.is('&')) {
      this.next();
      members.push(this.post());
    }
    return members.length === 1 ? members[0]! : { k: 'inter', members };
  }

  post(): TypeNode {
    let node = this.prim();
    while (this.is('[')) {
      this.next();
      const t = this.peek();
      if (t.t === 'str') {
        this.next();
        this.expect(']');
        node = { k: 'index', of: node, key: t.v };
      } else {
        this.expect(']');
        node = { k: 'array', of: node };
      }
    }
    return node;
  }

  prim(): TypeNode {
    const t = this.next();
    if (t.t === 'str') return { k: 'lit', value: t.v };
    if (t.t === 'num') return { k: 'lit', value: Number(t.v) };
    if (t.t === 'ident') {
      if (t.v === 'null') return { k: 'lit', value: null };
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', value: t.v === 'true' };
      const args: TypeNode[] = [];
      if (this.is('<')) {
        this.next();
        args.push(this.expr());
        while (this.is(',')) {
          this.next();
          args.push(this.expr());
        }
        this.expect('>');
      }
      return { k: 'ref', name: t.v, args };
    }
    if (t.t === 'punct' && t.v === '{') return this.object();
    if (t.t === 'punct' && t.v === '(') {
      const e = this.expr();
      this.expect(')');
      return e;
    }
    throw new TypeSyntaxError(`unexpected "${t.v || t.t}" in type`, t.line);
  }

  object(): TypeNode {
    const fields: Field[] = [];
    while (!this.is('}')) {
      if (this.atEnd()) throw new TypeSyntaxError('unterminated object type', this.lineOfLast());
      const loose = this.takeLooseComments();
      if (loose.length > 0 && fields.length > 0) appendComment(fields[fields.length - 1]!, loose.join(' '));
      const name = this.next(); // identifier, or a quoted name such as '1' or 'Content-Type'
      if (name.t !== 'ident' && name.t !== 'str') throw new TypeSyntaxError(`expected field name, got "${name.v || name.t}"`, name.line);
      let optional = false;
      if (this.is('?')) {
        this.next();
        optional = true;
      }
      this.expect(':');
      const type = this.expr();
      if (this.is(';') || this.is(',')) this.next();
      const field: Field = { name: name.v, optional, type };
      const comment = this.takeTrailingComments(this.lineOfLast());
      if (comment) field.comment = comment;
      fields.push(field);
    }
    const loose = this.takeLooseComments();
    if (loose.length > 0 && fields.length > 0) appendComment(fields[fields.length - 1]!, loose.join(' '));
    this.expect('}');
    return { k: 'obj', fields };
  }
}

function appendComment(f: Field, c: string): void {
  f.comment = f.comment ? `${f.comment} ${c}` : c;
}

/** Parses one type expression (an in: or response type). */
export function parseTypeExpr(src: string, line = 1): TypeNode {
  const p = new Parser(tokenize(src, line));
  const node = p.expr();
  if (!p.atEnd()) throw new TypeSyntaxError(`unexpected "${p.peek().v}" after type`, p.peek().line);
  return node;
}

/** Parses every "type X = ..." definition in a ```ts block. */
export function parseTypeDefs(src: string, firstLine = 1): TypeDef[] {
  const p = new Parser(tokenize(src, firstLine));
  const defs: TypeDef[] = [];
  while (!p.atEnd()) {
    p.takeLooseComments();
    const kw = p.next();
    if (kw.t !== 'ident' || kw.v !== 'type') throw new TypeSyntaxError(`expected "type", got "${kw.v || kw.t}"`, kw.line);
    const name = p.next();
    if (name.t !== 'ident') throw new TypeSyntaxError('expected type name', name.line);
    const params: string[] = [];
    if (p.is('<')) {
      p.next();
      params.push(p.next().v);
      while (p.is(',')) {
        p.next();
        params.push(p.next().v);
      }
      p.expect('>');
    }
    p.expect('=');
    const type = p.expr();
    if (p.is(';')) p.next();
    const def: TypeDef = { name: name.v, params, type, line: kw.line };
    const comment = p.takeTrailingComments(p.lineOfLast());
    if (comment) def.comment = comment;
    defs.push(def);
  }
  return defs;
}
