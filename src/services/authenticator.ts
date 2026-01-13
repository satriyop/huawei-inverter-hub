import puppeteer, { Browser, Page, Protocol } from 'puppeteer';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { SessionInfo, Cookie } from '../types/fusionsolar.js';

type PuppeteerCookie = Protocol.Network.Cookie;

export class FusionSolarAuthenticator {
  private browser: Browser | null = null;
  private sessionInfo: SessionInfo | null = null;

  /**
   * Login to FusionSolar and extract session cookies
   */
  async login(): Promise<SessionInfo> {
    logger.info('Starting FusionSolar login...');

    try {
      // Launch browser using system Chrome (more reliable on macOS)
      this.browser = await puppeteer.launch({
        headless: config.crawler.headless,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
        ],
      });

      const page = await this.browser.newPage();

      // Set viewport
      await page.setViewport({ width: 1920, height: 1080 });

      // Set user agent to avoid detection
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Navigate to login page
      logger.info('Navigating to login page...');
      await page.goto(config.fusionSolar.loginUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      // Wait for login form to load
      await this.waitForLoginForm(page);

      // Enter credentials
      logger.info('Entering credentials...');
      await this.enterCredentials(page);

      // Submit login
      logger.info('Submitting login...');
      await this.submitLogin(page);

      // Wait for successful login (redirect to monitoring page)
      logger.info('Waiting for login completion...');
      await this.waitForLoginSuccess(page);

      // Extract cookies
      const cookies = await this.extractCookies(page);

      // Extract zone-id from URL
      const currentUrl = page.url();
      const zoneIdMatch = currentUrl.match(/zone-id=([^&]+)/);
      const zoneId = zoneIdMatch ? zoneIdMatch[1] : undefined;

      this.sessionInfo = {
        cookies,
        isAlive: true,
        lastChecked: new Date(),
        zoneId,
      };

      logger.info('Login successful! Session cookies extracted.');
      if (zoneId) {
        logger.info(`Zone ID: ${zoneId}`);
      }

      return this.sessionInfo;
    } catch (error) {
      logger.error('Login failed:', error);
      throw error;
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }
  }

  /**
   * Wait for login form to be ready
   */
  private async waitForLoginForm(page: Page): Promise<void> {
    // Try multiple selectors as the form structure may vary
    const selectors = [
      'input[type="text"]',
      'input[placeholder*="account"]',
      'input[placeholder*="Account"]',
      'input[name="userName"]',
      '#username',
    ];

    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        logger.info(`Found login form with selector: ${selector}`);
        return;
      } catch {
        continue;
      }
    }

    // Take screenshot for debugging
    await page.screenshot({ path: 'logs/login-form-not-found.png' });
    throw new Error('Login form not found');
  }

  /**
   * Enter username and password
   */
  private async enterCredentials(page: Page): Promise<void> {
    // Find and fill username field
    const usernameSelectors = [
      'input[type="text"]:not([type="password"])',
      'input[placeholder*="account"]',
      'input[placeholder*="Account"]',
      'input[name="userName"]',
      '#username',
    ];

    let usernameEntered = false;
    for (const selector of usernameSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click({ clickCount: 3 }); // Select all
          await element.type(config.fusionSolar.username, { delay: 50 });
          usernameEntered = true;
          logger.info(`Username entered using selector: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!usernameEntered) {
      throw new Error('Could not find username input field');
    }

    // Small delay between fields
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Find and fill password field
    const passwordSelectors = [
      'input[type="password"]',
      'input[placeholder*="password"]',
      'input[placeholder*="Password"]',
      'input[name="password"]',
      '#password',
    ];

    let passwordEntered = false;
    for (const selector of passwordSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          await element.type(config.fusionSolar.password, { delay: 50 });
          passwordEntered = true;
          logger.info(`Password entered using selector: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!passwordEntered) {
      throw new Error('Could not find password input field');
    }
  }

  /**
   * Submit the login form
   */
  private async submitLogin(page: Page): Promise<void> {
    // Try clicking login button
    const buttonSelectors = [
      'button[type="submit"]',
      'button:has-text("Log In")',
      'button:has-text("Login")',
      'button:has-text("Sign In")',
      '.login-btn',
      '#login-btn',
      'button.primary',
    ];

    for (const selector of buttonSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click();
          logger.info(`Clicked login button using selector: ${selector}`);
          return;
        }
      } catch {
        continue;
      }
    }

    // Fallback: press Enter
    logger.info('No button found, pressing Enter...');
    await page.keyboard.press('Enter');
  }

  /**
   * Wait for successful login redirect
   */
  private async waitForLoginSuccess(page: Page): Promise<void> {
    try {
      // Wait for URL to change to monitoring page
      await page.waitForFunction(
        () => {
          const url = window.location.href;
          return (
            url.includes('/home/') ||
            url.includes('/view/') ||
            url.includes('/monitoring') ||
            url.includes('cloud.html')
          );
        },
        { timeout: 30000 }
      );

      // Additional wait for page to stabilize
      await new Promise((resolve) => setTimeout(resolve, 3000));

      logger.info(`Login successful, redirected to: ${page.url()}`);
    } catch (error) {
      // Take screenshot for debugging
      await page.screenshot({ path: 'logs/login-failed.png' });

      // Check for error messages
      const errorText = await page.evaluate(() => {
        const errorElements = document.querySelectorAll(
          '.error, .alert, [class*="error"], [class*="alert"]'
        );
        return Array.from(errorElements)
          .map((el: Element) => el.textContent)
          .join(', ');
      });

      if (errorText) {
        throw new Error(`Login failed: ${errorText}`);
      }

      throw new Error('Login timed out - no redirect detected');
    }
  }

  /**
   * Extract cookies from browser session
   */
  private async extractCookies(page: Page): Promise<Cookie[]> {
    const puppeteerCookies = await page.cookies();

    return puppeteerCookies.map((cookie: PuppeteerCookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
    }));
  }

  /**
   * Login and make initial API calls from within browser session
   * This ensures all correct headers and credentials are used
   */
  async loginAndFetchStations(): Promise<{
    session: SessionInfo;
    stations: unknown[];
  }> {
    logger.info('Starting FusionSolar login with API fetch...');

    try {
      // Launch browser using system Chrome
      this.browser = await puppeteer.launch({
        headless: config.crawler.headless,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
        ],
      });

      const page = await this.browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Navigate and login
      logger.info('Navigating to login page...');
      await page.goto(config.fusionSolar.loginUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      await this.waitForLoginForm(page);
      logger.info('Entering credentials...');
      await this.enterCredentials(page);
      logger.info('Submitting login...');
      await this.submitLogin(page);
      logger.info('Waiting for login completion...');
      await this.waitForLoginSuccess(page);

      // Extract cookies and zone ID
      const cookies = await this.extractCookies(page);
      const currentUrl = page.url();
      // Zone ID ends at & or # (hash fragment)
      const zoneIdMatch = currentUrl.match(/zone-id=([^&#]+)/);
      const zoneId = zoneIdMatch ? zoneIdMatch[1] : undefined;

      logger.info('Login successful! Waiting for station data to load...');

      // Wait for the page to be fully loaded with station data
      // The station cards should have station names
      try {
        await page.waitForSelector('[class*="station"], [class*="plant"], [data-testid*="station"]', {
          timeout: 15000,
        });
      } catch {
        logger.info('No station selectors found, trying to extract from page state...');
      }

      // Additional wait for JavaScript to finish
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Wait a bit more for the data to fully render
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Take a screenshot for debugging
      await page.screenshot({ path: 'logs/station-page.png', fullPage: true });
      logger.info('Screenshot saved to logs/station-page.png');

      // Try to extract station data from the page's DOM
      const stations = await page.evaluate(() => {
        const results: Array<{
          stationName: string;
          stationDn: string;
          currentPower: string | null;
          yieldToday: string | null;
        }> = [];

        // Method 1: Look for node-name elements with ID containing NE=
        // Pattern: <span class="node-name" id="monitor-layout-node-name-NE=69233242">SITESANANIBUN</span>
        const nodeNameElements = document.querySelectorAll('span.node-name[id*="NE="]');
        nodeNameElements.forEach((el) => {
          const id = el.getAttribute('id') || '';
          const dnMatch = id.match(/NE=(\d+)/);
          const name = el.textContent?.trim();

          if (dnMatch && name) {
            results.push({
              stationName: name,
              stationDn: `NE=${dnMatch[1]}`,
              currentPower: null,
              yieldToday: null,
            });
          }
        });

        // Method 2: Look for elements with title attribute containing station name
        if (results.length === 0) {
          const titledElements = document.querySelectorAll('[title]');
          titledElements.forEach((el) => {
            const title = el.getAttribute('title') || '';
            const id = el.getAttribute('id') || '';
            // Check if this looks like a station name (uppercase alphanumeric)
            if (/^[A-Z0-9]+$/.test(title) && title.length > 3) {
              // Try to find station DN from ID
              const dnMatch = id.match(/(\d+)$/);
              if (dnMatch) {
                results.push({
                  stationName: title,
                  stationDn: `NE=${dnMatch[1]}`,
                  currentPower: null,
                  yieldToday: null,
                });
              }
            }
          });
        }

        // Deduplicate by stationDn
        const unique = results.filter((item, index, self) =>
          index === self.findIndex((t) => t.stationDn === item.stationDn)
        );

        return {
          found: unique.length,
          stations: unique,
        };
      });

      logger.info(`DOM extraction found ${stations.found} stations`);
      stations.stations.forEach((s) => {
        logger.info(`  - ${s.stationName} (${s.stationDn})`);
      });

      // Now fetch detailed data for each station using browser fetch
      for (const station of stations.stations) {
        logger.info(`Fetching data for ${station.stationName}...`);

        // Get energy balance using browser fetch
        const energyData = await page.evaluate(async (stationDn: string) => {
          try {
            const queryTime = new Date().setHours(0, 0, 0, 0);
            const date = new Date();
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} 00:00:00`;

            const params = new URLSearchParams({
              stationDn,
              timeDim: '2',
              timeZone: '7.0',
              timeZoneStr: 'Asia/Jakarta',
              queryTime: String(queryTime),
              dateStr,
              _: String(Date.now()),
            });

            const response = await fetch(`/rest/pvms/web/station/v3/overview/energy-balance?${params}`);

            if (!response.ok) {
              return { error: `HTTP ${response.status}`, data: null };
            }

            const data = await response.json();
            return { error: null, data };
          } catch (error) {
            return { error: String(error), data: null };
          }
        }, station.stationDn);

        // Update station with energy data
        if (energyData.data?.success && energyData.data?.data) {
          const data = energyData.data.data;
          // Try different field names for power/energy
          station.currentPower = data.realTimePower?.toString() ||
            data.currentPower?.toString() ||
            data.power?.toString() || null;
          station.yieldToday = data.dayEnergy?.toString() ||
            data.yieldToday?.toString() ||
            data.dailyEnergy?.toString() || null;

          logger.info(`  Energy data available: existInverter=${data.existInverter}, existMeter=${data.existMeter}`);
          // Log a summary of what data we got
          const keys = Object.keys(data);
          logger.info(`  Available fields: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? '...' : ''}`);
        } else if (energyData.error) {
          logger.warn(`  Error: ${energyData.error}`);
        }
      }

      this.sessionInfo = {
        cookies,
        isAlive: true,
        lastChecked: new Date(),
        zoneId,
      };

      // Extract station list from DOM results
      const stationList = stations.stations || [];

      return {
        session: this.sessionInfo,
        stations: stationList,
      };
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }
  }

  /**
   * Get current session info
   */
  getSession(): SessionInfo | null {
    return this.sessionInfo;
  }

  /**
   * Check if session is valid (has required cookies)
   */
  isSessionValid(): boolean {
    if (!this.sessionInfo) return false;

    // Check for required cookies
    const requiredCookieNames = ['JSESSIONID', 'XSRF-TOKEN'];
    const cookieNames = this.sessionInfo.cookies.map((c) => c.name);

    return requiredCookieNames.some((name) => cookieNames.includes(name));
  }

  /**
   * Convert cookies to Axios cookie header format
   */
  getCookieHeader(): string {
    if (!this.sessionInfo) return '';

    return this.sessionInfo.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  /**
   * Get cookies as object for Axios
   */
  getCookiesObject(): Record<string, string> {
    if (!this.sessionInfo) return {};

    return this.sessionInfo.cookies.reduce(
      (acc, cookie) => {
        acc[cookie.name] = cookie.value;
        return acc;
      },
      {} as Record<string, string>
    );
  }
}

export default FusionSolarAuthenticator;
