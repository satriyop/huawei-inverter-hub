import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type {
  Station,
  StationRealTimeKpi,
  EnergyBalance,
  Device,
  InverterRealtimeData,
  Alarm,
  TimeDimension,
  Cookie,
} from '../types/fusionsolar.js';

export class FusionSolarApiClient {
  private client: AxiosInstance;
  private cookies: Cookie[] = [];

  constructor() {
    this.client = axios.create({
      baseURL: config.fusionSolar.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use((requestConfig) => {
      logger.debug(`API Request: ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`);
      return requestConfig;
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        logger.error(`API Error: ${error.message}`, {
          url: error.config?.url,
          status: error.response?.status,
        });
        throw error;
      }
    );
  }

  /**
   * Set session cookies for API requests
   */
  setCookies(cookies: Cookie[]): void {
    this.cookies = cookies;
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    this.client.defaults.headers.common['Cookie'] = cookieHeader;

    // Extract XSRF token if present
    const xsrfCookie = cookies.find((c) => c.name === 'XSRF-TOKEN');
    if (xsrfCookie) {
      this.client.defaults.headers.common['X-XSRF-TOKEN'] = decodeURIComponent(
        xsrfCookie.value
      );
    }

    logger.info(`API client configured with ${cookies.length} cookies`);
  }

  /**
   * Check if session is alive
   */
  async isSessionAlive(): Promise<boolean> {
    try {
      const response = await this.client.get('/rest/dpcloud/auth/v1/is-session-alive');
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Keep session alive
   */
  async keepAlive(): Promise<void> {
    await this.client.get('/rest/dpcloud/auth/v1/keep-alive');
  }

  /**
   * Get list of all stations
   */
  async getStationList(pageNo = 1, pageSize = 100): Promise<Station[]> {
    logger.info(`Fetching station list (page ${pageNo}, size ${pageSize})...`);

    const response = await this.client.post(
      '/rest/pvms/web/station/v1/station/station-list',
      {
        pageNo,
        pageSize,
        sortBy: 'stationName',
        sortOrder: 'asc',
      }
    );

    // The response structure may vary, try to extract data
    const data = response.data;
    if (data.data) {
      return data.data;
    }
    if (Array.isArray(data)) {
      return data;
    }

    logger.warn('Unexpected station list response structure:', data);
    return [];
  }

  /**
   * Get total real-time KPIs across all stations
   */
  async getTotalRealTimeKpi(): Promise<StationRealTimeKpi> {
    const queryTime = Date.now();

    const response = await this.client.get(
      '/rest/pvms/web/station/v1/station/total-real-kpi',
      {
        params: {
          queryTime,
          timeZone: config.fusionSolar.timeZone,
          _: queryTime,
        },
      }
    );

    return response.data;
  }

  /**
   * Get station status counts
   */
  async getStationStatusCount(): Promise<{
    total: number;
    normal: number;
    faulty: number;
    disconnected: number;
  }> {
    const response = await this.client.get(
      '/rest/pvms/web/station/v1/station/station-status-count',
      {
        params: { _: Date.now() },
      }
    );

    return response.data;
  }

  /**
   * Get energy balance for a station
   */
  async getEnergyBalance(
    stationDn: string,
    timeDim: TimeDimension = 2,
    date?: Date
  ): Promise<EnergyBalance> {
    const targetDate = date || new Date();
    const queryTime = targetDate.setHours(0, 0, 0, 0);
    const dateStr = this.formatDate(targetDate);

    logger.info(`Fetching energy balance for ${stationDn}...`);

    const response = await this.client.get(
      '/rest/pvms/web/station/v3/overview/energy-balance',
      {
        params: {
          stationDn,
          timeDim,
          timeZone: config.fusionSolar.timeZone,
          timeZoneStr: config.fusionSolar.timeZoneStr,
          queryTime,
          dateStr,
          _: Date.now(),
        },
      }
    );

    return {
      stationDn,
      date: dateStr,
      timeDim,
      ...response.data,
    };
  }

  /**
   * Get device list for a station
   */
  async getDeviceList(stationDn: string, page = 1, pageSize = 100): Promise<Device[]> {
    logger.info(`Fetching device list for ${stationDn}...`);

    const response = await this.client.get(
      '/rest/neteco/web/config/device/v1/device-list',
      {
        params: {
          'conditionParams.checkShareStationDn': stationDn,
          'conditionParams.parentDn': stationDn,
          'conditionParams.curPage': page,
          'conditionParams.recordperpage': pageSize,
          'conditionParams.sortType': 'BY_DEVICE_NAME',
          'conditionParams.maintenance': false,
          _: Date.now(),
        },
      }
    );

    // Extract device list from response
    const data = response.data;
    if (data.data) {
      return data.data;
    }
    if (Array.isArray(data)) {
      return data;
    }

    return [];
  }

  /**
   * Get real-time KPIs for a device
   */
  async getDeviceRealKpi(
    deviceDn: string,
    signalIds: number[]
  ): Promise<Record<number, number>> {
    logger.debug(`Fetching device KPIs for ${deviceDn}...`);

    // Build params with multiple signalIds
    const params = new URLSearchParams();
    params.append('deviceDn', deviceDn);
    signalIds.forEach((id) => params.append('signalIds', id.toString()));
    params.append('_', Date.now().toString());

    const response = await this.client.get('/rest/pvms/web/device/v1/device-real-kpi', {
      params,
    });

    return response.data;
  }

  /**
   * Get real-time data for a device
   */
  async getDeviceRealtimeData(deviceDn: string): Promise<InverterRealtimeData | null> {
    logger.info(`Fetching realtime data for device ${deviceDn}...`);

    try {
      const response = await this.client.get(
        '/rest/pvms/web/device/v1/device-realtime-data',
        {
          params: {
            deviceDn,
            displayAccessModel: true,
            _: Date.now(),
          },
        }
      );

      return this.parseInverterData(deviceDn, response.data);
    } catch (error) {
      logger.warn(`Failed to get realtime data for ${deviceDn}:`, error);
      return null;
    }
  }

  /**
   * Check if device is online
   */
  async isDeviceOnline(deviceDn: string): Promise<boolean> {
    try {
      const response = await this.client.get(
        '/rest/pvms/web/device/v1/deviceExt/is-device-online',
        {
          params: { dn: deviceDn },
        }
      );

      return response.data === true || response.data?.online === true;
    } catch {
      return false;
    }
  }

  /**
   * Get device details
   */
  async getDeviceDetails(deviceDn: string): Promise<Record<string, unknown>> {
    const response = await this.client.get('/rest/pvms/web/device/v1/mo-details', {
      params: {
        dn: deviceDn,
        _: Date.now(),
      },
    });

    return response.data;
  }

  /**
   * Get alarms for a station
   */
  async getAlarms(stationDn: string): Promise<Alarm[]> {
    // This endpoint needs to be discovered - returning empty for now
    logger.debug(`Fetching alarms for ${stationDn}...`);
    return [];
  }

  /**
   * Parse inverter data from API response
   */
  private parseInverterData(
    deviceDn: string,
    data: Record<string, unknown>
  ): InverterRealtimeData {
    return {
      deviceDn,
      deviceName: (data.deviceName as string) || '',
      status: (data.status as string) || 'unknown',
      dailyEnergy: this.parseNumber(data.dailyEnergy),
      totalYield: this.parseNumber(data.totalYield),
      activePower: this.parseNumber(data.activePower),
      reactivePower: this.parseNumber(data.reactivePower),
      ratedPower: this.parseNumber(data.ratedPower),
      powerFactor: this.parseNumber(data.powerFactor),
      gridFrequency: this.parseNumber(data.gridFrequency),
      gridVoltage: this.parseNumber(data.gridVoltage),
      gridCurrent: this.parseNumber(data.gridCurrent),
      internalTemperature: this.parseNumber(data.internalTemperature),
      insulationResistance: this.parseNumber(data.insulationResistance),
      outputMode: (data.outputMode as string) || '',
      startupTime: (data.startupTime as string) || '',
      shutdownTime: (data.shutdownTime as string) || '',
      pvStrings: this.parsePvStrings(data),
    };
  }

  /**
   * Parse PV string data from response
   */
  private parsePvStrings(data: Record<string, unknown>): Array<{
    stringId: string;
    voltage: number;
    current: number;
  }> {
    const strings: Array<{ stringId: string; voltage: number; current: number }> = [];

    // Try to extract PV string data from various possible formats
    for (let i = 1; i <= 24; i++) {
      const voltageKey = `pv${i}Voltage`;
      const currentKey = `pv${i}Current`;

      if (data[voltageKey] !== undefined || data[currentKey] !== undefined) {
        strings.push({
          stringId: `PV${i}`,
          voltage: this.parseNumber(data[voltageKey]),
          current: this.parseNumber(data[currentKey]),
        });
      }
    }

    return strings;
  }

  /**
   * Safely parse a number from unknown value
   */
  private parseNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Format date for API requests
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day} 00:00:00`;
  }

  /**
   * Add delay between requests to avoid rate limiting
   */
  async delay(ms?: number): Promise<void> {
    const delayMs = ms || config.crawler.requestDelayMs;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export default FusionSolarApiClient;
