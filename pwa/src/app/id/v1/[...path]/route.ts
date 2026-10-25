// /id/v1/auth/* → the auth host's hosted sign-in endpoints, same origin as the sign-in UI (GD-05, P2.T3).
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
