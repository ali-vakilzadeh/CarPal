// Q&A hub topic views (P13.T10): the topic's name for the title and heading of /<locale>/questions?cat=… or ?brand=…
// [&model=…], from the cached taxonomy. Unknown ids → null (the view stays noindex).
import 'server-only';
import type { QaTopic } from '@/features/community';
import type { Locale } from '@/lib/i18n/locales';
import { taxonomy } from '@/server/taxonomy';

export async function qaTopicName(locale: Locale, topic: QaTopic): Promise<string | null> {
  try {
    if (topic.kind === 'category') {
      const node = (await taxonomy().nodes(locale, 'service_system')).find((n) => n.id === topic.id);
      return node?.name.text ?? null;
    }
    const brand = (await taxonomy().nodes(locale, 'vehicle_brand')).find((n) => n.id === topic.id);
    if (!brand) return null;
    if (!topic.modelId) return brand.name.text;
    const model = (await taxonomy().nodes(locale, 'vehicle_model', brand.id)).find((n) => n.id === topic.modelId);
    return model ? `${brand.name.text} ${model.name.text}` : null;
  } catch (err) {
    console.warn('qa topic: taxonomy read failed', err);
    return null;
  }
}
