// One way for every script to start a headless browser, honouring PLAYWRIGHT_BROWSER from
// .env (the same setting the Playwright MCP uses): unset/"chromium" = Playwright's bundled
// Chromium (Linux default); "chrome" / "msedge" = the browser installed on the machine.
import { chromium } from 'playwright';
import { env } from './env.mjs';

export function launchBrowser({ headless = true } = {}) {
  const choice = env('PLAYWRIGHT_BROWSER', 'chromium').toLowerCase();
  const options = { headless, args: ['--no-sandbox'] };
  if (choice === 'chrome' || choice === 'msedge') options.channel = choice;
  return chromium.launch(options);
}
