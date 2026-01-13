/**
 * Push crawl results to Laravel NexSolarHub API
 *
 * Usage:
 *   npm run push:laravel                     # Push latest crawl
 *   npm run push:laravel -- --file <path>    # Push specific file
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { NexSolarHubClient } from './services/nexsolarhub-client.js';
import type {
  CrawlResult,
  CrawlError,
  StationCrawlResult,
  DeviceType,
} from './types/fusionsolar.js';

// Parse command line arguments
function parseArgs(): { filePath: string } {
  const args = process.argv.slice(2);
  let filePath = 'logs/crawl-latest.json';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      filePath = args[i + 1];
      i++;
    }
  }

  return { filePath };
}

// Convert JSON data back to CrawlResult structure
function jsonToCrawlResult(data: Record<string, unknown>): CrawlResult {
  const crawledAt = new Date(data.crawledAt as string);

  // Convert stations
  const stations: StationCrawlResult[] = ((data.stations as unknown[]) || []).map(
    (s: unknown) => {
      const station = s as Record<string, unknown>;
      const realtime = station.realtime as Record<string, unknown>;
      const energyBalance = station.energyBalance as Record<string, unknown>;
      const environmental = station.environmental as Record<string, unknown>;
      const devices = (station.devices as unknown[]) || [];
      const alarms = (station.alarms as unknown[]) || [];

      return {
        station: {
          stationDn: station.stationDn as string,
          stationCode: station.stationDn as string,
          stationName: station.stationName as string,
          address: (station.address as string) || '',
          country: (station.country as string) || 'Indonesia',
          gridConnectionDate: (station.gridConnectionDate as string) || '',
          capacity: (station.capacity as number) || 0,
          ratedPower: (station.capacity as number) || 0,
          timeZone: 7,
          timeZoneStr: 'Asia/Jakarta',
          status: (station.status as 'normal' | 'faulty' | 'disconnected') || 'normal',
        },
        realtimeKpi: {
          stationDn: station.stationDn as string,
          currentPower: (realtime?.currentPower as number) || 0,
          yieldToday: (realtime?.yieldToday as number) || 0,
          totalYield: (realtime?.totalYield as number) || 0,
          revenueToday: 0,
          ratedPower: (station.capacity as number) || 0,
          ratedESSCapacity: 0,
        },
        energyBalance: {
          stationDn: station.stationDn as string,
          date: crawledAt.toISOString().split('T')[0],
          timeDim: 2,
          generatedByPV: (energyBalance?.generatedByPV as number) || 0,
          consumedFromPV: (energyBalance?.consumedFromPV as number) || 0,
          fedToGrid: (energyBalance?.fedToGrid as number) || 0,
          consumedByAppliances: (energyBalance?.consumedByAppliances as number) || 0,
          fromPV: (energyBalance?.generatedByPV as number) || 0,
          fromGrid: (energyBalance?.fromGrid as number) || 0,
        },
        devices: devices.map((d: unknown) => {
          const device = d as Record<string, unknown>;
          const realtimeData = device.realtimeData as Record<string, unknown>;

          return {
            device: {
              deviceDn: device.deviceDn as string,
              deviceName: device.deviceName as string,
              deviceType: ((device.deviceType as string) || 'Inverter') as DeviceType,
              deviceModel: (device.model as string) || '',
              softwareVersion: (device.softwareVersion as string) || '',
              stationDn: station.stationDn as string,
              status: (device.status as 'online' | 'offline' | 'standby' | 'fault') || 'offline',
            },
            realtimeData: realtimeData
              ? {
                  deviceDn: device.deviceDn as string,
                  deviceName: device.deviceName as string,
                  status: (realtimeData.status as string) || 'unknown',
                  dailyEnergy: (realtimeData.dailyEnergy as number) || 0,
                  totalYield: (realtimeData.totalYield as number) || 0,
                  activePower: (realtimeData.activePower as number) || 0,
                  reactivePower: 0,
                  ratedPower: 0,
                  powerFactor: (realtimeData.powerFactor as number) || 0,
                  gridFrequency: (realtimeData.gridFrequency as number) || 0,
                  gridVoltage: (realtimeData.gridVoltage as number) || 0,
                  gridCurrent: (realtimeData.gridCurrent as number) || 0,
                  internalTemperature: (realtimeData.temperature as number) || 0,
                  insulationResistance: 0,
                  outputMode: '',
                  startupTime: '',
                  shutdownTime: '',
                  pvStrings: [],
                  efficiency: realtimeData.efficiency as number | undefined,
                  inputPower: realtimeData.inputPower as number | undefined,
                }
              : null,
          };
        }),
        alarms: alarms.map((a: unknown) => {
          const alarm = a as Record<string, unknown>;
          return {
            alarmId: alarm.alarmId as string,
            deviceDn: (alarm.deviceDn as string) || '',
            stationDn: station.stationDn as string,
            alarmName: alarm.alarmName as string,
            alarmCode: (alarm.alarmCode as string) || '',
            severity: (alarm.severity as 'critical' | 'major' | 'minor' | 'warning') || 'warning',
            startTime: alarm.startTime as string,
            endTime: alarm.endTime as string | undefined,
            status: (alarm.status as 'active' | 'cleared') || 'active',
          };
        }),
        environmental: {
          standardCoalSaved: (environmental?.standardCoalSaved as number) || 0,
          co2Avoided: (environmental?.co2Avoided as number) || 0,
          equivalentTreesPlanted: (environmental?.treesPlanted as number) || 0,
        },
      };
    }
  );

  // Convert errors
  const errors: CrawlError[] = ((data.errors as unknown[]) || []).map((e: unknown) => {
    const error = e as Record<string, unknown>;
    return {
      stationDn: error.stationDn as string | undefined,
      deviceDn: error.deviceDn as string | undefined,
      endpoint: error.endpoint as string,
      message: error.message as string,
      timestamp: new Date(error.timestamp as string),
    };
  });

  return {
    timestamp: crawledAt,
    stations,
    success: (data.success as boolean) ?? true,
    errors,
    duration: (data.duration as number) || 0,
  };
}

async function pushToLaravel() {
  const { filePath } = parseArgs();

  logger.info('============================================================');
  logger.info('Push Crawl Results to Laravel');
  logger.info('============================================================');
  logger.info('');
  logger.info(`API URL: ${config.nexSolarHub.apiUrl}`);
  logger.info(`File: ${filePath}`);
  logger.info('');

  // Check if file exists
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  try {
    await fs.access(absolutePath);
  } catch {
    logger.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }

  // Read and parse the JSON file
  logger.info('Step 1: Reading crawl data...');
  const content = await fs.readFile(absolutePath, 'utf-8');
  const jsonData = JSON.parse(content) as Record<string, unknown>;

  logger.info(`  Crawled at: ${jsonData.crawledAt}`);
  logger.info(`  Stations: ${jsonData.stationsCount}`);
  logger.info(`  Success: ${jsonData.success}`);
  logger.info('');

  // Convert to CrawlResult
  const crawlResult = jsonToCrawlResult(jsonData);

  // Create client and check health
  const client = new NexSolarHubClient();

  logger.info('Step 2: Checking API health...');
  const isHealthy = await client.healthCheck();
  if (!isHealthy) {
    logger.error('API health check failed. Is the Laravel server running?');
    process.exit(1);
  }
  logger.info('  ✓ API is healthy');
  logger.info('');

  // Push data
  logger.info('Step 3: Pushing data to Laravel...');
  const result = await client.pushCrawlResult(crawlResult);

  // Summary
  logger.info('');
  logger.info('============================================================');
  logger.info('PUSH COMPLETE');
  logger.info('============================================================');
  logger.info('');
  logger.info('Summary:');
  logger.info(`  - Success: ${result.success}`);
  logger.info(`  - Stations pushed: ${result.stationsPushed}`);
  logger.info(`  - Readings pushed: ${result.readingsPushed}`);
  logger.info(`  - Devices pushed: ${result.devicesPushed}`);
  logger.info(`  - Alarms pushed: ${result.alarmsPushed}`);

  if (result.errors.length > 0) {
    logger.info('');
    logger.warn('Errors:');
    result.errors.forEach((e) => logger.warn(`  - ${e}`));
  }

  logger.info('');

  process.exit(result.success ? 0 : 1);
}

// Run
pushToLaravel().catch((error) => {
  logger.error('Push failed:', error);
  process.exit(1);
});
