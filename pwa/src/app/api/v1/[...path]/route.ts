// /api/v1/* → the BFF forwarder (GD-03, P2.T4): consumer operations 1:1 to the api host.
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
