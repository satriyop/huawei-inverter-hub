/**
 * JSON Output Service - Save crawl results to JSON files for inspection
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';
import type { CrawlResult, StationCrawlResult } from '../types/fusionsolar.js';

export class JsonOutput {
  private outputDir: string;
  private stationsDir: string;

  constructor(baseDir = 'logs') {
    this.outputDir = baseDir;
    this.stationsDir = path.join(baseDir, 'stations');
  }

  /**
   * Initialize output directories
   */
  async init(): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
    await fs.mkdir(this.stationsDir, { recursive: true });
    await fs.mkdir(path.join(this.outputDir, 'screenshots'), { recursive: true });
    logger.info(`Output directories initialized: ${this.outputDir}`);
  }

  /**
   * Save complete crawl result
   */
  async saveCrawlResult(result: CrawlResult): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `crawl-${timestamp}.json`;
    const filepath = path.join(this.outputDir, filename);

    // Create simplified output for readability
    const output = {
      crawledAt: result.timestamp.toISOString(),
      duration: result.duration,
      durationFormatted: `${(result.duration / 1000).toFixed(1)}s`,
      success: result.success,
      stationsCount: result.stations.length,
      errorsCount: result.errors.length,
      stations: result.stations.map((s) => this.formatStation(s)),
      errors: result.errors.map((e) => ({
        stationDn: e.stationDn,
        deviceDn: e.deviceDn,
        endpoint: e.endpoint,
        message: e.message,
        timestamp: e.timestamp.toISOString(),
      })),
    };

    await fs.writeFile(filepath, JSON.stringify(output, null, 2));
    logger.info(`Crawl result saved: ${filepath}`);

    // Also save as latest
    const latestPath = path.join(this.outputDir, 'crawl-latest.json');
    await fs.writeFile(latestPath, JSON.stringify(output, null, 2));

    return filepath;
  }

  /**
   * Save individual station data
   */
  async saveStation(station: StationCrawlResult): Promise<string> {
    const safeId = station.station.stationDn.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${safeId}.json`;
    const filepath = path.join(this.stationsDir, filename);

    const output = this.formatStation(station);
    await fs.writeFile(filepath, JSON.stringify(output, null, 2));

    return filepath;
  }

  /**
   * Format station data for JSON output
   */
  private formatStation(s: StationCrawlResult): Record<string, unknown> {
    return {
      // Basic info
      stationDn: s.station.stationDn,
      stationName: s.station.stationName,
      address: s.station.address,
      country: s.station.country,
      capacity: s.station.capacity,
      status: s.station.status,
      gridConnectionDate: s.station.gridConnectionDate,

      // Real-time KPIs
      realtime: {
        currentPower: s.realtimeKpi.currentPower,
        currentPowerUnit: 'kW',
        yieldToday: s.realtimeKpi.yieldToday,
        yieldTodayUnit: 'kWh',
        totalYield: s.realtimeKpi.totalYield,
        totalYieldUnit: 'kWh',
      },

      // Energy balance
      energyBalance: {
        generatedByPV: s.energyBalance.generatedByPV,
        consumedFromPV: s.energyBalance.consumedFromPV,
        fedToGrid: s.energyBalance.fedToGrid,
        consumedByAppliances: s.energyBalance.consumedByAppliances,
        fromGrid: s.energyBalance.fromGrid,
        unit: 'kWh',
      },

      // Environmental
      environmental: {
        standardCoalSaved: s.environmental.standardCoalSaved,
        standardCoalSavedUnit: 'tons',
        co2Avoided: s.environmental.co2Avoided,
        co2AvoidedUnit: 'tons',
        treesPlanted: s.environmental.equivalentTreesPlanted,
      },

      // Devices
      devicesCount: s.devices.length,
      devices: s.devices.map((d) => ({
        deviceDn: d.device.deviceDn,
        deviceName: d.device.deviceName,
        deviceType: d.device.deviceType,
        status: d.device.status,
        realtimeData: d.realtimeData
          ? {
              activePower: d.realtimeData.activePower,
              activePowerUnit: 'kW',
              dailyEnergy: d.realtimeData.dailyEnergy,
              dailyEnergyUnit: 'kWh',
              totalYield: d.realtimeData.totalYield,
              totalYieldUnit: 'kWh',
            }
          : null,
      })),

      // Alarms
      alarmsCount: s.alarms.length,
      alarms: s.alarms.map((a) => ({
        alarmId: a.alarmId,
        alarmName: a.alarmName,
        severity: a.severity,
        status: a.status,
        startTime: a.startTime,
      })),
    };
  }

  /**
   * Get the latest crawl result
   */
  async getLatest(): Promise<Record<string, unknown> | null> {
    try {
      const latestPath = path.join(this.outputDir, 'crawl-latest.json');
      const content = await fs.readFile(latestPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * List all crawl files
   */
  async listCrawls(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.outputDir);
      return files
        .filter((f) => f.startsWith('crawl-') && f.endsWith('.json') && f !== 'crawl-latest.json')
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}

export default JsonOutput;
