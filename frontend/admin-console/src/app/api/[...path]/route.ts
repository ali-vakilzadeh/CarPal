// /api/* → the admin BFF forwarder (AC3.T4): admin operations 1:1 to admin-api; every other /api path answers 404 problem+json.
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
