// /id/oauth/* → the auth host (dev topology of GD-05, P2.T3); /oauth/token and /oauth/revoke are refused here.
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
