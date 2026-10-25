// Full-page navigations that leave the App Router (the BFF's /bff/login → hosted sign-in). One seam, so tests can
// observe them (jsdom cannot navigate).
export function goTo(url: string): void {
  window.location.assign(url);
}
