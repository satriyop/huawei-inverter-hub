import puppeteer, { Browser, Page, Cookie as PuppeteerCookie } from 'puppeteer';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { SessionInfo, Cookie } from '../types/fusionsolar.js';

export class FusionSolarAuthenticator {
  private browser: Browser | null = null;
  private sessionInfo: SessionInfo | null = null;

  /**
   * Login to FusionSolar and extract session cookies
   */
  async login(): Promise<SessionInfo> {
    logger.info('Starting FusionSolar login...');

    try {
      // Launch browser
      this.browser = await puppeteer.launch({
        headless: config.crawler.headless,
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

      this.sessionInfo = {
        cookies,
        isAlive: true,
        lastChecked: new Date(),
      };

      logger.info('Login successful! Session cookies extracted.');

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
          .map((el) => el.textContent)
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
