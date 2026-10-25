// Runs once when the server starts: fail fast on an invalid environment (P1.T7).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { serverEnv } = await import('./server/env');
    serverEnv();
  }
}
