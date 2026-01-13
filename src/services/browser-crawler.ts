/**
 * BrowserCrawler - Unified browser-based FusionSolar data extraction
 *
 * Key design decisions:
 * - Single browser session for entire crawl cycle
 * - All API calls via page.evaluate(fetch()) to maintain session context
 * - DOM extraction as fallback/primary for station discovery
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type {
  CrawlResult,
  StationCrawlResult,
  DeviceCrawlResult,
  CrawlError,
  EnergyBalance,
  StationRealTimeKpi,
  EnvironmentalData,
} from '../types/fusionsolar.js';

// Extended types for browser-based extraction
export interface BrowserStation {
  stationDn: string;
  stationName: string;
  capacity?: number;
  gridConnectionDate?: string;
  address?: string;
}

export interface BrowserEnergyData {
  // Energy balance
  generatedByPV: number;
  consumedFromPV: number;
  fedToGrid: number;
  consumedByAppliances: number;
  fromGrid: number;

  // Real-time
  realTimePower: number;
  dayEnergy: number;
  totalEnergy: number;

  // Environmental
  standardCoalSaved: number;
  co2Avoided: number;
  treesPlanted: number;

  // Raw data for debugging
  rawData?: Record<string, unknown>;
}

export interface BrowserDevice {
  deviceDn: string;
  deviceName: string;
  deviceType: string;
  deviceTypeId?: number;
  model?: string;
  status?: string;
  communicationStatus?: string;
  serialNumber?: string;
  softwareVersion?: string;
  stationDn?: string;
  // Real-time data
  activePower?: number;
  dailyEnergy?: number;
  totalYield?: number;
  gridVoltage?: number;
  gridCurrent?: number;
  gridFrequency?: number;
  temperature?: number;
  powerFactor?: number;
  efficiency?: number;
  inputPower?: number;
}

export class BrowserCrawler {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn = false;
  private zoneId: string | null = null;
  private lastLoginTime: number = 0;
  private sessionValidityMinutes = 25; // FusionSolar session typically expires after 30 min

  /**
   * Start the browser
   */
  async start(): Promise<void> {
    logger.info('Starting browser...');

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

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    logger.info('Browser started');
  }

  /**
   * Login to FusionSolar
   */
  async login(): Promise<void> {
    if (!this.page) throw new Error('Browser not started');

    logger.info('Navigating to login page...');
    await this.page.goto(config.fusionSolar.loginUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // Wait for login form
    await this.waitForLoginForm();

    // Enter credentials
    logger.info('Entering credentials...');
    await this.enterCredentials();

    // Submit login
    logger.info('Submitting login...');
    await this.submitLogin();

    // Wait for successful login
    logger.info('Waiting for login completion...');
    await this.waitForLoginSuccess();

    // Extract zone ID from URL
    const currentUrl = this.page.url();
    const zoneIdMatch = currentUrl.match(/zone-id=([^&#]+)/);
    this.zoneId = zoneIdMatch ? zoneIdMatch[1] : null;

    this.isLoggedIn = true;
    this.lastLoginTime = Date.now();
    logger.info('Login successful!');
    if (this.zoneId) {
      logger.info(`Zone ID: ${this.zoneId}`);
    }

    // Take screenshot for debugging
    await this.screenshot('login-success');
  }

  /**
   * Get all stations from the current page
   */
  async getStations(): Promise<BrowserStation[]> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info('Waiting for station data to load...');

    // Wait for station elements to appear (with longer timeout)
    try {
      await this.page.waitForSelector(
        'span.node-name[id*="NE="], [class*="station"], [class*="plant"]',
        { timeout: 20000 }
      );
      logger.info('Station elements detected');
    } catch {
      logger.warn('No station elements found after 20s, trying anyway...');
    }

    // Additional wait for data to stabilize
    await this.delay(5000);

    // Take screenshot for debugging
    await this.screenshot('before-station-extraction');

    logger.info('Extracting stations from DOM...');

    const stations = await this.page.evaluate(() => {
      const results: BrowserStation[] = [];

      // Method 1: Look for node-name elements with ID containing NE=
      const nodeNameElements = document.querySelectorAll('span.node-name[id*="NE="]');
      nodeNameElements.forEach((el) => {
        const id = el.getAttribute('id') || '';
        const dnMatch = id.match(/NE=(\d+)/);
        const name = el.textContent?.trim();

        if (dnMatch && name) {
          results.push({
            stationDn: `NE=${dnMatch[1]}`,
            stationName: name,
          });
        }
      });

      // Method 2: Look for elements with title attribute
      if (results.length === 0) {
        const titledElements = document.querySelectorAll('[title]');
        titledElements.forEach((el) => {
          const title = el.getAttribute('title') || '';
          const id = el.getAttribute('id') || '';
          if (/^[A-Z0-9]+$/.test(title) && title.length > 3) {
            const dnMatch = id.match(/(\d+)$/);
            if (dnMatch) {
              results.push({
                stationDn: `NE=${dnMatch[1]}`,
                stationName: title,
              });
            }
          }
        });
      }

      // Deduplicate
      const unique = results.filter(
        (item, index, self) => index === self.findIndex((t) => t.stationDn === item.stationDn)
      );

      return unique;
    });

    logger.info(`Found ${stations.length} stations via DOM extraction`);
    stations.forEach((s) => logger.info(`  - ${s.stationName} (${s.stationDn})`));

    return stations;
  }

  /**
   * Get energy balance and real-time data for a station
   */
  async getEnergyData(stationDn: string): Promise<BrowserEnergyData | null> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info(`Fetching energy data for ${stationDn}...`);

    const result = await this.page.evaluate(async (dn: string) => {
      try {
        const queryTime = new Date().setHours(0, 0, 0, 0);
        const date = new Date();
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} 00:00:00`;

        const params = new URLSearchParams({
          stationDn: dn,
          timeDim: '2', // Daily
          timeZone: '7.0',
          timeZoneStr: 'Asia/Jakarta',
          queryTime: String(queryTime),
          dateStr,
          _: String(Date.now()),
        });

        const response = await fetch(
          `/rest/pvms/web/station/v3/overview/energy-balance?${params}`
        );

        if (!response.ok) {
          return { error: `HTTP ${response.status}`, data: null };
        }

        const json = await response.json();
        return { error: null, data: json };
      } catch (error) {
        return { error: String(error), data: null };
      }
    }, stationDn);

    if (result.error) {
      logger.warn(`  Energy data error: ${result.error}`);
      return null;
    }

    if (!result.data?.success || !result.data?.data) {
      logger.warn('  Energy data: API returned unsuccessful response');
      logger.debug(`  Raw response: ${JSON.stringify(result.data)}`);
      return null;
    }

    const data = result.data.data;

    // Log available fields for debugging
    const keys = Object.keys(data);
    logger.info(`  Available fields: ${keys.slice(0, 20).join(', ')}${keys.length > 20 ? '...' : ''}`);
    logger.debug(`  Raw energy data: ${JSON.stringify(data, null, 2)}`);

    // Map the response to our structure
    // FusionSolar uses these field names for daily totals:
    // - totalProductPower: Total generated by PV
    // - totalSelfUsePower: Consumed from PV (self-consumption)
    // - totalOnGridPower: Fed to grid
    // - totalBuyPower: Consumed from grid
    // - totalUsePower: Total consumption

    const energyData: BrowserEnergyData = {
      // Energy balance - use total* fields from API
      generatedByPV: this.parseNumber(data.totalProductPower),
      consumedFromPV: this.parseNumber(data.totalSelfUsePower),
      fedToGrid: this.parseNumber(data.totalOnGridPower),
      consumedByAppliances: this.parseNumber(data.totalUsePower),
      fromGrid: this.parseNumber(data.totalBuyPower),

      // Real-time - need separate API endpoint for real-time power
      realTimePower: this.parseNumber(data.realTimePower || data.stationPower || 0),
      dayEnergy: this.parseNumber(data.totalProductPower),
      totalEnergy: this.parseNumber(data.totalEnergy || 0),

      // Environmental - check various field names
      standardCoalSaved: this.parseNumber(data.coalSave || data.standardCoalSaved || 0),
      co2Avoided: this.parseNumber(data.co2 || data.co2Avoided || 0),
      treesPlanted: this.parseNumber(data.tree || data.treesPlanted || 0),

      // Keep raw data for debugging
      rawData: data,
    };

    logger.info(`  Parsed: Generated=${energyData.generatedByPV}kWh, FromGrid=${energyData.fromGrid}kWh, Used=${energyData.consumedByAppliances}kWh`);

    logger.info(`  Energy data retrieved successfully`);
    return energyData;
  }

  /**
   * Get device list for a station
   */
  async getDevices(stationDn: string): Promise<BrowserDevice[]> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info(`Fetching devices for ${stationDn}...`);

    const result = await this.page.evaluate(async (dn: string) => {
      try {
        const params = new URLSearchParams({
          'conditionParams.checkShareStationDn': dn,
          'conditionParams.parentDn': dn,
          'conditionParams.curPage': '1',
          'conditionParams.recordperpage': '100',
          'conditionParams.sortType': 'BY_DEVICE_NAME',
          'conditionParams.maintenance': 'false',
          _: String(Date.now()),
        });

        const response = await fetch(
          `/rest/neteco/web/config/device/v1/device-list?${params}`
        );

        if (!response.ok) {
          return { error: `HTTP ${response.status}`, data: null };
        }

        const json = await response.json();
        return { error: null, data: json };
      } catch (error) {
        return { error: String(error), data: null };
      }
    }, stationDn);

    if (result.error) {
      logger.warn(`  Device list error: ${result.error}`);
      return [];
    }

    // Extract devices from response
    const devices: BrowserDevice[] = [];
    const rawDevices = result.data?.data || result.data || [];

    // Log raw response for debugging
    if (rawDevices.length > 0) {
      const sample = rawDevices[0];
      logger.info(`  Device fields: ${Object.keys(sample).join(', ')}`);
      logger.debug(`  Sample device: ${JSON.stringify(sample, null, 2)}`);
    }

    if (Array.isArray(rawDevices)) {
      for (const d of rawDevices) {
        // Use mocTypeName if available (human-readable type from API)
        // Otherwise map from typeId or moType
        const deviceType = d.mocTypeName || this.mapDeviceType(d.typeId || d.moType || d.devTypeId);
        const typeId = parseInt(String(d.typeId || d.moType || d.devTypeId || 0), 10);

        // Parse device status - FusionSolar uses different status fields
        // deviceStatus: numeric code, status: string, communication: connection status
        const deviceStatus = d.deviceStatus || d.status || d.runStatus;
        const commStatus = d.communication;

        devices.push({
          deviceDn: d.dn || d.deviceDn,
          deviceName: d.name || d.deviceName || d.moName,
          deviceType,
          deviceTypeId: typeId || undefined,
          model: d.model || d.devModel || d.invType,
          status: deviceStatus,
          communicationStatus: commStatus,
          serialNumber: d.sn || d.esn || d.serialNumber,
          stationDn: d.stationKey || d.parentDn,
        });
      }
    }

    logger.info(`  Found ${devices.length} devices`);
    return devices;
  }

  /**
   * Get real-time data for a device (inverter)
   */
  async getDeviceData(deviceDn: string): Promise<Partial<BrowserDevice> | null> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.debug(`  Fetching realtime data for device ${deviceDn}...`);

    const result = await this.page.evaluate(async (dn: string) => {
      try {
        const params = new URLSearchParams({
          deviceDn: dn,
          displayAccessModel: 'true',
          _: String(Date.now()),
        });

        const response = await fetch(
          `/rest/pvms/web/device/v1/device-realtime-data?${params}`
        );

        if (!response.ok) {
          return { error: `HTTP ${response.status}`, data: null };
        }

        const json = await response.json();
        return { error: null, data: json };
      } catch (error) {
        return { error: String(error), data: null };
      }
    }, deviceDn);

    if (result.error) {
      logger.debug(`    Device data error: ${result.error}`);
      return null;
    }

    if (!result.data) {
      return null;
    }

    const data = result.data.data || result.data;

    // Log available fields for debugging
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      if (keys.length > 0) {
        logger.debug(`    Device data fields: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? '...' : ''}`);
      }
    }

    // Extract all available real-time data
    // FusionSolar uses various field names depending on device type
    const realtimeData: Partial<BrowserDevice> = {
      activePower: this.parseNumber(
        data.activePower || data.active_power || data.outputPower || data.power
      ),
      dailyEnergy: this.parseNumber(
        data.dailyEnergy || data.day_cap || data.dayEnergy || data.todayEnergy
      ),
      totalYield: this.parseNumber(
        data.totalYield || data.total_cap || data.totalEnergy || data.cumulativeEnergy
      ),
      gridVoltage: this.parseNumber(
        data.gridVoltage || data.ab_u || data.uab || data.a_u || data.voltage
      ),
      gridCurrent: this.parseNumber(
        data.gridCurrent || data.a_i || data.current || data.outputCurrent
      ),
      gridFrequency: this.parseNumber(
        data.gridFrequency || data.frequency || data.elec_freq
      ),
      temperature: this.parseNumber(
        data.temperature || data.inverterTemperature || data.internalTemp || data.temp
      ),
      powerFactor: this.parseNumber(
        data.powerFactor || data.power_factor || data.pf
      ),
      efficiency: this.parseNumber(
        data.efficiency || data.inverterEfficiency
      ),
      inputPower: this.parseNumber(
        data.inputPower || data.dcPower || data.pv_power
      ),
      status: data.status || data.runStatus || data.state,
      softwareVersion: data.softwareVersion || data.softVer || data.sw_version,
    };

    // Log non-zero values for debugging
    const nonZeroFields = Object.entries(realtimeData)
      .filter(([, v]) => v !== 0 && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`);
    if (nonZeroFields.length > 0) {
      logger.debug(`    Device has data: ${nonZeroFields.join(', ')}`);
    }

    return realtimeData;
  }

  /**
   * Run a complete crawl cycle
   */
  async crawl(): Promise<CrawlResult> {
    const startTime = Date.now();
    const errors: CrawlError[] = [];
    const stationResults: StationCrawlResult[] = [];

    try {
      // Ensure we have a valid session before crawling
      await this.ensureValidSession();

      // Get all stations with retry
      const stations = await this.withRetry(
        () => this.getStations(),
        {
          maxRetries: 3,
          onRetry: (attempt, error) => {
            logger.warn(`Station fetch attempt ${attempt} failed: ${error.message}`);
          },
        }
      );

      if (stations.length === 0) {
        logger.warn('No stations found');
        return {
          timestamp: new Date(),
          stations: [],
          success: true,
          errors,
          duration: Date.now() - startTime,
        };
      }

      // Crawl each station
      for (const station of stations) {
        try {
          logger.info(`\nCrawling station: ${station.stationName}`);

          // Get energy data
          const energyData = await this.getEnergyData(station.stationDn);
          await this.delay(1000);

          // Get devices
          const devices = await this.getDevices(station.stationDn);
          await this.delay(1000);

          // Get data for each device
          const deviceResults: DeviceCrawlResult[] = [];
          for (const device of devices) {
            const deviceData = await this.getDeviceData(device.deviceDn);
            if (deviceData) {
              Object.assign(device, deviceData);
            }

            // Map device status to expected type
            const deviceStatus = this.mapDeviceStatus(device.status);

            deviceResults.push({
              device: {
                deviceDn: device.deviceDn,
                deviceName: device.deviceName,
                deviceType: device.deviceType as 'Inverter',
                deviceModel: device.model || '',
                softwareVersion: device.softwareVersion || '',
                stationDn: station.stationDn,
                status: deviceStatus,
              },
              realtimeData: {
                deviceDn: device.deviceDn,
                deviceName: device.deviceName,
                status: device.status || 'unknown',
                dailyEnergy: device.dailyEnergy || 0,
                totalYield: device.totalYield || 0,
                activePower: device.activePower || 0,
                reactivePower: 0,
                ratedPower: 0,
                powerFactor: device.powerFactor || 0,
                gridFrequency: device.gridFrequency || 0,
                gridVoltage: device.gridVoltage || 0,
                gridCurrent: device.gridCurrent || 0,
                internalTemperature: device.temperature || 0,
                insulationResistance: 0,
                outputMode: '',
                startupTime: '',
                shutdownTime: '',
                pvStrings: [],
                efficiency: device.efficiency,
                inputPower: device.inputPower,
              },
            });
            await this.delay(500);
          }

          // Build station result
          const realtimeKpi: StationRealTimeKpi = {
            stationDn: station.stationDn,
            currentPower: energyData?.realTimePower || 0,
            yieldToday: energyData?.dayEnergy || 0,
            totalYield: energyData?.totalEnergy || 0,
            revenueToday: 0,
            ratedPower: station.capacity || 0,
            ratedESSCapacity: 0,
          };

          const energyBalance: EnergyBalance = {
            stationDn: station.stationDn,
            date: new Date().toISOString().split('T')[0],
            timeDim: 2,
            generatedByPV: energyData?.generatedByPV || 0,
            consumedFromPV: energyData?.consumedFromPV || 0,
            fedToGrid: energyData?.fedToGrid || 0,
            consumedByAppliances: energyData?.consumedByAppliances || 0,
            fromPV: energyData?.generatedByPV || 0,
            fromGrid: energyData?.fromGrid || 0,
          };

          const environmental: EnvironmentalData = {
            standardCoalSaved: energyData?.standardCoalSaved || 0,
            co2Avoided: energyData?.co2Avoided || 0,
            equivalentTreesPlanted: energyData?.treesPlanted || 0,
          };

          stationResults.push({
            station: {
              stationDn: station.stationDn,
              stationCode: station.stationDn,
              stationName: station.stationName,
              address: station.address || '',
              country: 'Indonesia',
              gridConnectionDate: station.gridConnectionDate || '',
              capacity: station.capacity || 0,
              ratedPower: station.capacity || 0,
              timeZone: 7,
              timeZoneStr: 'Asia/Jakarta',
              status: 'normal',
            },
            realtimeKpi,
            energyBalance,
            devices: deviceResults,
            alarms: [],
            environmental,
          });

          logger.info(`  ✓ Station crawled successfully`);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(`  ✗ Failed to crawl station: ${err.message}`);

          // Capture error state for debugging
          await this.captureErrorState(err, `station-${station.stationDn}`);

          errors.push({
            stationDn: station.stationDn,
            endpoint: 'crawlStation',
            message: err.message,
            timestamp: new Date(),
          });
        }
      }

      return {
        timestamp: new Date(),
        stations: stationResults,
        success: errors.length === 0,
        errors,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Crawl failed: ${err.message}`);

      // Capture error state for debugging
      await this.captureErrorState(err, 'crawl-main');

      return {
        timestamp: new Date(),
        stations: stationResults,
        success: false,
        errors: [
          ...errors,
          {
            endpoint: 'crawl',
            message: err.message,
            timestamp: new Date(),
          },
        ],
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Take a screenshot
   */
  async screenshot(name: string): Promise<void> {
    if (!this.page) return;

    const filename = `logs/screenshots/${name}-${Date.now()}.png`;
    await this.page.screenshot({ path: filename, fullPage: true });
    logger.info(`Screenshot saved: ${filename}`);
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isLoggedIn = false;
      logger.info('Browser closed');
    }
  }

  // ============ Private Helper Methods ============

  private async waitForLoginForm(): Promise<void> {
    if (!this.page) throw new Error('No page');

    const selectors = [
      'input[type="text"]',
      'input[placeholder*="account"]',
      'input[placeholder*="Account"]',
      'input[name="userName"]',
      '#username',
    ];

    for (const selector of selectors) {
      try {
        await this.page.waitForSelector(selector, { timeout: 10000 });
        logger.info(`Found login form with selector: ${selector}`);
        return;
      } catch {
        continue;
      }
    }

    await this.screenshot('login-form-not-found');
    throw new Error('Login form not found');
  }

  private async enterCredentials(): Promise<void> {
    if (!this.page) throw new Error('No page');

    // Username
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
        const element = await this.page.$(selector);
        if (element) {
          await element.click({ clickCount: 3 });
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

    await this.delay(500);

    // Password
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
        const element = await this.page.$(selector);
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

  private async submitLogin(): Promise<void> {
    if (!this.page) throw new Error('No page');

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
        const button = await this.page.$(selector);
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
    await this.page.keyboard.press('Enter');
  }

  private async waitForLoginSuccess(): Promise<void> {
    if (!this.page) throw new Error('No page');

    try {
      await this.page.waitForFunction(
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

      // Wait longer for page to fully load
      await this.delay(5000);
      logger.info(`Login successful, redirected to: ${this.page.url()}`);
    } catch {
      await this.screenshot('login-failed');

      const errorText = await this.page.evaluate(() => {
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

  private parseNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Map device status to expected type
   */
  private mapDeviceStatus(status: string | undefined): 'online' | 'offline' | 'standby' | 'fault' {
    if (!status) return 'offline';

    const statusLower = status.toLowerCase();

    if (statusLower.includes('online') || statusLower.includes('running') || statusLower === '1') {
      return 'online';
    }
    if (statusLower.includes('standby') || statusLower.includes('waiting') || statusLower === '2') {
      return 'standby';
    }
    if (statusLower.includes('fault') || statusLower.includes('error') || statusLower.includes('alarm')) {
      return 'fault';
    }

    return 'offline';
  }

  /**
   * Map device type code to readable name
   */
  private mapDeviceType(typeCode: string | number | undefined): string {
    if (!typeCode) return 'Unknown';

    const typeStr = String(typeCode).toLowerCase();

    // Common FusionSolar device type mappings
    const typeMap: Record<string, string> = {
      // Inverter types
      'inverter': 'Inverter',
      'inv': 'Inverter',
      '1': 'Inverter',
      '38': 'Inverter',
      '39': 'String Inverter',
      // Battery/ESS
      'battery': 'Battery',
      'ess': 'ESS',
      '2': 'Battery',
      // Meter
      'meter': 'Meter',
      '3': 'Meter',
      '17': 'Meter',
      '47': 'Smart Meter',
      // Optimizer
      'optimizer': 'Optimizer',
      '4': 'Optimizer',
      // Gateway/Logger
      'gateway': 'Gateway',
      'logger': 'Data Logger',
      'smartlogger': 'SmartLogger',
      '5': 'Gateway',
      '62': 'SmartLogger',
    };

    return typeMap[typeStr] || `Device (${typeCode})`;
  }

  // ============ Error Handling & Reliability ============

  /**
   * Execute a function with retry and exponential backoff
   */
  async withRetry<T>(
    fn: () => Promise<T>,
    options: {
      maxRetries?: number;
      baseDelay?: number;
      maxDelay?: number;
      onRetry?: (attempt: number, error: Error) => void;
    } = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      baseDelay = 1000,
      maxDelay = 10000,
      onRetry,
    } = options;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
          logger.warn(`Attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay}ms...`);

          if (onRetry) {
            onRetry(attempt, lastError);
          }

          await this.delay(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if the current session is still valid
   */
  async isSessionValid(): Promise<boolean> {
    if (!this.page || !this.isLoggedIn) return false;

    try {
      // Try to fetch a simple endpoint to check session validity
      const result = await this.page.evaluate(async () => {
        try {
          const response = await fetch('/rest/pvms/web/station/v1/station/list?pageNo=1&pageSize=1');
          return response.ok;
        } catch {
          return false;
        }
      });

      return result;
    } catch {
      return false;
    }
  }

  /**
   * Re-login if session has expired
   */
  async refreshSession(): Promise<void> {
    logger.info('Refreshing session...');

    this.isLoggedIn = false;

    // Navigate back to login page and re-authenticate
    await this.login();

    logger.info('Session refreshed successfully');
  }

  /**
   * Capture error state for debugging
   */
  async captureErrorState(error: Error, context: string): Promise<string> {
    const timestamp = Date.now();
    const filename = `logs/screenshots/error-${context}-${timestamp}.png`;

    try {
      if (this.page) {
        await this.page.screenshot({ path: filename, fullPage: true });
        logger.info(`Error screenshot saved: ${filename}`);
      }

      // Log additional debug info
      logger.error(`Error context: ${context}`);
      logger.error(`Error message: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);

      if (this.page) {
        const currentUrl = this.page.url();
        logger.error(`Current URL: ${currentUrl}`);
      }
    } catch (screenshotError) {
      logger.warn(`Failed to capture error state: ${screenshotError}`);
    }

    return filename;
  }

  /**
   * Ensure we have a valid session, re-login if needed
   */
  async ensureValidSession(): Promise<void> {
    if (!this.isLoggedIn) {
      logger.info('Not logged in, initiating login...');
      await this.login();
      return;
    }

    // Skip validation if login is recent (within validity window)
    const timeSinceLogin = Date.now() - this.lastLoginTime;
    const validityMs = this.sessionValidityMinutes * 60 * 1000;

    if (timeSinceLogin < validityMs) {
      logger.debug(`Session is recent (${Math.round(timeSinceLogin / 1000)}s old), skipping validation`);
      return;
    }

    // Session might be expired, validate it
    logger.info('Session age exceeds validity window, validating...');
    const isValid = await this.isSessionValid();
    if (!isValid) {
      logger.warn('Session expired, refreshing...');
      await this.refreshSession();
    }
  }
}

export default BrowserCrawler;
