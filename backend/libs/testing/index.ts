// L22 testing (41 §2.2, §8): HTTP client, fixtures with RLS kept real, and
// BOLA/BFLA matrices from the operation registry. The app factory that
// composes deployables lives in apps/testing (libs never import apps).
export { send, TEST_CLIENT, type TestRequest, type TestResponse } from './http-client.js';
export { Fixtures, clientHeader, type TestOrg, type TestUser, type TokenOptions } from './fixtures.js';
export {
  routeMatrix,
  PrincipalFactory,
  type DeniedSpec,
  type MaterializedRequest,
  type PrincipalSpec,
  type RouteMatrix,
} from './matrix.js';
export { tinyMp4, jpegWithExif, tinyPdf, EICAR_TEXT } from './media.js';
