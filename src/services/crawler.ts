import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { FusionSolarAuthenticator } from './authenticator.js';
import { FusionSolarApiClient } from './api-client.js';
import type {
  CrawlResult,
  StationCrawlResult,
  DeviceCrawlResult,
  CrawlError,
  Station,
  Device,
} from '../types/fusionsolar.js';

export class FusionSolarCrawler {
  private authenticator: FusionSolarAuthenticator;
  private apiClient: FusionSolarApiClient;
  private isRunning = false;

  constructor() {
    this.authenticator = new FusionSolarAuthenticator();
    this.apiClient = new FusionSolarApiClient();
  }

  /**
   * Initialize crawler - authenticate and set up API client
   */
  async initialize(): Promise<void> {
    logger.info('Initializing FusionSolar crawler...');

    // Authenticate and get session cookies
    const session = await this.authenticator.login();
    this.apiClient.setCookies(session.cookies);

    // Verify session is working
    const isAlive = await this.apiClient.isSessionAlive();
    if (!isAlive) {
      throw new Error('Session verification failed after login');
    }

    logger.info('Crawler initialized successfully');
  }

  /**
   * Run a single crawl cycle
   */
  async crawl(): Promise<CrawlResult> {
    if (this.isRunning) {
      logger.warn('Crawl already in progress, skipping...');
      return {
        timestamp: new Date(),
        stations: [],
        success: false,
        errors: [
          {
            endpoint: 'crawler',
            message: 'Crawl already in progress',
            timestamp: new Date(),
          },
        ],
        duration: 0,
      };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const errors: CrawlError[] = [];
    const stationResults: StationCrawlResult[] = [];

    try {
      logger.info('Starting crawl cycle...');

      // Ensure session is alive
      const isAlive = await this.apiClient.isSessionAlive();
      if (!isAlive) {
        logger.info('Session expired, re-authenticating...');
        await this.initialize();
      }

      // Get all stations
      const stations = await this.crawlWithRetry(
        () => this.apiClient.getStationList(),
        'getStationList'
      );

      if (!stations || stations.length === 0) {
        logger.warn('No stations found');
        return {
          timestamp: new Date(),
          stations: [],
          success: true,
          errors,
          duration: Date.now() - startTime,
        };
      }

      logger.info(`Found ${stations.length} stations to crawl`);

      // Crawl each station sequentially
      for (const station of stations) {
        try {
          const stationResult = await this.crawlStation(station);
          stationResults.push(stationResult);
          logger.info(`Completed crawling station: ${station.stationName}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to crawl station ${station.stationName}:`, error);
          errors.push({
            stationDn: station.stationDn,
            endpoint: 'crawlStation',
            message: errorMessage,
            timestamp: new Date(),
          });
        }

        // Delay between stations to avoid rate limiting
        await this.apiClient.delay();
      }

      const duration = Date.now() - startTime;
      logger.info(
        `Crawl cycle completed in ${duration}ms. ` +
          `Stations: ${stationResults.length}, Errors: ${errors.length}`
      );

      return {
        timestamp: new Date(),
        stations: stationResults,
        success: errors.length === 0,
        errors,
        duration,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Crawl cycle failed:', error);

      return {
        timestamp: new Date(),
        stations: stationResults,
        success: false,
        errors: [
          ...errors,
          {
            endpoint: 'crawl',
            message: errorMessage,
            timestamp: new Date(),
          },
        ],
        duration: Date.now() - startTime,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Crawl a single station
   */
  private async crawlStation(station: Station): Promise<StationCrawlResult> {
    logger.info(`Crawling station: ${station.stationName} (${station.stationDn})`);

    // Get energy balance
    const energyBalance = await this.crawlWithRetry(
      () => this.apiClient.getEnergyBalance(station.stationDn),
      'getEnergyBalance',
      station.stationDn
    );

    await this.apiClient.delay(500);

    // Get devices for this station
    const devices = await this.crawlWithRetry(
      () => this.apiClient.getDeviceList(station.stationDn),
      'getDeviceList',
      station.stationDn
    );

    await this.apiClient.delay(500);

    // Crawl each device
    const deviceResults: DeviceCrawlResult[] = [];
    for (const device of devices || []) {
      try {
        const deviceResult = await this.crawlDevice(device);
        deviceResults.push(deviceResult);
      } catch (error) {
        logger.warn(`Failed to crawl device ${device.deviceName}:`, error);
        deviceResults.push({
          device,
          realtimeData: null,
        });
      }

      await this.apiClient.delay(300);
    }

    // Get alarms
    const alarms = await this.crawlWithRetry(
      () => this.apiClient.getAlarms(station.stationDn),
      'getAlarms',
      station.stationDn
    );

    // Build station KPI from energy balance
    const realtimeKpi = {
      stationDn: station.stationDn,
      currentPower: 0, // Will be calculated from devices
      yieldToday: energyBalance?.generatedByPV || 0,
      totalYield: 0, // Need separate API call
      revenueToday: 0,
      ratedPower: station.ratedPower || 0,
      ratedESSCapacity: 0,
    };

    // Calculate current power from devices
    realtimeKpi.currentPower = deviceResults.reduce((sum, dr) => {
      return sum + (dr.realtimeData?.activePower || 0);
    }, 0);

    return {
      station,
      realtimeKpi,
      energyBalance: energyBalance || {
        stationDn: station.stationDn,
        date: new Date().toISOString().split('T')[0],
        timeDim: 2,
        generatedByPV: 0,
        consumedFromPV: 0,
        fedToGrid: 0,
        consumedByAppliances: 0,
        fromPV: 0,
        fromGrid: 0,
      },
      devices: deviceResults,
      alarms: alarms || [],
      environmental: {
        standardCoalSaved: 0,
        co2Avoided: 0,
        equivalentTreesPlanted: 0,
      },
    };
  }

  /**
   * Crawl a single device
   */
  private async crawlDevice(device: Device): Promise<DeviceCrawlResult> {
    logger.debug(`Crawling device: ${device.deviceName} (${device.deviceDn})`);

    const realtimeData = await this.apiClient.getDeviceRealtimeData(device.deviceDn);

    return {
      device,
      realtimeData,
    };
  }

  /**
   * Execute a function with retry logic
   */
  private async crawlWithRetry<T>(
    fn: () => Promise<T>,
    operationName: string,
    context?: string
  ): Promise<T | null> {
    const maxRetries = config.crawler.retryAttempts;
    const retryDelay = config.crawler.retryDelayMs;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const contextStr = context ? ` (${context})` : '';

        if (attempt === maxRetries) {
          logger.error(
            `${operationName}${contextStr} failed after ${maxRetries} attempts: ${errorMessage}`
          );
          return null;
        }

        logger.warn(
          `${operationName}${contextStr} attempt ${attempt}/${maxRetries} failed: ${errorMessage}. ` +
            `Retrying in ${retryDelay}ms...`
        );

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    return null;
  }

  /**
   * Check if crawler is currently running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

export default FusionSolarCrawler;
