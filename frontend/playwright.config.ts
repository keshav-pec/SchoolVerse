import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 5190;
const API_PORT = 4100;

/**
 * End-to-end tests run against the real app: the Vite dev server in front of a throw-away API
 * (in-memory MongoDB, demo seed). Nothing here touches your real database.
 *
 *   npm run e2e
 */
export default defineConfig({
  testDir: './e2e',
  // The flows share one seeded database, so run them one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 860 },
  },
  projects: [
    // The people, students and spaces specs use the seeded Mohali campus and the seeded ACTIVE session (Maths for VIII-A/B, Class VIII
    // sections, Class VI languages). The academics and locations specs later replace that session and deactivate Mohali, so
    // these run first, on purpose.
    {
      name: 'people',
      testMatch: /(people|students|spaces)-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
    {
      name: 'chromium',
      testIgnore: /(people|students|spaces)-.*\.spec\.ts/,
      dependencies: ['people'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } },
    },
  ],
  webServer: [
    {
      command: 'npm --prefix ../backend run e2e:server',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
