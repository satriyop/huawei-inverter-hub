/**
 * Run a single crawl cycle
 * Run with: npm run crawl:once
 */

import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { FusionSolarCrawler } from './services/crawler.js';
import { NexSolarHubClient } from './services/nexsolarhub-client.js';

async function crawlOnce() {
  logger.info('='.repeat(60));
  logger.info('NexSolarHub FusionSolar Crawler - Single Run');
  logger.info('='.repeat(60));
  logger.info('');

  const crawler = new FusionSolarCrawler();
  const nexSolarHub = new NexSolarHubClient();

  try {
    // Initialize
    logger.info('Initializing crawler...');
    await crawler.initialize();

    // Run crawl
    logger.info('Running crawl...');
    const result = await crawler.crawl();

    // Log results
    logger.info('');
    logger.info('Crawl Results:');
    logger.info(`  - Timestamp: ${result.timestamp.toISOString()}`);
    logger.info(`  - Duration: ${result.duration}ms`);
    logger.info(`  - Stations: ${result.stations.length}`);
    logger.info(`  - Success: ${result.success}`);
    logger.info(`  - Errors: ${result.errors.length}`);

    // Log station details
    for (const stationResult of result.stations) {
      logger.info('');
      logger.info(`Station: ${stationResult.station.stationName}`);
      logger.info(`  - Current Power: ${stationResult.realtimeKpi.currentPower} kW`);
      logger.info(`  - Yield Today: ${stationResult.realtimeKpi.yieldToday} kWh`);
      logger.info(`  - Devices: ${stationResult.devices.length}`);
      logger.info(`  - Alarms: ${stationResult.alarms.length}`);
    }

    // Push to NexSolarHub if configured
    if (result.success && result.stations.length > 0) {
      logger.info('');
      logger.info('Pushing data to NexSolarHub...');

      const hubHealthy = await nexSolarHub.healthCheck();
      if (hubHealthy) {
        await nexSolarHub.pushCrawlResult(result);
        logger.info('Data pushed successfully');
      } else {
        logger.warn('NexSolarHub API is not available - skipping push');
      }
    }

    // Log errors if any
    if (result.errors.length > 0) {
      logger.info('');
      logger.warn('Errors:');
      for (const error of result.errors) {
        logger.warn(`  - ${error.endpoint}: ${error.message}`);
      }
    }

    logger.info('');
    logger.info('='.repeat(60));
    logger.info('Crawl completed!');
    logger.info('='.repeat(60));
  } catch (error) {
    logger.error('Crawl failed:', error);
    process.exit(1);
  }
}

crawlOnce();
