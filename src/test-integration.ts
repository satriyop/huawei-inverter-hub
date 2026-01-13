/**
 * Integration test: Login via browser, extract data, push to Laravel
 * Run with: npx tsx src/test-integration.ts
 */

import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { FusionSolarAuthenticator } from './services/authenticator.js';
import { NexSolarHubClient } from './services/nexsolarhub-client.js';

interface BrowserStation {
  stationName: string;
  stationDn: string;
  currentPower: string | null;
  yieldToday: string | null;
}

async function testIntegration() {
  logger.info('='.repeat(60));
  logger.info('Integration Test: FusionSolar -> Laravel');
  logger.info('='.repeat(60));
  logger.info('');
  logger.info(`FusionSolar URL: ${config.fusionSolar.loginUrl}`);
  logger.info(`NexSolarHub API: ${config.nexSolarHub.apiUrl}`);
  logger.info('');

  const authenticator = new FusionSolarAuthenticator();
  const nexSolarHub = new NexSolarHubClient();

  try {
    // Step 1: Check NexSolarHub API health
    logger.info('Step 1: Checking NexSolarHub API health...');
    const isHealthy = await nexSolarHub.healthCheck();
    if (!isHealthy) {
      throw new Error('NexSolarHub API is not available. Is Laravel server running?');
    }
    logger.info('  ✓ NexSolarHub API is healthy');

    // Step 2: Login to FusionSolar and fetch stations via browser
    logger.info('');
    logger.info('Step 2: Logging in to FusionSolar and fetching stations...');
    const { session, stations } = await authenticator.loginAndFetchStations();

    logger.info(`  ✓ Login successful (${session.cookies.length} cookies)`);
    logger.info(`  ✓ Found ${stations.length} stations`);

    if (stations.length === 0) {
      logger.warn('No stations found - nothing to push');
      return;
    }

    // Step 3: Push station data to Laravel
    logger.info('');
    logger.info('Step 3: Pushing station data to NexSolarHub...');

    for (const station of stations as BrowserStation[]) {
      logger.info(`  Pushing: ${station.stationName} (${station.stationDn})`);

      // Create simplified CrawlResult for this station
      const stationData = {
        external_id: station.stationDn,
        name: station.stationName,
        status: 'normal' as const,
      };

      // Push station using direct API call
      const response = await pushStationDirect(nexSolarHub, stationData);
      logger.info(`    → Station stored with ID: ${response.id}`);

      // Push reading if we have power data
      if (station.currentPower || station.yieldToday) {
        const readingData = {
          station_external_id: station.stationDn,
          recorded_at: new Date().toISOString(),
          current_power_kw: station.currentPower ? parseFloat(station.currentPower) : null,
          yield_today_kwh: station.yieldToday ? parseFloat(station.yieldToday) : null,
        };

        const readingResponse = await pushReadingDirect(nexSolarHub, readingData);
        logger.info(`    → Reading stored with ID: ${readingResponse.id}`);
      }
    }

    // Step 4: Push crawl summary
    logger.info('');
    logger.info('Step 4: Pushing crawl summary...');

    const summaryData = {
      crawled_at: new Date().toISOString(),
      duration_ms: 0, // We didn't time it
      stations_count: stations.length,
      success: true,
      errors_count: 0,
    };

    const summaryResponse = await pushCrawlSummaryDirect(nexSolarHub, summaryData);
    logger.info(`  ✓ Crawl summary stored with ID: ${summaryResponse.id}`);

    // Success
    logger.info('');
    logger.info('='.repeat(60));
    logger.info('INTEGRATION TEST SUCCESSFUL!');
    logger.info('='.repeat(60));
    logger.info('');
    logger.info('Data has been pushed to Laravel. Check your database:');
    logger.info('  - stations table');
    logger.info('  - station_readings table');
    logger.info('  - crawl_logs table');

  } catch (error) {
    logger.error('');
    logger.error('='.repeat(60));
    logger.error('INTEGRATION TEST FAILED!');
    logger.error('='.repeat(60));
    logger.error('Error:', error);
    process.exit(1);
  }
}

// Helper functions to push data directly via axios
// (The NexSolarHubClient.pushCrawlResult expects full CrawlResult structure)

import axios from 'axios';

const apiClient = axios.create({
  baseURL: config.nexSolarHub.apiUrl,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-API-Key': config.nexSolarHub.apiKey,
  },
});

async function pushStationDirect(_client: NexSolarHubClient, data: {
  external_id: string;
  name: string;
  status: string;
}): Promise<{ id: number }> {
  const response = await apiClient.post('/ingestion/stations', data);
  return response.data.data;
}

async function pushReadingDirect(_client: NexSolarHubClient, data: {
  station_external_id: string;
  recorded_at: string;
  current_power_kw: number | null;
  yield_today_kwh: number | null;
}): Promise<{ id: number }> {
  const response = await apiClient.post('/ingestion/readings', data);
  return response.data.data;
}

async function pushCrawlSummaryDirect(_client: NexSolarHubClient, data: {
  crawled_at: string;
  duration_ms: number;
  stations_count: number;
  success: boolean;
  errors_count: number;
}): Promise<{ id: number }> {
  const response = await apiClient.post('/ingestion/crawl-summary', data);
  return response.data.data;
}

testIntegration();
