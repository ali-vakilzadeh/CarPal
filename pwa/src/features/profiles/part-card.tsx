// A part card (C-INV-01 card elements): photo, name, condition and type, the public price or "Price on request" (a
// trade price only ever appears for signed-in trade members and is labelled; server-rendered pages never ask for
// one), stock status and, when a vehicle was given, the fitment for it. Server-renderable.
import type { PublicInventoryCard } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import { MediaImage } from '@/components/media/media-image';
import type { Formatter } from '@/lib/format';
import type { Translate } from '@/lib/i18n/keys';
import { fitmentTone } from './view-model';

export function stockTone(s: PublicInventoryCard['stock_status']) {
  return s === 'in_stock' ? 'success' : s === 'out_of_stock' ? 'danger' : 'neutral';
}

export function PriceText({
  item,
  t,
  f,
}: {
  item: Pick<PublicInventoryCard, 'price' | 'price_on_request'> & { is_trade_price?: boolean };
  t: Translate;
  f: Formatter;
}) {
  if (!item.price || item.price_on_request) return <span className="pwa-text-label">{t('profiles.parts.priceOnRequest')}</span>;
  return (
    <span className="pwa-price-line">
      <span className="cp-price">{f.money(item.price.amount, item.price.currency)}</span>
      {item.is_trade_price ? <Badge icon="lock">{t('profiles.parts.tradePrice')}</Badge> : null}
    </span>
  );
}

export function PartCard({
  item,
  href,
  t,
  f,
  tradeLabel,
}: {
  item: PublicInventoryCard;
  href: string;
  t: Translate;
  f: Formatter;
  tradeLabel?: boolean;
}) {
  return (
    <article className="pwa-part-card">
      <MediaImage
        url={item.image_url}
        variant="thumb"
        alt=""
        aspect="square"
        placeholder={t('profiles.parts.photoPending')}
        placeholderIcon="part"
      />
      <div className="pwa-stack-xs">
        <a href={href} className="pwa-card-link pwa-text-label" dir="auto">
          {item.name.text}
        </a>
        <span className="pwa-text-caption">
          {t(`profiles.parts.condition.${item.condition}`)} · {t(`profiles.parts.origin.${item.part_origin}`)} · {item.part_category.text}
        </span>
        <PriceText item={{ ...item, is_trade_price: tradeLabel }} t={t} f={f} />
        <span className="pwa-badges">
          <Badge tone={stockTone(item.stock_status)} icon={item.stock_status === 'out_of_stock' ? 'close' : 'check'}>
            {t(`profiles.parts.stock.${item.stock_status}`)}
          </Badge>
          {item.fitment_confidence_for_vehicle ? (
            <Badge
              tone={fitmentTone(item.fitment_confidence_for_vehicle)}
              icon={item.fitment_confidence_for_vehicle === 'confirmed' ? 'check' : 'help'}
            >
              {t(`profiles.parts.fitsYourCar.${item.fitment_confidence_for_vehicle}`)}
            </Badge>
          ) : null}
        </span>
      </div>
    </article>
  );
}
