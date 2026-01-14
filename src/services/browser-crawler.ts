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
  parentDeviceDn?: string; // For sub-devices like meters under inverters

  // Common real-time data
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

  // Meter-specific data
  reactivePower?: number;
  positiveActiveEnergy?: number; // Import from grid (kWh)
  negativeActiveEnergy?: number; // Export to grid (kWh)
  // Phase data (for 3-phase meters)
  phaseAVoltage?: number;
  phaseBVoltage?: number;
  phaseCVoltage?: number;
  phaseACurrent?: number;
  phaseBCurrent?: number;
  phaseCCurrent?: number;
  phaseAActivePower?: number;
  phaseBActivePower?: number;
  phaseCActivePower?: number;
  // Line voltages
  abLineVoltage?: number;
  bcLineVoltage?: number;
  caLineVoltage?: number;

  // PV String individual fields (for building pvStrings array)
  pv1Voltage?: number;
  pv1Current?: number;
  pv2Voltage?: number;
  pv2Current?: number;
  pv3Voltage?: number;
  pv3Current?: number;
  pv4Voltage?: number;
  pv4Current?: number;
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
   * Get all stations using various API approaches
   * This properly filters out folders and only returns actual stations
   */
  async getStations(): Promise<BrowserStation[]> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info('Fetching stations...');

    // Wait longer for page to fully load after login
    logger.info('Waiting for page to fully load...');
    await this.delay(5000);

    // Dismiss any dialogs that might be blocking
    await this.dismissDialogs();

    // Take screenshot for debugging
    await this.screenshot('before-station-extraction');

    // Try multiple API approaches
    const result = await this.page.evaluate(async () => {
      // Method 1: Try the home page station list (same as UI shows)
      try {
        const homeParams = new URLSearchParams({
          pageNo: '1',
          pageSize: '100',
          locale: 'en_US',
          _: String(Date.now()),
        });

        const homeResponse = await fetch('/rest/pvms/web/station/v1/station/station-list?' + homeParams.toString());
        if (homeResponse.ok) {
          const data = await homeResponse.json();
          if (data && data.data && data.data.list && data.data.list.length > 0) {
            return { source: 'station-list', data: data.data.list };
          }
        }
      } catch (e) { /* continue */ }

      // Method 2: Try overview stations endpoint
      try {
        const overviewParams = new URLSearchParams({
          pageNo: '1',
          pageSize: '100',
          _: String(Date.now()),
        });

        const overviewResponse = await fetch('/rest/pvms/web/station/v1/overview/station-list?' + overviewParams.toString());
        if (overviewResponse.ok) {
          const data = await overviewResponse.json();
          if (data && data.data && data.data.list && data.data.list.length > 0) {
            return { source: 'overview-list', data: data.data.list };
          }
        }
      } catch (e) { /* continue */ }

      // Method 3: Try POST to organization tree
      try {
        const treeResponse = await fetch('/rest/dp/pvms/organization/v1/tree', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeType: 'STATION' }),
        });

        if (treeResponse.ok) {
          const data = await treeResponse.json();
          if (data && data.data && Array.isArray(data.data)) {
            const stations = data.data.filter(function(n: Record<string, unknown>) {
              return n.nodeType === 'STATION' || n.nodeType === 'station';
            });
            if (stations.length > 0) {
              return { source: 'tree', data: stations };
            }
          }
        }
      } catch (e) { /* continue */ }

      return { source: 'none', data: [] };
    });

    logger.info(`Station API result: source=${result.source}, count=${result.data?.length || 0}`);

    if (result.data && result.data.length > 0) {
      const stations: BrowserStation[] = [];

      for (const s of result.data) {
        stations.push({
          stationDn: s.stationDn || s.dn || s.nodeDn,
          stationName: s.stationName || s.name || s.nodeName,
          capacity: this.parseNumber(s.installedCapacity || s.capacity),
          gridConnectionDate: s.gridConnectedTime || s.gridConnectionDate,
          address: s.address,
        });
      }

      logger.info(`Found ${stations.length} stations via ${result.source}`);
      stations.forEach((s) => logger.info(`  - ${s.stationName} (${s.stationDn})`));

      return stations;
    }

    // Fallback to DOM extraction
    logger.warn('API methods failed, falling back to DOM extraction');
    return this.getStationsFromDOM();
  }

  /**
   * Dismiss any dialogs or modals that might be blocking
   */
  private async dismissDialogs(): Promise<void> {
    if (!this.page) return;

    try {
      // Try to close welcome dialog
      const closeButtons = await this.page.$$('button[class*="close"], .close-btn, [aria-label="Close"], .modal-close');
      for (const btn of closeButtons) {
        try {
          await btn.click();
          await this.delay(500);
        } catch { /* continue */ }
      }

      // Try to dismiss cookie banner
      const cookieButtons = await this.page.$$('button:has-text("Accept"), button:has-text("OK"), .cookie-accept');
      for (const btn of cookieButtons) {
        try {
          await btn.click();
          await this.delay(500);
        } catch { /* continue */ }
      }
    } catch {
      // Ignore errors when dismissing dialogs
    }
  }

  /**
   * Fallback: Get stations from DOM (for backwards compatibility)
   */
  private async getStationsFromDOM(): Promise<BrowserStation[]> {
    if (!this.page) throw new Error('No page');

    logger.info('Extracting stations from DOM (fallback)...');

    // Wait for station elements to appear
    try {
      await this.page.waitForSelector(
        'span.node-name[id*="NE="], [class*="station-name"], [class*="plant-name"], .tree-node',
        { timeout: 15000 }
      );
      logger.info('Station elements detected in DOM');
    } catch {
      logger.warn('No station elements found in DOM after 15s');
    }

    // Additional wait for data to stabilize
    await this.delay(2000);

    const stations = await this.page.evaluate(() => {
      const results: { stationDn: string; stationName: string }[] = [];

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

      // Method 2: Look for tree nodes with data attributes
      if (results.length === 0) {
        const treeNodes = document.querySelectorAll('[data-dn], [data-station-dn]');
        treeNodes.forEach((el) => {
          const dn = el.getAttribute('data-dn') || el.getAttribute('data-station-dn') || '';
          const name = el.textContent?.trim() || el.getAttribute('title') || '';
          const dnMatch = dn.match(/NE=(\d+)/);

          if (dnMatch && name) {
            results.push({
              stationDn: `NE=${dnMatch[1]}`,
              stationName: name,
            });
          }
        });
      }

      // Method 3: Look for any element with NE= in ID
      if (results.length === 0) {
        const allElements = document.querySelectorAll('[id*="NE="]');
        allElements.forEach((el) => {
          const id = el.getAttribute('id') || '';
          const dnMatch = id.match(/NE=(\d+)/);
          const name = el.textContent?.trim() || el.getAttribute('title') || '';

          if (dnMatch && name && name.length > 2 && name.length < 100) {
            results.push({
              stationDn: `NE=${dnMatch[1]}`,
              stationName: name,
            });
          }
        });
      }

      // Deduplicate
      return results.filter(
        (item, index, self) => index === self.findIndex((t) => t.stationDn === item.stationDn)
      );
    });

    logger.info(`Found ${stations.length} stations via DOM`);
    return stations;
  }

  /**
   * Get station detail data (capacity, total yield, environmental data)
   * This API provides more accurate station-level data than energy-balance
   */
  async getStationDetail(stationDn: string): Promise<{
    capacity: number;
    totalYield: number;
    co2Avoided: number;
    treesPlanted: number;
    standardCoalSaved: number;
    gridConnectionDate: string;
    realTimePower: number;
    yieldToday: number;
  } | null> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info(`Fetching station detail for ${stationDn}...`);

    const result = await this.page.evaluate(async (dn: string) => {
      try {
        const params = new URLSearchParams({
          stationDn: dn,
          timeZone: '7.0',
          timeZoneStr: 'Asia/Jakarta',
          _: String(Date.now()),
        });

        const response = await fetch(
          `/rest/pvms/web/station/v1/overview/station-detail?${params}`
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
      logger.warn(`  Station detail error: ${result.error}`);
      return null;
    }

    const data = result.data?.data || result.data;
    if (!data) {
      logger.warn('  Station detail: No data returned');
      return null;
    }

    // Log available fields
    const keys = Object.keys(data);
    logger.info(`  Station detail fields: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? '...' : ''}`);

    // Parse station detail data
    // Key fields from station-detail API:
    // - cumulativeEnergy: Total energy (kWh)
    // - installedCapacity: Capacity (kWp)
    // - co2: CO2 avoided (kg)
    // - tree: Trees planted equivalent
    // - coal: Standard coal saved
    // - gridConnectedTime: Grid connection date
    // - currentPower: Real-time power (kW)
    // - dayEnergy: Today's yield (kWh)

    const stationDetail = {
      capacity: this.parseNumber(data.installedCapacity),
      totalYield: this.parseNumber(data.cumulativeEnergy),
      // CO2 from station-detail is in kg, convert to tons
      co2Avoided: this.parseNumber(data.co2) / 1000,
      treesPlanted: this.parseNumber(data.tree),
      standardCoalSaved: this.parseNumber(data.coal),
      gridConnectionDate: data.gridConnectedTime || '',
      realTimePower: this.parseNumber(data.currentPower),
      yieldToday: this.parseNumber(data.dayEnergy),
    };

    logger.info(`  Station: Capacity=${stationDetail.capacity}kWp, TotalYield=${stationDetail.totalYield}kWh, CO2=${stationDetail.co2Avoided}t`);

    return stationDetail;
  }

  /**
   * Get energy balance and real-time data for a station
   */
  async getEnergyData(stationDn: string): Promise<BrowserEnergyData | null> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info(`Fetching energy data for ${stationDn}...`);

    // First get station detail for accurate totals
    const stationDetail = await this.getStationDetail(stationDn);

    // Then get energy balance for flow data
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

    // If energy-balance fails but we have station detail, return partial data
    let balanceData: Record<string, unknown> = {};
    if (!result.error && result.data?.success && result.data?.data) {
      balanceData = result.data.data;
      const keys = Object.keys(balanceData);
      logger.info(`  Energy balance fields: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? '...' : ''}`);
    } else {
      logger.warn(`  Energy balance unavailable, using station detail only`);
    }

    // Combine data from both APIs, preferring station-detail for totals
    const energyData: BrowserEnergyData = {
      // Energy balance flow data
      generatedByPV: this.parseNumber(balanceData.totalProductPower),
      consumedFromPV: this.parseNumber(balanceData.totalSelfUsePower),
      fedToGrid: this.parseNumber(balanceData.totalOnGridPower),
      consumedByAppliances: this.parseNumber(balanceData.totalUsePower),
      fromGrid: this.parseNumber(balanceData.totalBuyPower),

      // Real-time and totals from station-detail (more accurate)
      realTimePower: stationDetail?.realTimePower || this.parseNumber(balanceData.realTimePower || balanceData.stationPower || 0),
      dayEnergy: stationDetail?.yieldToday || this.parseNumber(balanceData.totalProductPower),
      totalEnergy: stationDetail?.totalYield || this.parseNumber(balanceData.totalEnergy || 0),

      // Environmental from station-detail (more accurate)
      standardCoalSaved: stationDetail?.standardCoalSaved || this.parseNumber(balanceData.coalSave || balanceData.standardCoalSaved || 0),
      co2Avoided: stationDetail?.co2Avoided || this.parseNumber(balanceData.co2 || balanceData.co2Avoided || 0),
      treesPlanted: stationDetail?.treesPlanted || this.parseNumber(balanceData.tree || balanceData.treesPlanted || 0),

      // Keep raw data for debugging
      rawData: { ...balanceData, stationDetail },
    };

    logger.info(`  Summary: Power=${energyData.realTimePower}kW, Today=${energyData.dayEnergy}kWh, Total=${energyData.totalEnergy}kWh`);
    logger.info(`  Flow: Generated=${energyData.generatedByPV}kWh, FromGrid=${energyData.fromGrid}kWh`);

    return energyData;
  }

  /**
   * Get energy data using pre-fetched station detail (avoids duplicate API call)
   */
  async getEnergyDataWithDetail(
    stationDn: string,
    stationDetail: {
      capacity: number;
      totalYield: number;
      co2Avoided: number;
      treesPlanted: number;
      standardCoalSaved: number;
      gridConnectionDate: string;
      realTimePower: number;
      yieldToday: number;
    }
  ): Promise<BrowserEnergyData> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info(`Fetching energy balance for ${stationDn}...`);

    // Get energy balance for flow data
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

    // Extract balance data if available
    let balanceData: Record<string, unknown> = {};
    if (!result.error && result.data?.success && result.data?.data) {
      balanceData = result.data.data;
      const keys = Object.keys(balanceData);
      logger.info(`  Energy balance fields: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? '...' : ''}`);
    } else {
      logger.warn(`  Energy balance unavailable, using station detail only`);
    }

    // Combine data from both APIs, preferring station-detail for totals
    const energyData: BrowserEnergyData = {
      // Energy balance flow data
      generatedByPV: this.parseNumber(balanceData.totalProductPower),
      consumedFromPV: this.parseNumber(balanceData.totalSelfUsePower),
      fedToGrid: this.parseNumber(balanceData.totalOnGridPower),
      consumedByAppliances: this.parseNumber(balanceData.totalUsePower),
      fromGrid: this.parseNumber(balanceData.totalBuyPower),

      // Real-time and totals from station-detail (more accurate)
      realTimePower: stationDetail.realTimePower,
      dayEnergy: stationDetail.yieldToday,
      totalEnergy: stationDetail.totalYield,

      // Environmental from station-detail (more accurate)
      standardCoalSaved: stationDetail.standardCoalSaved,
      co2Avoided: stationDetail.co2Avoided,
      treesPlanted: stationDetail.treesPlanted,

      // Keep raw data for debugging
      rawData: { ...balanceData, stationDetail },
    };

    logger.info(`  Summary: Power=${energyData.realTimePower}kW, Today=${energyData.dayEnergy}kWh, Total=${energyData.totalEnergy}kWh`);
    logger.info(`  Flow: Generated=${energyData.generatedByPV}kWh, FromGrid=${energyData.fromGrid}kWh`);

    return energyData;
  }

  /**
   * Get device list for a station, including sub-devices (meters, etc.)
   */
  async getDevices(stationDn: string): Promise<BrowserDevice[]> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info(`Fetching devices for ${stationDn}...`);

    // Get direct devices from station
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

    // Parse direct devices and track which have children
    const deviceDns: string[] = [];
    const devicesWithChildren: string[] = [];
    if (Array.isArray(rawDevices)) {
      for (const d of rawDevices) {
        const deviceType = d.mocTypeName || this.mapDeviceType(d.typeId || d.moType || d.devTypeId);
        const typeId = parseInt(String(d.typeId || d.moType || d.devTypeId || 0), 10);
        const deviceStatus = d.deviceStatus || d.status || d.runStatus;
        const commStatus = d.communication;
        const deviceDn = d.dn || d.deviceDn;

        devices.push({
          deviceDn,
          deviceName: d.name || d.deviceName || d.moName,
          deviceType,
          deviceTypeId: typeId || undefined,
          model: d.model || d.devModel || d.invType,
          status: deviceStatus,
          communicationStatus: commStatus,
          serialNumber: d.sn || d.esn || d.serialNumber,
          stationDn: stationDn,
        });

        deviceDns.push(deviceDn);

        // Track devices that have children (for sub-device discovery)
        if (d.hasChild === true || d.hasChild === 'true') {
          devicesWithChildren.push(deviceDn);
          logger.debug(`  Device ${d.name} has children`);
        }
      }
    }

    logger.info(`  Found ${devices.length} direct devices`);
    if (devicesWithChildren.length > 0) {
      logger.info(`  ${devicesWithChildren.length} device(s) have sub-devices`);
    }

    // Try to find sub-devices
    // Method 1: Query with parent device DNs
    let subDevices = await this.getSubDevices(stationDn, devicesWithChildren.length > 0 ? devicesWithChildren : deviceDns);

    // Method 2: If no sub-devices found and there are devices with children, try querying all devices
    if (subDevices.length === 0 && devicesWithChildren.length > 0) {
      logger.info(`  Devices have children but none found via API, trying DOM-based discovery...`);
      subDevices = await this.discoverSubDevicesFromDOM(stationDn, devicesWithChildren);
    }

    // Method 3: Fallback to getAllDevicesForStation
    if (subDevices.length === 0 && devicesWithChildren.length > 0) {
      subDevices = await this.getAllDevicesForStation(stationDn, deviceDns);
    }

    // Method 4: Try probing nearby DNs (sub-devices often have sequential DNs)
    if (subDevices.length === 0 && devicesWithChildren.length > 0) {
      logger.info(`  Trying DN probing for sub-device discovery...`);
      const probedDevices = await this.probeNearbyDNs(stationDn, devicesWithChildren, deviceDns);
      if (probedDevices.length > 0) {
        subDevices.push(...probedDevices);
      }
    }

    if (subDevices.length > 0) {
      logger.info(`  Found ${subDevices.length} sub-devices`);
      devices.push(...subDevices);
    }

    logger.info(`  Total devices: ${devices.length}`);
    return devices;
  }

  /**
   * Discover sub-devices by expanding device nodes in the DOM
   * This is a fallback when REST APIs don't expose sub-devices
   */
  private async discoverSubDevicesFromDOM(stationDn: string, parentDns: string[]): Promise<BrowserDevice[]> {
    if (!this.page) throw new Error('No page');

    const subDevices: BrowserDevice[] = [];

    for (const parentDn of parentDns) {
      logger.debug(`  Attempting DOM-based discovery for ${parentDn}...`);

      try {
        // Find and click the expand icon for this device
        const expandResult = await this.page.evaluate(async (dn: string) => {
          // Find the device element in the tree
          const deviceElement = document.querySelector(`[id*="${dn}"], [data-dn="${dn}"]`);
          if (!deviceElement) {
            return { success: false, error: 'Device element not found' };
          }

          // Find the expand/toggle icon (usually a + or arrow icon near the device)
          const parent = deviceElement.closest('.tree-node, .device-item, [class*="tree"], [class*="node"]');
          if (!parent) {
            return { success: false, error: 'Parent container not found' };
          }

          const expandIcon = parent.querySelector(
            '.expand-icon, .toggle-icon, [class*="expand"], [class*="arrow"], .icon-arrow, svg[class*="arrow"]'
          );

          if (expandIcon && expandIcon instanceof HTMLElement) {
            expandIcon.click();
            return { success: true, clicked: 'expand-icon' };
          }

          // Try clicking the device itself to expand
          if (deviceElement instanceof HTMLElement) {
            deviceElement.click();
            return { success: true, clicked: 'device-element' };
          }

          return { success: false, error: 'No clickable element found' };
        }, parentDn);

        if (expandResult.success) {
          logger.debug(`    Clicked ${expandResult.clicked}, waiting for children...`);
          await this.delay(1500); // Wait for children to load

          // Now look for child devices in the DOM
          const childDevices = await this.page.evaluate((params: { parentDn: string; stationDn: string }) => {
            const children: Array<{ dn: string; name: string; type: string }> = [];

            // Look for device elements that appeared after expansion
            const allDeviceElements = document.querySelectorAll('[id*="NE="], [data-dn*="NE="]');

            allDeviceElements.forEach((el) => {
              const id = el.getAttribute('id') || el.getAttribute('data-dn') || '';
              const dnMatch = id.match(/NE=(\d+)/);
              if (!dnMatch) return;

              const deviceDn = `NE=${dnMatch[1]}`;
              // Skip if this is the parent or station
              if (deviceDn === params.parentDn || deviceDn === params.stationDn) return;

              // Check if this element is a child of the parent (appears after it in the tree)
              const parentEl = document.querySelector(`[id*="${params.parentDn}"]`);
              if (!parentEl) return;

              // Get text content for name
              const name = el.textContent?.trim() || el.getAttribute('title') || '';
              if (!name || name.length > 50) return;

              // Try to determine type from element attributes or nearby text
              let type = 'Unknown';
              const text = (el.textContent || '').toLowerCase();
              const className = el.className.toLowerCase();

              if (text.includes('meter') || className.includes('meter')) {
                type = 'Power Sensor';
              } else if (text.includes('sensor')) {
                type = 'Power Sensor';
              } else if (text.includes('battery') || className.includes('battery')) {
                type = 'Battery';
              } else if (text.includes('optimizer')) {
                type = 'Optimizer';
              }

              children.push({ dn: deviceDn, name, type });
            });

            // Deduplicate
            return children.filter((c, i, arr) =>
              arr.findIndex(x => x.dn === c.dn) === i
            );
          }, { parentDn, stationDn });

          if (childDevices.length > 0) {
            logger.info(`    Found ${childDevices.length} child device(s) via DOM`);
            for (const child of childDevices) {
              subDevices.push({
                deviceDn: child.dn,
                deviceName: child.name,
                deviceType: child.type,
                stationDn: stationDn,
                parentDeviceDn: parentDn,
              });
            }
          }
        } else {
          logger.debug(`    DOM expansion failed: ${expandResult.error}`);
        }
      } catch (error) {
        logger.debug(`    DOM discovery error: ${error}`);
      }
    }

    return subDevices;
  }

  /**
   * Get ALL devices for a station using multiple approaches
   * Returns only devices not in the directDeviceDns list (i.e., sub-devices)
   */
  private async getAllDevicesForStation(stationDn: string, directDeviceDns: string[]): Promise<BrowserDevice[]> {
    if (!this.page) throw new Error('No page');

    logger.debug(`  Querying all devices for station ${stationDn}...`);

    const result = await this.page.evaluate(async (params: { stationDn: string; directDns: string[] }) => {
      const allDevices: Array<Record<string, unknown>> = [];

      // Method 1: Try device-list without parentDn filter
      try {
        const listParams = new URLSearchParams({
          'conditionParams.stationDn': params.stationDn,
          'conditionParams.checkShareStationDn': params.stationDn,
          'conditionParams.curPage': '1',
          'conditionParams.recordperpage': '100',
          _: String(Date.now()),
        });

        const listResponse = await fetch(
          `/rest/neteco/web/config/device/v1/device-list?${listParams}`
        );

        if (listResponse.ok) {
          const listData = await listResponse.json();
          const devices = listData?.data || [];
          if (Array.isArray(devices)) {
            allDevices.push(...devices.map((d: Record<string, unknown>) => ({ ...d, source: 'device-list-all' })));
          }
        }
      } catch { /* continue */ }

      // Method 2: Try device-tree API with station DN
      try {
        const treeParams = new URLSearchParams({
          stationDn: params.stationDn,
          _: String(Date.now()),
        });

        const treeResponse = await fetch(
          `/rest/pvms/web/device/v1/device-tree?${treeParams}`
        );

        if (treeResponse.ok) {
          const treeData = await treeResponse.json();
          // Flatten tree structure to find all devices
          const flattenTree = (nodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
            const result: Array<Record<string, unknown>> = [];
            for (const node of nodes) {
              if (node.dn || node.deviceDn) {
                result.push({ ...node, source: 'device-tree' });
              }
              if (node.children && Array.isArray(node.children)) {
                result.push(...flattenTree(node.children as Array<Record<string, unknown>>));
              }
            }
            return result;
          };
          const treeDevices = treeData?.data || treeData?.children || [];
          if (Array.isArray(treeDevices)) {
            allDevices.push(...flattenTree(treeDevices));
          }
        }
      } catch { /* continue */ }

      // Method 3: Try device-realtime-list API (sometimes includes sub-devices)
      try {
        const realtimeParams = new URLSearchParams({
          stationDn: params.stationDn,
          _: String(Date.now()),
        });

        const realtimeResponse = await fetch(
          `/rest/pvms/web/device/v1/device-realtime-list?${realtimeParams}`
        );

        if (realtimeResponse.ok) {
          const realtimeData = await realtimeResponse.json();
          const devices = realtimeData?.data || [];
          if (Array.isArray(devices)) {
            allDevices.push(...devices.map((d: Record<string, unknown>) => ({ ...d, source: 'device-realtime-list' })));
          }
        }
      } catch { /* continue */ }

      // Method 4: Try station-overview device list
      try {
        const overviewParams = new URLSearchParams({
          stationDn: params.stationDn,
          timeZone: '7.0',
          _: String(Date.now()),
        });

        const overviewResponse = await fetch(
          `/rest/pvms/web/station/v1/overview/device-list?${overviewParams}`
        );

        if (overviewResponse.ok) {
          const overviewData = await overviewResponse.json();
          const devices = overviewData?.data || [];
          if (Array.isArray(devices)) {
            allDevices.push(...devices.map((d: Record<string, unknown>) => ({ ...d, source: 'overview-device-list' })));
          }
        }
      } catch { /* continue */ }

      // Method 5: Try meter-specific API
      try {
        const meterParams = new URLSearchParams({
          stationDn: params.stationDn,
          _: String(Date.now()),
        });

        const meterResponse = await fetch(
          `/rest/pvms/web/device/v1/meter-list?${meterParams}`
        );

        if (meterResponse.ok) {
          const meterData = await meterResponse.json();
          const devices = meterData?.data || [];
          if (Array.isArray(devices)) {
            allDevices.push(...devices.map((d: Record<string, unknown>) => ({
              ...d,
              source: 'meter-list',
              mocTypeName: d.mocTypeName || 'Power Sensor',
            })));
          }
        }
      } catch { /* continue */ }

      // Deduplicate by DN
      const unique = allDevices.filter((d, i, arr) => {
        const dn = d.dn || d.deviceDn;
        return arr.findIndex(x => (x.dn || x.deviceDn) === dn) === i;
      });

      return { devices: unique };
    }, { stationDn, directDns: directDeviceDns });

    const subDevices: BrowserDevice[] = [];

    if (Array.isArray(result.devices)) {
      logger.debug(`  All devices query returned ${result.devices.length} total devices`);

      for (const d of result.devices) {
        const deviceDn = String(d.dn || d.deviceDn);

        // Skip if this is a direct device (not a sub-device)
        if (directDeviceDns.includes(deviceDn)) {
          logger.debug(`    Skipping direct device ${deviceDn}`);
          continue;
        }

        const deviceType = d.mocTypeName || this.mapDeviceType(d.typeId as string | number | undefined ?? d.mocId as string | number | undefined);

        subDevices.push({
          deviceDn,
          deviceName: String(d.name || d.deviceName || ''),
          deviceType: String(deviceType || 'Unknown'),
          deviceTypeId: typeof d.typeId === 'number' ? d.typeId : typeof d.mocId === 'number' ? d.mocId : undefined,
          model: String(d.model || d.devModel || ''),
          status: String(d.deviceStatus || d.status || ''),
          stationDn: stationDn,
          parentDeviceDn: d.parentDn as string | undefined,
        });
        logger.debug(`    Found sub-device: ${deviceDn} (${d.name}) via ${d.source}`);
      }
    }

    return subDevices;
  }

  /**
   * Probe nearby DNs to discover sub-devices
   * Sub-devices often have sequential DNs near the parent device
   * E.g., if inverter is NE=69239038, meter might be NE=69239039 or NE=69239040
   */
  private async probeNearbyDNs(
    stationDn: string,
    parentDns: string[],
    excludeDns: string[]
  ): Promise<BrowserDevice[]> {
    if (!this.page) throw new Error('No page');

    const discoveredDevices: BrowserDevice[] = [];

    for (const parentDn of parentDns) {
      // Extract the numeric part of the DN
      const dnMatch = parentDn.match(/NE=(\d+)/);
      if (!dnMatch) continue;

      const baseNum = parseInt(dnMatch[1], 10);
      logger.debug(`  Probing DNs near ${parentDn} (base: ${baseNum})...`);

      // Probe DNs in range +1 to +5 (sub-devices typically have higher DNs)
      for (let offset = 1; offset <= 5; offset++) {
        const probeDn = `NE=${baseNum + offset}`;

        // Skip if already known
        if (excludeDns.includes(probeDn) || discoveredDevices.some(d => d.deviceDn === probeDn)) {
          continue;
        }

        // Try to get device info using mo-details API
        const deviceInfo = await this.page.evaluate(async (dn: string) => {
          try {
            // Try mo-details first (provides device info)
            const moResponse = await fetch(
              `/rest/pvms/web/device/v1/mo-details?dn=${encodeURIComponent(dn)}&_=${Date.now()}`
            );

            if (moResponse.ok) {
              const moData = await moResponse.json();
              const mo = moData?.data?.mo || moData?.data || moData;

              if (mo && (mo.name || mo.moName || mo.deviceName)) {
                return {
                  exists: true,
                  source: 'mo-details',
                  data: {
                    dn: mo.dn || dn,
                    name: mo.name || mo.moName || mo.deviceName || '',
                    type: mo.mocTypeName || mo.deviceType || mo.moType || 'Unknown',
                    typeId: mo.mocId || mo.typeId || mo.devTypeId,
                    status: mo.status || mo.deviceStatus || '',
                    model: mo.model || mo.devModel || '',
                    esn: mo.esn || mo.sn || '',
                  }
                };
              }
            }

            // Fallback: try device-realtime-data (only accept if it has a proper name)
            const rtResponse = await fetch(
              `/rest/pvms/web/device/v1/device-realtime-data?deviceDn=${encodeURIComponent(dn)}&_=${Date.now()}`
            );

            if (rtResponse.ok) {
              const rtData = await rtResponse.json();
              // Only consider it a valid device if it has a meaningful name
              // (not just a generic response with empty/unknown data)
              const name = rtData?.data?.deviceName || rtData?.data?.name || '';
              if (name && name.length > 0 && !name.startsWith('Device-')) {
                return {
                  exists: true,
                  source: 'device-realtime-data',
                  data: {
                    dn,
                    name,
                    type: rtData.data.deviceType || rtData.data.mocTypeName || 'Unknown',
                    status: rtData.data.status || rtData.data.deviceStatus || '',
                  }
                };
              }
            }

            return { exists: false };
          } catch {
            return { exists: false };
          }
        }, probeDn);

        if (deviceInfo.exists && deviceInfo.data) {
          logger.info(`    Found sub-device via DN probe: ${probeDn} (${deviceInfo.data.name || 'unnamed'}) via ${deviceInfo.source}`);

          // Determine device type from name or reported type
          let deviceType = deviceInfo.data.type;
          const nameLower = (deviceInfo.data.name || '').toLowerCase();
          if (nameLower.includes('meter') || nameLower.includes('sensor')) {
            deviceType = 'Power Sensor';
          } else if (nameLower.includes('battery')) {
            deviceType = 'Battery';
          } else if (nameLower.includes('optimizer')) {
            deviceType = 'Optimizer';
          }

          discoveredDevices.push({
            deviceDn: probeDn,
            deviceName: deviceInfo.data.name || `Device-${probeDn}`,
            deviceType: deviceType,
            deviceTypeId: deviceInfo.data.typeId,
            model: deviceInfo.data.model || '',
            status: deviceInfo.data.status || 'unknown',
            serialNumber: deviceInfo.data.esn,
            stationDn: stationDn,
            parentDeviceDn: parentDn,
          });
        }
      }
    }

    if (discoveredDevices.length > 0) {
      logger.info(`  DN probing discovered ${discoveredDevices.length} sub-device(s)`);
    }

    return discoveredDevices;
  }

  /**
   * Get sub-devices (meters, optimizers) for a list of parent devices
   * Uses multiple API approaches to discover child devices
   */
  private async getSubDevices(stationDn: string, parentDns: string[]): Promise<BrowserDevice[]> {
    if (!this.page) throw new Error('No page');

    const subDevices: BrowserDevice[] = [];

    for (const parentDn of parentDns) {
      logger.debug(`  Checking for sub-devices under ${parentDn}...`);

      // Get child devices using multiple API approaches
      const childDevices = await this.page.evaluate(async (params: { stationDn: string; parentDn: string }) => {
        const allDevices: Array<Record<string, unknown>> = [];
        const apiResults: Record<string, unknown> = {};

        // Method 1: Try to get sub-devices directly via device-list with parent
        try {
          const listParams = new URLSearchParams({
            'conditionParams.checkShareStationDn': params.stationDn,
            'conditionParams.parentDn': params.parentDn,
            'conditionParams.curPage': '1',
            'conditionParams.recordperpage': '100',
            _: String(Date.now()),
          });

          const listResponse = await fetch(
            `/rest/neteco/web/config/device/v1/device-list?${listParams}`
          );

          apiResults['device-list'] = { status: listResponse.status };
          if (listResponse.ok) {
            const listData = await listResponse.json();
            const devices = listData?.data || [];
            apiResults['device-list'] = { status: listResponse.status, count: Array.isArray(devices) ? devices.length : 0 };
            if (Array.isArray(devices)) {
              allDevices.push(...devices.map((d: Record<string, unknown>) => ({ ...d, source: 'device-list' })));
            }
          }
        } catch (e) { apiResults['device-list'] = { error: String(e) }; }

        // Method 2: Try mo-details API for child devices
        // Correct endpoint: /rest/pvms/web/device/v1/mo-details?dn=NE%3D{deviceDn}
        try {
          const moResponse = await fetch(
            `/rest/pvms/web/device/v1/mo-details?dn=${encodeURIComponent(params.parentDn)}&_=${Date.now()}`
          );

          apiResults['mo-details'] = { status: moResponse.status };
          if (moResponse.ok) {
            const moData = await moResponse.json();
            // Children might be in different locations
            const children = moData?.data?.children || moData?.children || moData?.data?.subDevices || [];
            apiResults['mo-details'] = { status: moResponse.status, count: Array.isArray(children) ? children.length : 0 };
            if (Array.isArray(children) && children.length > 0) {
              allDevices.push(...children.map((d: Record<string, unknown>) => ({ ...d, source: 'mo-details' })));
            }
          }
        } catch (e) { apiResults['mo-details'] = { error: String(e) }; }

        // Method 2b: Try device-statistics-signal API which may list sub-devices
        try {
          const statsResponse = await fetch(
            `/rest/pvms/web/device/v1/device-statistics-signal?deviceDn=${encodeURIComponent(params.parentDn)}&_=${Date.now()}`
          );

          apiResults['device-statistics'] = { status: statsResponse.status };
          if (statsResponse.ok) {
            const statsData = await statsResponse.json();
            // Check for sub-devices in various fields
            const subDevs = statsData?.data?.subDevices || statsData?.subDevices || statsData?.data?.children || [];
            apiResults['device-statistics'] = { status: statsResponse.status, count: Array.isArray(subDevs) ? subDevs.length : 0 };
            if (Array.isArray(subDevs) && subDevs.length > 0) {
              allDevices.push(...subDevs.map((d: Record<string, unknown>) => ({ ...d, source: 'device-statistics' })));
            }
          }
        } catch (e) { apiResults['device-statistics'] = { error: String(e) }; }

        // Method 2c: Try querying sub-devices through device-info/child endpoint
        try {
          const childParams = new URLSearchParams({
            deviceDn: params.parentDn,
            _: String(Date.now()),
          });

          const childResponse = await fetch(
            `/rest/pvms/web/device/v1/device-child-list?${childParams}`
          );

          apiResults['device-child-list'] = { status: childResponse.status };
          if (childResponse.ok) {
            const childData = await childResponse.json();
            const childDevices = childData?.data || [];
            apiResults['device-child-list'] = { status: childResponse.status, count: Array.isArray(childDevices) ? childDevices.length : 0 };
            if (Array.isArray(childDevices) && childDevices.length > 0) {
              allDevices.push(...childDevices.map((d: Record<string, unknown>) => ({ ...d, source: 'device-child-list' })));
            }
          }
        } catch (e) { apiResults['device-child-list'] = { error: String(e) }; }

        // Method 2d: Try station overview for all equipment including meters
        try {
          const equipParams = new URLSearchParams({
            stationDn: params.stationDn,
            timeZone: '7.0',
            _: String(Date.now()),
          });

          const equipResponse = await fetch(
            `/rest/pvms/web/station/v1/overview/equipment-list?${equipParams}`
          );

          apiResults['equipment-list'] = { status: equipResponse.status };
          if (equipResponse.ok) {
            const equipData = await equipResponse.json();
            const equipment = equipData?.data || [];
            apiResults['equipment-list'] = { status: equipResponse.status, count: Array.isArray(equipment) ? equipment.length : 0 };
            if (Array.isArray(equipment)) {
              // Filter for meters/sensors that belong to this device
              const meters = equipment.filter((e: Record<string, unknown>) =>
                e.parentDn === params.parentDn ||
                String(e.mocTypeName || '').toLowerCase().includes('meter') ||
                String(e.mocTypeName || '').toLowerCase().includes('sensor')
              );
              if (meters.length > 0) {
                allDevices.push(...meters.map((d: Record<string, unknown>) => ({ ...d, source: 'equipment-list' })));
              }
            }
          }
        } catch (e) { apiResults['equipment-list'] = { error: String(e) }; }

        // Method 3: Try tree endpoint with specific device nodeType
        try {
          const treeResponse = await fetch('/rest/dp/pvms/organization/v1/tree', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parentDn: params.parentDn,
              nodeType: 'DEVICE',
            }),
          });

          apiResults['tree'] = { status: treeResponse.status };
          if (treeResponse.ok) {
            const treeData = await treeResponse.json();
            const treeDevices = treeData?.data || [];
            apiResults['tree'] = { status: treeResponse.status, count: Array.isArray(treeDevices) ? treeDevices.length : 0 };
            if (Array.isArray(treeDevices)) {
              // Filter for only device nodes, not folders or stations
              const deviceNodes = treeDevices.filter((n: Record<string, unknown>) =>
                n.nodeType === 'DEVICE' || n.mocTypeName
              );
              allDevices.push(...deviceNodes.map((d: Record<string, unknown>) => ({ ...d, source: 'tree' })));
            }
          }
        } catch (e) { apiResults['tree'] = { error: String(e) }; }

        // Deduplicate by DN
        const unique = allDevices.filter((d, i, arr) => {
          const dn = d.dn || d.deviceDn || d.nodeDn;
          return arr.findIndex(x => (x.dn || x.deviceDn || x.nodeDn) === dn) === i;
        });

        return { devices: unique, debug: apiResults };
      }, { stationDn, parentDn });

      // Log debug info
      if (childDevices.debug) {
        logger.debug(`  Sub-device API results for ${parentDn}: ${JSON.stringify(childDevices.debug)}`);
      }

      if (childDevices.devices.length > 0) {
        logger.debug(`  Found ${childDevices.devices.length} children for ${parentDn}`);

        for (const d of childDevices.devices) {
          const typeId = d.typeId as string | number | undefined ?? d.mocId as string | number | undefined;
          const deviceType = d.mocTypeName || d.nodeType || this.mapDeviceType(typeId);
          const deviceDn = String(d.dn || d.deviceDn || d.nodeDn);

          // Skip if already in list or if it's a parent device
          if (subDevices.some(sd => sd.deviceDn === deviceDn)) continue;
          if (parentDns.includes(deviceDn)) continue;

          subDevices.push({
            deviceDn,
            deviceName: String(d.name || d.deviceName || d.nodeName || ''),
            deviceType: String(deviceType || 'Unknown'),
            deviceTypeId: typeof d.typeId === 'number' ? d.typeId : typeof d.mocId === 'number' ? d.mocId : undefined,
            model: String(d.model || d.devModel || ''),
            status: String(d.status || d.deviceStatus || ''),
            stationDn: stationDn,
            parentDeviceDn: parentDn,
          });
        }
      }
    }

    return subDevices;
  }

  /**
   * Get real-time data for a device (inverter or meter)
   * Tries multiple API endpoints to find one that returns actual readings
   */
  async getDeviceData(deviceDn: string): Promise<Partial<BrowserDevice> | null> {
    if (!this.page || !this.isLoggedIn) throw new Error('Not logged in');

    logger.info(`  Fetching realtime data for device ${deviceDn}...`);

    // Try multiple API endpoints to get device data
    const result = await this.page.evaluate(async (dn: string) => {
      const results: Record<string, unknown> = {};

      // Method 1: device-realtime-kpi (most likely to have power data)
      try {
        const kpiResponse = await fetch(
          `/rest/pvms/web/device/v1/device-realtime-kpi?deviceDn=${encodeURIComponent(dn)}&_=${Date.now()}`
        );
        if (kpiResponse.ok) {
          const data = await kpiResponse.json();
          results['device-realtime-kpi'] = { status: kpiResponse.status, data };
        } else {
          results['device-realtime-kpi'] = { status: kpiResponse.status };
        }
      } catch (e) { results['device-realtime-kpi'] = { error: String(e) }; }

      // Method 2: device-history-data with current time (sometimes has realtime)
      try {
        const now = Date.now();
        const historyResponse = await fetch(
          `/rest/pvms/web/device/v1/device-history-data?deviceDn=${encodeURIComponent(dn)}&startTime=${now - 300000}&endTime=${now}&_=${now}`
        );
        if (historyResponse.ok) {
          const data = await historyResponse.json();
          results['device-history-data'] = { status: historyResponse.status, data };
        } else {
          results['device-history-data'] = { status: historyResponse.status };
        }
      } catch (e) { results['device-history-data'] = { error: String(e) }; }

      // Method 3: inverter-realtime-data (specific for inverters)
      try {
        const invResponse = await fetch(
          `/rest/pvms/web/device/v1/inverter-realtime-data?deviceDn=${encodeURIComponent(dn)}&_=${Date.now()}`
        );
        if (invResponse.ok) {
          const data = await invResponse.json();
          results['inverter-realtime-data'] = { status: invResponse.status, data };
        } else {
          results['inverter-realtime-data'] = { status: invResponse.status };
        }
      } catch (e) { results['inverter-realtime-data'] = { error: String(e) }; }

      // Method 4: device-statistics-signal (may have signal data)
      try {
        const sigResponse = await fetch(
          `/rest/pvms/web/device/v1/device-statistics-signal?deviceDn=${encodeURIComponent(dn)}&_=${Date.now()}`
        );
        if (sigResponse.ok) {
          const data = await sigResponse.json();
          results['device-statistics-signal'] = { status: sigResponse.status, data };
        } else {
          results['device-statistics-signal'] = { status: sigResponse.status };
        }
      } catch (e) { results['device-statistics-signal'] = { error: String(e) }; }

      // Method 5: device-realtime-data (original - returns status only)
      try {
        const rtResponse = await fetch(
          `/rest/pvms/web/device/v1/device-realtime-data?deviceDn=${encodeURIComponent(dn)}&displayAccessModel=true&_=${Date.now()}`
        );
        if (rtResponse.ok) {
          const data = await rtResponse.json();
          results['device-realtime-data'] = { status: rtResponse.status, data };
        } else {
          results['device-realtime-data'] = { status: rtResponse.status };
        }
      } catch (e) { results['device-realtime-data'] = { error: String(e) }; }

      // Method 6: mo-details (device metadata and possibly readings)
      try {
        const moResponse = await fetch(
          `/rest/pvms/web/device/v1/mo-details?dn=${encodeURIComponent(dn)}&_=${Date.now()}`
        );
        if (moResponse.ok) {
          const data = await moResponse.json();
          results['mo-details'] = { status: moResponse.status, data };
        } else {
          results['mo-details'] = { status: moResponse.status };
        }
      } catch (e) { results['mo-details'] = { error: String(e) }; }

      // Method 7: dev-real-kpi (alternative KPI endpoint)
      try {
        const devKpiResponse = await fetch(
          `/rest/pvms/web/device/v1/dev-real-kpi?devIds=${encodeURIComponent(dn)}&_=${Date.now()}`
        );
        if (devKpiResponse.ok) {
          const data = await devKpiResponse.json();
          results['dev-real-kpi'] = { status: devKpiResponse.status, data };
        } else {
          results['dev-real-kpi'] = { status: devKpiResponse.status };
        }
      } catch (e) { results['dev-real-kpi'] = { error: String(e) }; }

      return results;
    }, deviceDn);

    // Extract signals from device-realtime-data API response
    // Response format: [{"status":1}, {"groupName":"Others","signals":[{id,name,realValue,value,unit},...]}]
    let signals: Array<{ id: number; name: string; realValue: string; value: string; unit: string }> = [];
    let deviceConnectionStatus = 0;

    const deviceRealtimeResult = result['device-realtime-data'] as { status?: number; data?: { data?: unknown[] } };
    if (deviceRealtimeResult?.data?.data && Array.isArray(deviceRealtimeResult.data.data)) {
      const items = deviceRealtimeResult.data.data;

      for (const item of items) {
        const itemObj = item as Record<string, unknown>;

        // First item is connection status: {"status":1}
        if (typeof itemObj.status === 'number' && !itemObj.groupName) {
          deviceConnectionStatus = itemObj.status;
          logger.info(`    Device connection status: ${deviceConnectionStatus === 1 ? 'online' : 'offline'}`);
        }

        // Signal groups: {"groupName":"Others","signals":[...]}
        if (itemObj.signals && Array.isArray(itemObj.signals)) {
          const groupName = itemObj.groupName || 'Unknown';
          logger.info(`    Signal group "${groupName}": ${itemObj.signals.length} signals`);

          for (const sig of itemObj.signals) {
            const signal = sig as { id?: number; name?: string; realValue?: string; value?: string; unit?: string };
            if (signal.id !== undefined) {
              signals.push({
                id: signal.id,
                name: signal.name || '',
                realValue: String(signal.realValue || ''),
                value: String(signal.value || ''),
                unit: signal.unit || '',
              });
            }
          }
        }
      }
    }

    // Log extracted signals
    if (signals.length > 0) {
      logger.info(`    Extracted ${signals.length} total signals`);
      // Log first 5 signals for debugging
      const sampleSignals = signals.slice(0, 5).map(s => `${s.id}:${s.name}=${s.realValue}${s.unit}`);
      logger.info(`    Sample signals: ${sampleSignals.join(', ')}`);
    } else {
      logger.warn(`    No signals found for ${deviceDn}`);
    }

    // Build data object from signals using name-based matching
    // This is more reliable than ID-based mapping since IDs can vary
    const data: Record<string, unknown> = {};
    data._connectionStatus = deviceConnectionStatus;

    // Map signal names to our field names (case-insensitive matching)
    // Note: Unit conversion is handled separately based on signal.unit
    const namePatterns: Array<{ pattern: RegExp; field: string; transform?: (v: string) => number }> = [
      // Power signals (unit conversion handled below)
      { pattern: /^active\s*power$/i, field: 'activePower' },
      { pattern: /^output\s*power$/i, field: 'activePower' },
      { pattern: /^reactive\s*power$/i, field: 'reactivePower' },
      { pattern: /^output\s*reactive\s*power$/i, field: 'reactivePower' },
      { pattern: /^input\s*power$/i, field: 'inputPower' },
      { pattern: /^dc\s*power$/i, field: 'inputPower' },

      // Energy signals
      { pattern: /^daily\s*energy$/i, field: 'dailyEnergy', transform: parseFloat },
      { pattern: /^day\s*energy$/i, field: 'dailyEnergy', transform: parseFloat },
      { pattern: /^total\s*yield$/i, field: 'totalYield', transform: parseFloat },
      { pattern: /^total\s*energy$/i, field: 'totalYield', transform: parseFloat },
      { pattern: /^cumulative\s*energy$/i, field: 'totalYield', transform: parseFloat },
      { pattern: /^positive\s*active\s*energy$/i, field: 'positiveActiveEnergy', transform: parseFloat },
      { pattern: /^negative\s*active\s*energy$/i, field: 'negativeActiveEnergy', transform: parseFloat },

      // Grid signals
      { pattern: /^grid\s*voltage$/i, field: 'gridVoltage', transform: parseFloat },
      { pattern: /^output\s*voltage$/i, field: 'gridVoltage', transform: parseFloat },
      { pattern: /^a[\-_]?phase\s*voltage$/i, field: 'gridVoltage', transform: parseFloat },
      { pattern: /^grid\s*current$/i, field: 'gridCurrent', transform: parseFloat },
      { pattern: /^output\s*current$/i, field: 'gridCurrent', transform: parseFloat },
      { pattern: /^grid\s*frequency$/i, field: 'gridFrequency', transform: parseFloat },
      { pattern: /^frequency$/i, field: 'gridFrequency', transform: parseFloat },
      { pattern: /^power\s*factor$/i, field: 'powerFactor', transform: parseFloat },

      // Temperature
      { pattern: /temperature/i, field: 'temperature', transform: parseFloat },
      { pattern: /^internal\s*temp/i, field: 'temperature', transform: parseFloat },

      // Efficiency
      { pattern: /^efficiency$/i, field: 'efficiency', transform: parseFloat },
      { pattern: /^inverter\s*efficiency$/i, field: 'efficiency', transform: parseFloat },

      // PV string signals
      { pattern: /^pv1?\s*voltage$/i, field: 'pv1Voltage', transform: parseFloat },
      { pattern: /^pv1?\s*current$/i, field: 'pv1Current', transform: parseFloat },
      { pattern: /^pv2\s*voltage$/i, field: 'pv2Voltage', transform: parseFloat },
      { pattern: /^pv2\s*current$/i, field: 'pv2Current', transform: parseFloat },
      { pattern: /^pv3\s*voltage$/i, field: 'pv3Voltage', transform: parseFloat },
      { pattern: /^pv3\s*current$/i, field: 'pv3Current', transform: parseFloat },
      { pattern: /^pv4\s*voltage$/i, field: 'pv4Voltage', transform: parseFloat },
      { pattern: /^pv4\s*current$/i, field: 'pv4Current', transform: parseFloat },

      // Status signals
      { pattern: /^inverter\s*status$/i, field: 'statusCode' },
      { pattern: /^meter\s*status$/i, field: 'meterStatusCode' },
      { pattern: /^run\s*status$/i, field: 'runStatus' },
      { pattern: /^device\s*status$/i, field: 'deviceStatus' },
    ];

    for (const signal of signals) {
      // Try to match by signal name
      for (const { pattern, field, transform } of namePatterns) {
        if (pattern.test(signal.name)) {
          let value = transform ? transform(signal.realValue) : parseFloat(signal.realValue);

          // Handle unit conversions for power/energy values
          const unit = signal.unit.toLowerCase();
          if (field === 'activePower' || field === 'reactivePower' || field === 'inputPower') {
            // Convert to kW if in W
            if (unit === 'w' || unit === 'var') {
              value = value / 1000;
            }
            // Already in kW or kvar - no conversion needed
          }

          // Only set if not already set (first match wins)
          if (data[field] === undefined) {
            data[field] = value;
          }
          break;
        }
      }

      // Also store all signals by ID and name for debugging
      data[`signal_${signal.id}`] = signal.realValue;
      data[`signal_${signal.id}_name`] = signal.name;
      data[`signal_${signal.id}_unit`] = signal.unit;
    }

    // Set connection status
    data.connectionOnline = deviceConnectionStatus === 1;

    // Log parsed data
    const parsedFields = Object.entries(data)
      .filter(([k, v]) => !k.startsWith('signal_') && k !== '_connectionStatus' && v !== undefined && v !== 0 && v !== '')
      .map(([k, v]) => `${k}=${v}`);
    logger.info(`    Parsed data: ${parsedFields.join(', ') || 'none'}`);

    // Extract all available real-time data from parsed signals
    // FusionSolar uses various field names depending on device type (inverter vs meter)
    const realtimeData: Partial<BrowserDevice> = {
      // Common fields (inverter + meter)
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
      // Use connection status to determine device state
      // connectionOnline is set from the API's device connection status
      status: data.connectionOnline ? 'online' : String(data.statusCode || data.runStatus || data.state || data.meterStatusCode || data.deviceStatus || 'offline'),
      softwareVersion: String(data.softwareVersion || data.softVer || data.sw_version || ''),

      // Meter-specific fields
      reactivePower: this.parseNumber(data.reactivePower || data.reactive_power),
      positiveActiveEnergy: this.parseNumber(
        data.positiveActiveEnergy || data.positive_active_energy || data.importEnergy
      ),
      negativeActiveEnergy: this.parseNumber(
        data.negativeActiveEnergy || data.negative_active_energy || data.exportEnergy
      ),

      // Phase voltages (meter)
      phaseAVoltage: this.parseNumber(data.phaseAVoltage || data.phase_a_voltage || data.a_u),
      phaseBVoltage: this.parseNumber(data.phaseBVoltage || data.phase_b_voltage || data.b_u),
      phaseCVoltage: this.parseNumber(data.phaseCVoltage || data.phase_c_voltage || data.c_u),

      // Phase currents (meter)
      phaseACurrent: this.parseNumber(data.phaseACurrent || data.phase_a_current || data.a_i),
      phaseBCurrent: this.parseNumber(data.phaseBCurrent || data.phase_b_current || data.b_i),
      phaseCCurrent: this.parseNumber(data.phaseCCurrent || data.phase_c_current || data.c_i),

      // Phase active power (meter)
      phaseAActivePower: this.parseNumber(data.phaseAActivePower || data.phase_a_active_power),
      phaseBActivePower: this.parseNumber(data.phaseBActivePower || data.phase_b_active_power),
      phaseCActivePower: this.parseNumber(data.phaseCActivePower || data.phase_c_active_power),

      // Line voltages (meter)
      abLineVoltage: this.parseNumber(data.ABLineVoltage || data.ab_line_voltage || data.uab),
      bcLineVoltage: this.parseNumber(data.BCLineVoltage || data.bc_line_voltage || data.ubc),
      caLineVoltage: this.parseNumber(data.CALineVoltage || data.ca_line_voltage || data.uca),
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

          // First validate this is a real station (not a folder) using station-detail API
          // Folders return 406 or null from this endpoint
          const stationDetail = await this.getStationDetail(station.stationDn);
          if (!stationDetail) {
            logger.warn(`  Skipping ${station.stationName} - not a valid station (likely a folder)`);
            continue;
          }

          // Get energy data (will reuse stationDetail internally)
          const energyData = await this.getEnergyDataWithDetail(station.stationDn, stationDetail);
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
                reactivePower: device.reactivePower || 0,
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
                // Build pvStrings array from individual PV data
                pvStrings: this.buildPvStrings(device),
                efficiency: device.efficiency,
                inputPower: device.inputPower,
                // Meter-specific fields
                positiveActiveEnergy: device.positiveActiveEnergy,
                negativeActiveEnergy: device.negativeActiveEnergy,
              },
            });
            await this.delay(500);
          }

          // Use station detail for accurate capacity (already fetched during validation)
          const stationCapacity = stationDetail.capacity || station.capacity || 0;
          const gridConnectionDate = stationDetail.gridConnectionDate || station.gridConnectionDate || '';

          // Build station result
          const realtimeKpi: StationRealTimeKpi = {
            stationDn: station.stationDn,
            currentPower: energyData?.realTimePower || 0,
            yieldToday: energyData?.dayEnergy || 0,
            totalYield: energyData?.totalEnergy || 0,
            revenueToday: 0,
            ratedPower: stationCapacity,
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
              gridConnectionDate,
              capacity: stationCapacity,
              ratedPower: stationCapacity,
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
   * Build PV strings array from individual PV voltage/current fields
   */
  private buildPvStrings(device: Partial<BrowserDevice>): Array<{ stringId: string; voltage: number; current: number }> {
    const pvStrings: Array<{ stringId: string; voltage: number; current: number }> = [];

    // Check for PV1 through PV4 (common for residential inverters)
    const pvData = [
      { id: 'PV1', voltage: device.pv1Voltage, current: device.pv1Current },
      { id: 'PV2', voltage: device.pv2Voltage, current: device.pv2Current },
      { id: 'PV3', voltage: device.pv3Voltage, current: device.pv3Current },
      { id: 'PV4', voltage: device.pv4Voltage, current: device.pv4Current },
    ];

    for (const pv of pvData) {
      // Only include if we have at least voltage or current data
      if (pv.voltage !== undefined || pv.current !== undefined) {
        pvStrings.push({
          stringId: pv.id,
          voltage: pv.voltage || 0,
          current: pv.current || 0,
        });
      }
    }

    return pvStrings;
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
