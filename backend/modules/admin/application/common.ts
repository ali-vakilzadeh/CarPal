// Helpers shared by the admin use cases: keyset paging on UUIDv7 ids and
// field errors.
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';

type Position = { id?: string } | undefined;
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

export function pageOf<R extends { id: string }, T>(ctx: OperationContext<unknown, { limit: number }>, rows: R[], items: T[]) {
  const limit = ctx.query.limit;
  return ctx.page(items.slice(0, limit), rows.length > limit ? { id: rows[limit - 1]!.id } : null);
}

export function failIf(errors: FieldError[]): void {
  if (errors.length) throw ApiError.validation(errors);
}

export const notFoundAt = (pointer: string): ApiError =>
  ApiError.validation([{ pointer, code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');

/** "Exactly one of" constraints (40 `// C: exactly one`). */
export function exactlyOne(body: Record<string, unknown>, keys: string[]): void {
  const present = keys.filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== false);
  if (present.length !== 1)
    throw ApiError.validation(
      (present.length === 0 ? keys : present.slice(1)).map((k) => ({
        pointer: `/${k}`,
        code: present.length === 0 ? 'conditional_required' : 'conditional_forbidden',
      })),
    );
}
