// Public review projection (40 §15.1 PublicReview): an allowlist; internal
// fields (trust_weight, ai_*, reviewer identity, business confirmation notes)
// are never read into it (SEC-OUT-1).
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { isoOrNull, iso } from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import { authorDisplayName, type UserCard } from '#modules/identity/interface/identity.js';
import type { MediaAttachmentView } from '#modules/media/interface/media.js';
import type { VehicleCard } from '#modules/vehicle/interface/vehicles.js';

export type ReviewRow = Selectable<DB['trust.reviews']>;

export function toPublicReview(
  r: ReviewRow,
  x: {
    locale: string;
    labels: Map<string, L10n>;
    author: UserCard | undefined;
    vehicle: VehicleCard | undefined;
    subRatings: { dimension: string; rating: number }[];
    tags: string[];
    response: { response_text: string; content_locale: string; published_at: Date | string | null } | undefined;
    media: MediaAttachmentView[];
  },
) {
  const lb = (id: string | null | undefined) => (id ? (x.labels.get(id) ?? null) : null);
  const brand = lb(x.vehicle?.brandNodeId);
  const model = lb(x.vehicle?.modelNodeId);
  return {
    id: r.id,
    author: { display_name: authorDisplayName(x.author, x.locale), avatar_url: null },
    subject_location_id: r.subject_location_id,
    vehicle: brand && model ? { brand, model, series: lb(x.vehicle?.seriesNodeId) } : null,
    service_system: lb(r.service_system_node_id),
    service_task: lb(r.service_task_node_id),
    service_date: r.service_date ?? null,
    overall_rating: Number(r.overall_rating),
    would_return: r.would_return,
    title: r.title,
    body: r.body,
    content_locale: r.content_locale,
    sub_ratings: x.subRatings.slice(0, 5).map((s) => ({ dimension: s.dimension, rating: Number(s.rating) })),
    tags: x.tags
      .filter((id) => x.labels.has(id))
      .slice(0, 10)
      .map((id) => ({ node_id: id, label: x.labels.get(id)! })),
    media: x.media.slice(0, 10),
    label: r.confirmation_path === 'approval_based' ? 'approved_by_business_and_carpal' : 'verified_visit',
    disputed_by_business: r.disputed_by_business,
    helpful_count: r.helpful_count,
    response: x.response
      ? {
          response_text: x.response.response_text,
          content_locale: x.response.content_locale,
          published_at: isoOrNull(x.response.published_at)!,
        }
      : null,
    published_at: iso(r.published_at!),
  };
}
