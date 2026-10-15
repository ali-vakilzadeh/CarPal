// Lite MCP stub (CARPAL_MCP_MODE=stub, GD-35): deterministic, schema-valid
// tool output in English and Persian, so every AI flow can be built and
// tested without the MCP gateway (D6) or a model. It reads only the context
// package the facade passes plus the public taxonomy (res:taxonomy.*), never
// the database, and treats user text strictly as data to match words in
// (SEC-AI-2). It is not a model: outputs are simple rules over the context.
import { Injectable } from '@nestjs/common';
import type { CarpalConfig } from '#libs/config/index.js';
import { normalizeSearchText, type Locale } from '#libs/i18n/index.js';
import { InjectConfig } from '#libs/runtime/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { McpClientPort, McpUnavailableError, type ProposedSuggestion, type ToolCall, type ToolOutput } from '../application/mcp-port.js';

export const STUB_MODEL = 'carpal-lite-stub-1';

type Json = Record<string, unknown>;
const arr = <T = Json>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const say = (locale: Locale, en: string, fa: string): string => (locale === 'fa' ? fa : en);
const clip = (s: string, n: number): string => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s);

function output(o: Partial<ToolOutput> & { summary: string }): ToolOutput {
  return {
    payload: null,
    confidence: null,
    evidence: [],
    safetyFlags: [],
    suggestions: [],
    modelVersion: STUB_MODEL,
    promptKey: null,
    promptVersion: null,
    ...o,
    summary: clip(o.summary, 2000),
  };
}

@Injectable()
export class LiteMcpClient extends McpClientPort {
  constructor(
    private readonly taxonomy: TaxonomyResolver,
    @InjectConfig() private readonly config: CarpalConfig,
  ) {
    super();
  }

  async invoke(call: ToolCall): Promise<ToolOutput> {
    if (call.signal.aborted) throw new McpUnavailableError('tool call aborted');
    const run = this.#tools[call.tool.key];
    if (!run) throw new McpUnavailableError(`stub has no tool ${call.tool.key}`);
    return run(call);
  }

  readonly #tools: Record<string, (call: ToolCall) => Promise<ToolOutput>> = {
    'triage.classify_symptom': (c) => this.#triage(c, false),
    'triage.create_summary': (c) => this.#triage(c, true),
    'vehicle.extract_fields': async (c) => this.#vehicleFields(c),
    'vehicle.suggest_maintenance': async (c) => this.#maintenance(c),
    'vehicle.summarize_history': async (c) => this.#history(c),
    'fleet.summarize_vehicle_health': async (c) => (c.insightType === 'fleet_suggestion' ? this.#fleet(c) : this.#history(c)),
    'profile.suggest_capabilities': async (c) => this.#profile(c),
    'review.draft_response': async (c) => this.#reviewDraft(c),
    'review.summarize': async (c) => this.#reviewThemes(c),
    'portfolio.generate_caption': async (c) => this.#caption(c),
    'portfolio.redaction_check': async (c) => this.#redaction(c),
    'appointment.suggest_duration': async (c) => this.#duration(c),
    'inventory.normalize_item': async (c) => this.#normalize(c),
    'inventory.suggest_fitment': (c) => this.#fitment(c),
    'inventory.suggest_catalog_gaps': async (c) => this.#gaps(c),
  };

  // ------------------------------------------------------------------ triage

  async #triage(c: ToolCall, final: boolean): Promise<ToolOutput> {
    const norm = (t: string) => normalizeSearchText(t, { dbLocale: this.config.db.locale });
    const haystack = ` ${norm(c.userText.join(' '))} `;
    const { nodes, synonyms } = await this.taxonomy.catalog();
    const symptoms: string[] = [];
    for (const n of nodes) {
      if (n.type !== 'symptom' || n.status !== 'active' || symptoms.length >= 10) continue;
      const terms = [...Object.values(n.nameTranslations), ...synonyms.filter((s) => s.nodeId === n.id).map((s) => s.term)];
      if (terms.some((t) => t && haystack.includes(` ${norm(t)} `))) symptoms.push(n.id);
    }
    const systems = new Set<string>();
    let task: string | null = null;
    for (const s of symptoms) {
      for (const m of await this.taxonomy.mappingsFrom(s, 'symptom_to_system')) if (systems.size < 10) systems.add(m.targetId);
      task ??= (await this.taxonomy.mappingsFrom(s, 'symptom_to_task'))[0]?.targetId ?? null;
    }
    const userTurns = num(c.context.user_turns) || c.userText.length;
    const labels = await this.taxonomy.labels([...symptoms, ...systems], c.locale);
    const names = symptoms.map((id) => labels.get(id)?.text).filter((x): x is string => !!x);
    const question = final
      ? null
      : symptoms.length === 0
        ? say(
            c.locale,
            'Can you describe what you notice: a noise, a warning light, a smell or how the car drives?',
            'لطفاً توضیح دهید چه چیزی را متوجه شده‌اید: صدا، چراغ هشدار، بو یا رفتار خودرو هنگام رانندگی؟',
          )
        : userTurns < 2
          ? say(
              c.locale,
              'When does it happen: when starting, while driving, when braking or all the time?',
              'چه زمانی رخ می‌دهد: هنگام روشن کردن، هنگام رانندگی، هنگام ترمز یا همیشه؟',
            )
          : null;
    const summary = final
      ? names.length
        ? say(
            c.locale,
            `Summary: the reported symptoms point to ${names.join(', ')}. A provider should inspect the vehicle; this is not a diagnosis.`,
            `خلاصه: علائم گزارش‌شده به ${names.join('، ')} اشاره دارد. بهتر است یک تعمیرکار خودرو را بررسی کند؛ این تشخیص قطعی نیست.`,
          )
        : say(
            c.locale,
            'Summary: the symptoms could not be matched to a known issue. A provider should inspect the vehicle.',
            'خلاصه: علائم با مشکل شناخته‌شده‌ای تطبیق داده نشد. بهتر است یک تعمیرکار خودرو را بررسی کند.',
          )
      : question
        ? names.length
          ? say(c.locale, `It sounds like ${names.join(', ')}. ${question}`, `به نظر می‌رسد ${names.join('، ')} باشد. ${question}`)
          : question
        : say(
            c.locale,
            'Thank you. I have enough information; you can finish and find a provider.',
            'متشکرم. اطلاعات کافی است؛ می‌توانید پایان دهید و تعمیرکار پیدا کنید.',
          );
    return output({
      summary,
      confidence: symptoms.length ? 60 : 20,
      evidence: symptoms.map((id) => ({ type: 'taxonomy_node', id })),
      payload: {
        symptom_node_ids: symptoms,
        likely_system_node_ids: [...systems],
        recommended_service_node_id: task,
        urgency: symptoms.length ? 'medium' : 'low',
        next_question: question,
        do_not_drive: false,
      },
      promptKey: final ? 'triage.summary' : 'triage.turn',
      promptVersion: '1',
    });
  }

  // ------------------------------------------------------------------ vehicles

  #vehicleFields(c: ToolCall): ToolOutput {
    const v = (c.context.vehicle ?? {}) as Json;
    const candidates = (c.context.candidates ?? {}) as Record<string, string[]>;
    const fields: { field: 'series_node_id' | 'engine_type_node_id' | 'fuel_type_node_id'; node_id: string }[] = [];
    for (const field of ['series_node_id', 'engine_type_node_id', 'fuel_type_node_id'] as const) {
      const first = arr<string>(candidates[field])[0];
      if (!str(v[field]) && first) fields.push({ field, node_id: first });
    }
    const vehicleId = str(v.id)!;
    const suggestions: ProposedSuggestion[] = fields.map((f) => ({
      target: { type: 'vehicle', id: vehicleId },
      text: say(c.locale, `Add the missing ${f.field.replace(/_node_id$/, '').replace('_', ' ')}.`, 'افزودن مشخصه جاافتاده خودرو.'),
      action: 'update',
      payload: { [f.field]: f.node_id },
    }));
    return output({
      summary: fields.length
        ? say(c.locale, `${fields.length} vehicle detail(s) could be completed.`, `${fields.length} مشخصه خودرو قابل تکمیل است.`)
        : say(c.locale, 'The vehicle details look complete.', 'مشخصات خودرو کامل به نظر می‌رسد.'),
      confidence: fields.length ? 40 : 80,
      payload: { fields },
      suggestions,
    });
  }

  #maintenance(c: ToolCall): ToolOutput {
    const vehicleId = str((c.context.vehicle as Json | undefined)?.id)!;
    const open = new Set(arr<string>(c.context.open_reminder_types));
    const today = new Date(String(c.context.today ?? new Date().toISOString().slice(0, 10)));
    const titles: Record<string, [string, string]> = {
      oil: ['Oil and filter change', 'تعویض روغن و فیلتر'],
      brakes: ['Brake check', 'بازدید ترمز'],
      tires: ['Tyre check', 'بازدید لاستیک‌ها'],
      battery: ['Battery check', 'بازدید باتری'],
      inspection: ['General inspection', 'بازدید کلی'],
    };
    const checks = Object.keys(titles)
      .filter((t) => !open.has(t))
      .slice(0, 3)
      .map((t, i) => ({
        reminder_type: t,
        title: say(c.locale, titles[t]![0], titles[t]![1]),
        reason: say(
          c.locale,
          'Regular check recommended for a vehicle of this age.',
          'بازدید دوره‌ای برای خودرویی با این سن توصیه می‌شود.',
        ),
        due_in_days: 30 * (i + 1),
      }));
    const suggestions: ProposedSuggestion[] = checks.map((k) => ({
      target: { type: 'maintenance_reminder', id: vehicleId },
      text: say(c.locale, `Add a reminder: ${k.title}.`, `افزودن یادآور: ${k.title}.`),
      action: 'add',
      payload: {
        reminder_type: k.reminder_type,
        title: k.title,
        due_by_date: new Date(today.getTime() + k.due_in_days * 86_400_000).toISOString().slice(0, 10),
        reason: k.reason,
      },
    }));
    return output({
      summary: checks.length
        ? say(c.locale, `${checks.length} maintenance check(s) suggested.`, `${checks.length} بازدید نگهداری پیشنهاد شد.`)
        : say(c.locale, 'No new maintenance checks to suggest.', 'بازدید نگهداری تازه‌ای برای پیشنهاد نیست.'),
      confidence: 50,
      payload: { checks },
      suggestions,
    });
  }

  #history(c: ToolCall): ToolOutput {
    const records = arr(c.context.history);
    if (c.insightType === 'vehicle_summary') {
      const v = (c.context.vehicle ?? {}) as Json;
      const highlights = [
        say(c.locale, `Model year ${num(v.year)}.`, `سال ساخت ${num(v.year)}.`),
        say(c.locale, `${records.length} service record(s) on file.`, `${records.length} سابقه سرویس ثبت شده است.`),
      ];
      if (num(c.context.open_issue_count) > 0)
        highlights.push(say(c.locale, `${num(c.context.open_issue_count)} open issue(s).`, `${num(c.context.open_issue_count)} مشکل باز.`));
      return output({ summary: highlights.join(' '), confidence: 70, payload: { highlights } });
    }
    const bySystem = new Map<string, number>();
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const r of records) {
      const sys = str(r.service_system_node_id);
      if (sys) bySystem.set(sys, (bySystem.get(sys) ?? 0) + 1);
      const key = `${str(r.service_date)}|${sys}`;
      if (seen.has(key)) duplicates.push(str(r.id)!);
      else seen.set(key, str(r.id)!);
    }
    const recurring = [...bySystem.entries()].filter(([, n]) => n >= 2).map(([s]) => s);
    const last =
      records
        .map((r) => str(r.service_date))
        .filter((d): d is string => !!d)
        .sort()
        .at(-1) ?? null;
    return output({
      summary: records.length
        ? say(
            c.locale,
            `${records.length} service record(s); the latest on ${last}. ${recurring.length} recurring system(s), ${duplicates.length} possible duplicate(s).`,
            `${records.length} سابقه سرویس؛ آخرین مورد ${last}. ${recurring.length} سیستم تکرارشونده و ${duplicates.length} مورد احتمالاً تکراری.`,
          )
        : say(c.locale, 'No service history recorded yet.', 'هنوز سابقه سرویسی ثبت نشده است.'),
      confidence: 70,
      evidence: records.slice(0, 50).map((r) => ({ type: 'service_record', id: str(r.id)! })),
      payload: {
        record_count: records.length,
        last_service_date: last,
        recurring_system_node_ids: recurring.slice(0, 10),
        duplicate_record_ids: duplicates.slice(0, 50),
        next_maintenance: records.length
          ? say(c.locale, 'Plan the next regular service within six months.', 'سرویس دوره‌ای بعدی را ظرف شش ماه برنامه‌ریزی کنید.')
          : null,
      },
    });
  }

  #fleet(c: ToolCall): ToolOutput {
    const vehicles = arr(c.context.vehicles);
    const rank = (v: Json) => num(v.safety_issues) * 100 + num(v.open_issues) * 10 + num(v.overdue_reminders);
    const priorities = vehicles
      .filter((v) => rank(v) > 0)
      .sort((a, b) => rank(b) - rank(a) || String(a.id).localeCompare(String(b.id)))
      .slice(0, 100)
      .map((v) => ({
        vehicle_id: str(v.id)!,
        urgency: num(v.safety_issues) > 0 ? 'high' : num(v.open_issues) > 0 ? 'medium' : 'low',
        reason:
          num(v.safety_issues) > 0
            ? say(c.locale, 'Open safety-related issue.', 'مشکل باز مرتبط با ایمنی.')
            : num(v.open_issues) > 0
              ? say(c.locale, `${num(v.open_issues)} open issue(s).`, `${num(v.open_issues)} مشکل باز.`)
              : say(c.locale, `${num(v.overdue_reminders)} overdue reminder(s).`, `${num(v.overdue_reminders)} یادآور سررسیدشده.`),
      }));
    return output({
      summary: say(
        c.locale,
        `${priorities.length} of ${vehicles.length} vehicle(s) need attention.`,
        `${priorities.length} از ${vehicles.length} خودرو نیاز به رسیدگی دارد.`,
      ),
      confidence: 60,
      evidence: priorities.slice(0, 50).map((p) => ({ type: 'vehicle', id: p.vehicle_id })),
      payload: { priorities, preferred_provider_ids: arr<string>(c.context.preferred_provider_ids).slice(0, 10) },
    });
  }

  // ------------------------------------------------------------------ providers

  #profile(c: ToolCall): ToolOutput {
    const capabilities = arr(c.context.job_systems)
      .filter((j) => num(j.count) >= 1)
      .slice(0, 20)
      .map((j) => ({
        service_system_node_id: str(j.service_system_node_id)!,
        service_task_node_id: str(j.service_task_node_id),
        brand_node_id: str(j.brand_node_id),
        experience_level: num(j.count) >= 10 ? 'advanced' : num(j.count) >= 3 ? 'intermediate' : 'beginner',
        evidence_count: num(j.count),
      }));
    const coverage = arr(c.context.job_brands)
      .filter((b) => num(b.count) >= 1)
      .slice(0, 20)
      .map((b) => ({ brand_node_id: str(b.brand_node_id)!, model_node_id: str(b.model_node_id), evidence_count: num(b.count) }));
    const profileGaps = arr<string>(c.context.profile_gaps).slice(0, 7);
    const orgId = c.principal.organizationId!;
    const suggestions: ProposedSuggestion[] = profileGaps.map((g) => ({
      target: { type: 'organization', id: orgId },
      text: say(c.locale, `Complete your profile: ${g.replace('_', ' ')}.`, 'پروفایل خود را تکمیل کنید.'),
      action: 'review',
      payload: { profile_gap: g },
    }));
    return output({
      summary: say(
        c.locale,
        `${capabilities.length} capability and ${coverage.length} coverage suggestion(s) from your own job logs; ${profileGaps.length} profile gap(s).`,
        `${capabilities.length} پیشنهاد توانمندی و ${coverage.length} پیشنهاد پوشش خودرو از سوابق کاری شما؛ ${profileGaps.length} کمبود پروفایل.`,
      ),
      confidence: capabilities.length ? 55 : 30,
      evidence: arr<string>(c.context.evidence_job_log_ids).length
        ? arr<string>(c.context.evidence_job_log_ids)
            .slice(0, 50)
            .map((id) => ({ type: 'job_log', id }))
        : [{ type: 'provider_profile', id: str(c.context.evidence_profile_id)! }],
      payload: { capabilities, coverage, profile_gaps: profileGaps },
      suggestions,
    });
  }

  #reviewDraft(c: ToolCall): ToolOutput {
    const rating = num((c.context.review as Json | undefined)?.rating);
    const tone = (str(c.context.tone) ?? 'formal') as 'formal' | 'friendly' | 'brief';
    const en =
      rating >= 4
        ? {
            formal: 'Thank you for your feedback. We are glad the service met your expectations.',
            friendly: 'Thanks so much for the kind words! We are happy we could help.',
            brief: 'Thank you for your feedback.',
          }
        : {
            formal:
              'Thank you for your feedback. We are sorry your visit did not meet your expectations. Please contact us so we can look into it.',
            friendly: 'Thanks for telling us. We are sorry it was not a great visit; please get in touch so we can make it right.',
            brief: 'Thank you. Please contact us so we can look into this.',
          };
    const fa =
      rating >= 4
        ? {
            formal: 'از بازخورد شما سپاسگزاریم. خوشحالیم که خدمات مطابق انتظار شما بود.',
            friendly: 'خیلی ممنون از لطف شما! خوشحالیم که توانستیم کمک کنیم.',
            brief: 'از بازخورد شما سپاسگزاریم.',
          }
        : {
            formal: 'از بازخورد شما سپاسگزاریم. متأسفیم که مراجعه شما مطابق انتظار نبود. لطفاً با ما تماس بگیرید تا موضوع را بررسی کنیم.',
            friendly: 'ممنون که گفتید. متأسفیم که تجربه خوبی نبود؛ لطفاً با ما در تماس باشید تا جبران کنیم.',
            brief: 'سپاسگزاریم. لطفاً برای بررسی با ما تماس بگیرید.',
          };
    const draft = (c.locale === 'fa' ? fa : en)[tone];
    return output({
      summary: draft,
      confidence: 60,
      payload: { draft_text: draft, tone },
      safetyFlags: rating <= 2 ? ['legal_sensitive'] : [],
    });
  }

  #reviewThemes(c: ToolCall): ToolOutput {
    const reviews = arr(c.context.reviews);
    const tags = new Map<string, { count: number; sum: number }>();
    let sum = 0;
    for (const r of reviews) {
      sum += num(r.rating);
      for (const t of arr<string>(r.tag_keys)) {
        const e = tags.get(t) ?? { count: 0, sum: 0 };
        e.count += 1;
        e.sum += num(r.rating);
        tags.set(t, e);
      }
    }
    const themes = [...tags.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([tag_key, e]) => {
        const avg = e.sum / e.count;
        return { tag_key: tag_key.slice(0, 60), count: e.count, sentiment: avg >= 4 ? 'positive' : avg >= 3 ? 'neutral' : 'negative' };
      });
    const negative = themes.filter((t) => t.sentiment === 'negative').slice(0, 5);
    return output({
      summary: say(
        c.locale,
        `${reviews.length} review(s) in the period; ${themes.length} theme(s).`,
        `${reviews.length} نظر در این بازه؛ ${themes.length} موضوع.`,
      ),
      confidence: reviews.length >= 5 ? 70 : 40,
      payload: {
        review_count: reviews.length,
        average_rating: reviews.length ? (Math.round((sum / reviews.length) * 100) / 100).toFixed(2) : null,
        themes,
        improvement_suggestions: negative.map((t) =>
          say(
            c.locale,
            `Customers mention "${t.tag_key}" negatively; review this area.`,
            `مشتریان از «${t.tag_key}» ناراضی‌اند؛ این بخش را بررسی کنید.`,
          ),
        ),
      },
    });
  }

  #caption(c: ToolCall): ToolOutput {
    const labels = arr<string>(c.context.labels).slice(0, 10);
    const title = str(c.context.title) ?? say(c.locale, 'Recent work', 'کار اخیر');
    const caption = clip(labels.length ? `${title} — ${labels.join(', ')}` : title, 500);
    return output({
      summary: caption,
      confidence: 50,
      payload: {
        caption,
        tags: labels.map((l) => clip(l, 40)),
        draft_post: clip(
          say(c.locale, `Before and after: ${caption}.`, `قبل و بعد: ${caption}.`) +
            (num(c.context.media_count)
              ? say(c.locale, ` ${num(c.context.media_count)} photo(s).`, ` ${num(c.context.media_count)} عکس.`)
              : ''),
          2000,
        ),
      },
    });
  }

  #redaction(c: ToolCall): ToolOutput {
    // Vehicle photos: a plate is assumed in the lower centre (a real model detects it); a human applies or rejects.
    const media = arr<string>(c.context.image_media_ids)
      .slice(0, 20)
      .map((id) => ({ media_asset_id: id, regions: [{ kind: 'license_plate', x: 0.35, y: 0.75, w: 0.3, h: 0.1 }] }));
    return output({
      summary: say(
        c.locale,
        `${media.length} photo(s) may show a licence plate; check before publishing.`,
        `${media.length} عکس ممکن است پلاک داشته باشد؛ پیش از انتشار بررسی کنید.`,
      ),
      confidence: 30,
      safetyFlags: media.length ? ['privacy_sensitive'] : [],
      payload: { media },
    });
  }

  #duration(c: ToolCall): ToolOutput {
    const typical = num(c.context.typical_duration_minutes) || 60;
    const requested = num(c.context.estimated_duration_minutes);
    const conflicts = num(c.context.conflict_count);
    const need = clip(str(c.context.description_excerpt) ?? say(c.locale, 'No description.', 'بدون توضیح.'), 900);
    return output({
      summary: say(
        c.locale,
        `Plan about ${typical} minutes${conflicts ? `; ${conflicts} overlapping appointment(s)` : ''}.`,
        `حدود ${typical} دقیقه برنامه‌ریزی کنید${conflicts ? `؛ ${conflicts} نوبت هم‌پوشان` : ''}.`,
      ),
      confidence: 50,
      payload: {
        suggested_duration_minutes: Math.min(1440, Math.max(5, typical)),
        longer_than_requested: requested > 0 && typical > requested,
        conflict_count: conflicts,
        customer_need: need,
      },
    });
  }

  // ------------------------------------------------------------------ vendors

  #normalize(c: ToolCall): ToolOutput {
    const items = arr(c.context.items).slice(0, 500);
    const byName = new Map<string, string>();
    const out = items.map((it) => {
      const name = str(it.name) ?? '';
      const normalized =
        clip(
          name
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b([a-z])/g, (m) => m.toUpperCase()),
          200,
        ) || name;
      const key = normalized.toLowerCase();
      const dup = byName.get(key) ?? null;
      if (!dup) byName.set(key, str(it.id)!);
      const issues: string[] = [];
      if (num(it.image_count) === 0) issues.push('missing_image');
      if (!str(it.warranty_info)) issues.push('missing_warranty');
      if (dup) issues.push('possible_duplicate');
      if (normalized !== name) issues.push('name_changed');
      if (!str(it.part_category_node_id)) issues.push('category_missing');
      return {
        item_id: str(it.id)!,
        normalized_name: normalized,
        part_category_node_id: str(it.part_category_node_id),
        issues,
        duplicate_of_item_id: dup,
      };
    });
    const suggestions: ProposedSuggestion[] = out
      .filter((o) => o.issues.includes('name_changed'))
      .map((o) => ({
        target: { type: 'inventory_item', id: o.item_id },
        text: say(c.locale, `Use the name "${o.normalized_name}".`, `از نام «${o.normalized_name}» استفاده شود.`),
        action: 'update',
        payload: { normalized_name: o.normalized_name },
      }));
    return output({
      summary: say(
        c.locale,
        `${items.length} item(s) checked; ${suggestions.length} name change(s) suggested.`,
        `${items.length} قلم بررسی شد؛ ${suggestions.length} تغییر نام پیشنهاد شد.`,
      ),
      confidence: 60,
      payload: { items: out },
      suggestions,
    });
  }

  async #fitment(c: ToolCall): Promise<ToolOutput> {
    const norm = (t: string) => normalizeSearchText(t, { dbLocale: this.config.db.locale });
    const haystack = ` ${norm(c.userText.join(' '))} `;
    const { nodes } = await this.taxonomy.catalog();
    const rows: { brand_node_id: string; model_node_id: string | null; year_start: null; year_end: null; confidence: 'likely' }[] = [];
    const brands = nodes.filter((n) => n.type === 'vehicle_brand' && n.status === 'active');
    for (const b of brands) {
      if (rows.length >= 20) break;
      if (!Object.values(b.nameTranslations).some((t) => t && haystack.includes(` ${norm(t)} `))) continue;
      const models = nodes.filter(
        (m) =>
          m.type === 'vehicle_model' &&
          m.parentId === b.id &&
          m.status === 'active' &&
          Object.values(m.nameTranslations).some((t) => t && haystack.includes(` ${norm(t)} `)),
      );
      if (models.length)
        for (const m of models.slice(0, 20 - rows.length))
          rows.push({ brand_node_id: b.id, model_node_id: m.id, year_start: null, year_end: null, confidence: 'likely' });
      else rows.push({ brand_node_id: b.id, model_node_id: null, year_start: null, year_end: null, confidence: 'likely' });
    }
    return output({
      summary: rows.length
        ? say(
            c.locale,
            `${rows.length} likely fitment(s) from the item name; confirm each before it is shown.`,
            `${rows.length} سازگاری احتمالی از نام قلم؛ پیش از نمایش هر مورد را تأیید کنید.`,
          )
        : say(c.locale, 'No fitment could be suggested from the item details.', 'از مشخصات قلم سازگاری‌ای پیشنهاد نشد.'),
      confidence: rows.length ? 45 : 10,
      payload: { rows },
    });
  }

  #gaps(c: ToolCall): ToolOutput {
    const have = new Set(arr<string>(c.context.vendor_category_node_ids));
    const categories = arr(c.context.public_demand)
      .filter((d) => !have.has(String(d.part_category_node_id)))
      .slice(0, 20)
      .map((d) => ({
        part_category_node_id: str(d.part_category_node_id)!,
        demand_score: Math.min(100, Math.max(0, num(d.demand_score))),
      }));
    return output({
      summary: say(
        c.locale,
        `${categories.length} part categor(ies) to consider adding.`,
        `${categories.length} دسته قطعه برای افزودن پیشنهاد می‌شود.`,
      ),
      confidence: 40,
      payload: { categories },
    });
  }
}
