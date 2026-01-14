import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { CrawlResult, StationCrawlResult } from '../types/fusionsolar.js';

// Retry configuration
const RETRY_STATUS_CODES = [500, 502, 503, 504];
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export interface PushResult {
  success: boolean;
  stationsPushed: number;
  devicesPushed: number;
  readingsPushed: number;
  alarmsPushed: number;
  errors: string[];
}

export class NexSolarHubClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.nexSolarHub.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': config.nexSolarHub.apiKey,
      },
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use((requestConfig) => {
      logger.debug(
        `NexSolarHub Request: ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`
      );
      return requestConfig;
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        const axiosError = error as AxiosError;
        logger.error('NexSolarHub API Error:', {
          url: axiosError.config?.url,
          status: axiosError.response?.status,
          message: axiosError.message,
          data: axiosError.response?.data,
        });
        throw error;
      }
    );
  }

  /**
   * Execute request with retry logic for transient failures
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const axiosError = error as AxiosError;
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry client errors (4xx except 429)
        const status = axiosError.response?.status;
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw error;
        }

        // Check if we should retry
        const shouldRetry =
          !status ||
          RETRY_STATUS_CODES.includes(status) ||
          status === 429 ||
          axiosError.code === 'ECONNRESET' ||
          axiosError.code === 'ETIMEDOUT';

        if (shouldRetry && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logger.warn(
            `${context} failed (attempt ${attempt}/${MAX_RETRIES}): ${lastError.message}. Retrying in ${delay}ms...`
          );
          await this.delay(delay);
        } else {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Push crawl result to NexSolarHub
   */
  async pushCrawlResult(result: CrawlResult): Promise<PushResult> {
    const pushResult: PushResult = {
      success: true,
      stationsPushed: 0,
      devicesPushed: 0,
      readingsPushed: 0,
      alarmsPushed: 0,
      errors: [],
    };

    if (result.stations.length === 0) {
      logger.info('No station data to push');
      return pushResult;
    }

    logger.info(`Pushing data for ${result.stations.length} stations to NexSolarHub...`);

    // Push each station's data
    for (const stationResult of result.stations) {
      try {
        const stationPushResult = await this.pushStationData(stationResult);
        pushResult.stationsPushed += 1;
        pushResult.devicesPushed += stationPushResult.devicesPushed;
        pushResult.readingsPushed += stationPushResult.readingsPushed;
        pushResult.alarmsPushed += stationPushResult.alarmsPushed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushResult.errors.push(`Station ${stationResult.station.stationDn}: ${message}`);
        pushResult.success = false;
        logger.error(`Failed to push station ${stationResult.station.stationDn}:`, error);
      }
    }

    // Push summary
    try {
      await this.pushCrawlSummary(result);
      logger.info('Crawl summary pushed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushResult.errors.push(`Crawl summary: ${message}`);
      logger.error('Failed to push crawl summary:', error);
    }

    if (pushResult.success) {
      logger.info('Data pushed successfully to NexSolarHub');
    } else {
      logger.warn(`Push completed with ${pushResult.errors.length} errors`);
    }

    return pushResult;
  }

  /**
   * Push station data
   */
  async pushStationData(
    stationResult: StationCrawlResult
  ): Promise<{ devicesPushed: number; readingsPushed: number; alarmsPushed: number }> {
    const { station, realtimeKpi, energyBalance, environmental, devices, alarms } = stationResult;
    const recordedAt = new Date().toISOString();
    let devicesPushed = 0;
    let readingsPushed = 0;
    let alarmsPushed = 0;

    // Upsert station with retry
    await this.withRetry(
      () =>
        this.client.post('/ingestion/stations', {
          external_id: station.stationDn,
          name: station.stationName,
          country: station.country,
          address: station.address || undefined,
          capacity_kwp: station.capacity || undefined,
          rated_power_kw: station.ratedPower || undefined,
          timezone: station.timeZoneStr || undefined,
          grid_connection_date: station.gridConnectionDate || undefined,
          status: station.status,
        }),
      `Push station ${station.stationDn}`
    );
    logger.info(`  ✓ Station ${station.stationName} pushed`);

    // Push real-time reading with retry
    await this.withRetry(
      () =>
        this.client.post('/ingestion/readings', {
          station_external_id: station.stationDn,
          recorded_at: recordedAt,
          current_power_kw: realtimeKpi.currentPower,
          yield_today_kwh: realtimeKpi.yieldToday,
          total_yield_kwh: realtimeKpi.totalYield,
          generated_by_pv_kwh: energyBalance.generatedByPV,
          consumed_from_pv_kwh: energyBalance.consumedFromPV,
          fed_to_grid_kwh: energyBalance.fedToGrid,
          consumed_by_appliances_kwh: energyBalance.consumedByAppliances,
          from_grid_kwh: energyBalance.fromGrid,
          co2_avoided_tons: environmental?.co2Avoided,
          trees_planted: environmental?.equivalentTreesPlanted,
          coal_saved_tons: environmental?.standardCoalSaved,
        }),
      `Push reading for ${station.stationDn}`
    );
    readingsPushed++;
    logger.info(`  ✓ Station reading pushed`);

    // Push device data with retry
    for (const deviceResult of devices) {
      const { device, realtimeData } = deviceResult;

      await this.withRetry(
        () =>
          this.client.post('/ingestion/devices', {
            station_external_id: station.stationDn,
            external_id: device.deviceDn,
            name: device.deviceName,
            type: device.deviceType,
            model: device.deviceModel || undefined,
            software_version: device.softwareVersion || undefined,
            status: device.status,
            // Include realtime data for device reading
            recorded_at: recordedAt,
            active_power_kw: realtimeData?.activePower,
            daily_energy_kwh: realtimeData?.dailyEnergy,
            total_yield_kwh: realtimeData?.totalYield,
            grid_voltage_v: realtimeData?.gridVoltage,
            grid_current_a: realtimeData?.gridCurrent,
            grid_frequency_hz: realtimeData?.gridFrequency,
            internal_temperature_c: realtimeData?.internalTemperature,
            power_factor: realtimeData?.powerFactor,
            efficiency: realtimeData?.efficiency,
            input_power_kw: realtimeData?.inputPower,
            pv_strings: realtimeData?.pvStrings?.length
              ? realtimeData.pvStrings.map((pv) => ({
                  stringId: pv.stringId,
                  voltage: pv.voltage,
                  current: pv.current,
                }))
              : undefined,
          }),
        `Push device ${device.deviceDn}`
      );
      devicesPushed++;
    }
    if (devicesPushed > 0) {
      logger.info(`  ✓ ${devicesPushed} device(s) pushed`);
    }

    // Push alarms with retry
    for (const alarm of alarms) {
      await this.withRetry(
        () =>
          this.client.post('/ingestion/alarms', {
            station_external_id: station.stationDn,
            device_external_id: alarm.deviceDn || undefined,
            alarm_id: alarm.alarmId,
            alarm_code: alarm.alarmCode || undefined,
            alarm_name: alarm.alarmName,
            severity: alarm.severity,
            started_at: alarm.startTime,
            ended_at: alarm.endTime || undefined,
            status: alarm.status,
          }),
        `Push alarm ${alarm.alarmId}`
      );
      alarmsPushed++;
    }
    if (alarmsPushed > 0) {
      logger.info(`  ✓ ${alarmsPushed} alarm(s) pushed`);
    }

    return { devicesPushed, readingsPushed, alarmsPushed };
  }

  /**
   * Push crawl summary
   */
  async pushCrawlSummary(result: CrawlResult): Promise<void> {
    await this.withRetry(
      () =>
        this.client.post('/ingestion/crawl-summary', {
          crawled_at: result.timestamp.toISOString(),
          duration_ms: result.duration,
          stations_count: result.stations.length,
          success: result.success,
          errors_count: result.errors.length,
          errors: result.errors.map((e) => ({
            station_external_id: e.stationDn || undefined,
            device_external_id: e.deviceDn || undefined,
            endpoint: e.endpoint,
            message: e.message,
            occurred_at: e.timestamp.toISOString(),
          })),
        }),
      'Push crawl summary'
    );
  }

  /**
   * Health check for NexSolarHub API
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export default NexSolarHubClient;
