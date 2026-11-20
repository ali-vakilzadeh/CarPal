// AC13: MCP clients (A-MCP-01) and the MCP access log (A-MCP-02), for platform admins (AI governance); other roles see
// the no-permission state (D-26).
import type { Metadata } from 'next';
import { McpPage } from '@/features/mcp';
import { SectionGate, sectionMetadata } from '@/server/section-page';

export function generateMetadata(): Promise<Metadata> {
  return sectionMetadata('mcp', 'admin.mcp.title');
}

export default function Page() {
  return (
    <SectionGate slug="mcp">
      <McpPage />
    </SectionGate>
  );
}
