// /bff/* → the BFF's OAuth client, session view, CSRF token and pending intents (GD-03, P2.T2/T7).
import { handleBff } from '@/server/bff-runtime';

export const dynamic = 'force-dynamic';

export {
  handleBff as GET,
  handleBff as POST,
  handleBff as PUT,
  handleBff as PATCH,
  handleBff as DELETE,
  handleBff as HEAD,
  handleBff as OPTIONS,
};
