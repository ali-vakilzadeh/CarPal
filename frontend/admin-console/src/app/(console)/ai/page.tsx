// AC13: AI oversight (A-AI-01) and the read-only list of AI insights (A-AI-02 until backend BR-14), for platform
// admins and moderators; other roles see the no-permission state (D-26).
import type { Metadata } from 'next';
import { AiPage } from '@/features/ai';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('ai', 'admin.ai.title');
}

export default function Page() {
  return (
    <SectionGate slug="ai">
      <AiPage />
    </SectionGate>
  );
}
