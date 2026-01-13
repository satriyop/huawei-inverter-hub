import axios, { AxiosInstance } from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type { CrawlResult, StationCrawlResult } from '../types/fusionsolar.js';

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
        logger.error('NexSolarHub API Error:', {
          url: error.config?.url,
          status: error.response?.status,
          message: error.message,
        });
        throw error;
      }
    );
  }

  /**
   * Push crawl result to NexSolarHub
   */
  async pushCrawlResult(result: CrawlResult): Promise<void> {
    if (result.stations.length === 0) {
      logger.info('No station data to push');
      return;
    }

    logger.info(`Pushing data for ${result.stations.length} stations to NexSolarHub...`);

    try {
      // Push each station's data
      for (const stationResult of result.stations) {
        await this.pushStationData(stationResult);
      }

      // Push summary
      await this.pushCrawlSummary(result);

      logger.info('Data pushed successfully to NexSolarHub');
    } catch (error) {
      logger.error('Failed to push data to NexSolarHub:', error);
      throw error;
    }
  }

  /**
   * Push station data
   */
  async pushStationData(stationResult: StationCrawlResult): Promise<void> {
    const { station, realtimeKpi, energyBalance, devices, alarms } = stationResult;

    // Upsert station
    await this.client.post('/ingestion/stations', {
      external_id: station.stationDn,
      name: station.stationName,
      country: station.country,
      address: station.address,
      capacity_kwp: station.capacity,
      rated_power_kw: station.ratedPower,
      timezone: station.timeZoneStr,
      grid_connection_date: station.gridConnectionDate,
      status: station.status,
    });

    // Push real-time reading
    await this.client.post('/ingestion/readings', {
      station_external_id: station.stationDn,
      recorded_at: new Date().toISOString(),
      current_power_kw: realtimeKpi.currentPower,
      yield_today_kwh: realtimeKpi.yieldToday,
      total_yield_kwh: realtimeKpi.totalYield,
      generated_by_pv_kwh: energyBalance.generatedByPV,
      consumed_from_pv_kwh: energyBalance.consumedFromPV,
      fed_to_grid_kwh: energyBalance.fedToGrid,
      consumed_by_appliances_kwh: energyBalance.consumedByAppliances,
      from_grid_kwh: energyBalance.fromGrid,
    });

    // Push device data
    for (const deviceResult of devices) {
      if (deviceResult.realtimeData) {
        await this.client.post('/ingestion/devices', {
          station_external_id: station.stationDn,
          external_id: deviceResult.device.deviceDn,
          name: deviceResult.device.deviceName,
          type: deviceResult.device.deviceType,
          software_version: deviceResult.device.softwareVersion,
          status: deviceResult.realtimeData.status,
          active_power_kw: deviceResult.realtimeData.activePower,
          daily_energy_kwh: deviceResult.realtimeData.dailyEnergy,
          total_yield_kwh: deviceResult.realtimeData.totalYield,
          grid_voltage_v: deviceResult.realtimeData.gridVoltage,
          grid_current_a: deviceResult.realtimeData.gridCurrent,
          grid_frequency_hz: deviceResult.realtimeData.gridFrequency,
          internal_temperature_c: deviceResult.realtimeData.internalTemperature,
          power_factor: deviceResult.realtimeData.powerFactor,
        });
      }
    }

    // Push alarms
    for (const alarm of alarms) {
      await this.client.post('/ingestion/alarms', {
        station_external_id: station.stationDn,
        device_external_id: alarm.deviceDn,
        alarm_id: alarm.alarmId,
        alarm_code: alarm.alarmCode,
        alarm_name: alarm.alarmName,
        severity: alarm.severity,
        started_at: alarm.startTime,
        ended_at: alarm.endTime,
        status: alarm.status,
      });
    }
  }

  /**
   * Push crawl summary
   */
  async pushCrawlSummary(result: CrawlResult): Promise<void> {
    await this.client.post('/ingestion/crawl-summary', {
      crawled_at: result.timestamp.toISOString(),
      duration_ms: result.duration,
      stations_count: result.stations.length,
      success: result.success,
      errors_count: result.errors.length,
      errors: result.errors.map((e) => ({
        station_external_id: e.stationDn,
        device_external_id: e.deviceDn,
        endpoint: e.endpoint,
        message: e.message,
        occurred_at: e.timestamp.toISOString(),
      })),
    });
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
