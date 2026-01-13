/**
 * Continuous FusionSolar Crawler with Cron Scheduler
 *
 * Uses BrowserCrawler (Puppeteer-based) for reliable session management.
 * Runs crawl cycles at configured intervals and pushes data to NexSolarHub.
 */

import { CronJob } from 'cron';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { BrowserCrawler } from './services/browser-crawler.js';
import { NexSolarHubClient } from './services/nexsolarhub-client.js';
import { JsonOutput } from './services/json-output.js';

async function main() {
  logger.info('='.repeat(60));
  logger.info('NexSolarHub FusionSolar Crawler (Continuous Mode)');
  logger.info('='.repeat(60));
  logger.info(`Interval: Every ${config.crawler.intervalMinutes} minutes`);
  logger.info(`Headless: ${config.crawler.headless}`);
  logger.info(`Push to Laravel: ${config.nexSolarHub.pushEnabled}`);
  logger.info('');

  const crawler = new BrowserCrawler();
  const nexSolarHub = new NexSolarHubClient();
  const jsonOutput = new JsonOutput();

  // Initialize output directories
  await jsonOutput.init();

  // Start browser and login
  logger.info('Starting browser...');
  await crawler.start();

  logger.info('Logging in to FusionSolar...');
  await crawler.login();

  // Check NexSolarHub connection if push is enabled
  if (config.nexSolarHub.pushEnabled) {
    const hubHealthy = await nexSolarHub.healthCheck();
    if (!hubHealthy) {
      logger.warn('NexSolarHub API is not responding - data will not be pushed');
    } else {
      logger.info('NexSolarHub API connection verified');
    }
  }

  // Track crawl count for logging
  let crawlCount = 0;

  // Function to run a crawl cycle
  const runCrawl = async () => {
    crawlCount++;
    logger.info('');
    logger.info('-'.repeat(40));
    logger.info(`Starting crawl #${crawlCount}...`);

    try {
      // Run crawl (BrowserCrawler handles session validation internally)
      const result = await crawler.crawl();

      // Save to JSON
      await jsonOutput.saveCrawlResult(result);

      // Save individual station files
      for (const station of result.stations) {
        await jsonOutput.saveStation(station);
      }

      // Push to NexSolarHub if enabled
      if (config.nexSolarHub.pushEnabled && result.success && result.stations.length > 0) {
        try {
          const pushResult = await nexSolarHub.pushCrawlResult(result);
          if (pushResult.success) {
            logger.info(
              `Pushed to NexSolarHub: ${pushResult.stationsPushed} stations, ` +
                `${pushResult.devicesPushed} devices, ${pushResult.readingsPushed} readings`
            );
          } else {
            logger.warn(`Push completed with errors: ${pushResult.errors.join(', ')}`);
          }
        } catch (pushError) {
          logger.error('Failed to push data to NexSolarHub:', pushError);
        }
      }

      // Log summary
      const duration = (result.duration / 1000).toFixed(1);
      logger.info(
        `Crawl #${crawlCount} completed: ${result.stations.length} stations, ` +
          `${result.errors.length} errors, ${duration}s`
      );

      // Log station details
      for (const s of result.stations) {
        logger.info(
          `  ${s.station.stationName}: ${s.realtimeKpi.currentPower}kW, ` +
            `${s.devices.length} devices`
        );
      }
    } catch (error) {
      logger.error(`Crawl #${crawlCount} failed:`, error);
    }
  };

  // Run initial crawl immediately
  await runCrawl();

  // Schedule recurring crawls
  const cronExpression = `*/${config.crawler.intervalMinutes} * * * *`;
  logger.info('');
  logger.info(`Scheduling crawls with cron: ${cronExpression}`);
  logger.info(`Next crawl in ${config.crawler.intervalMinutes} minutes`);

  const job = new CronJob(
    cronExpression,
    runCrawl,
    null,
    true,
    config.fusionSolar.timeZoneStr
  );

  job.start();

  logger.info('');
  logger.info('Crawler is running. Press Ctrl+C to stop.');
  logger.info('');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info('');
    logger.info(`Received ${signal}, shutting down...`);
    job.stop();
    await crawler.close();
    logger.info('Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
