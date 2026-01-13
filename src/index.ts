import { CronJob } from 'cron';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { FusionSolarCrawler } from './services/crawler.js';
import { NexSolarHubClient } from './services/nexsolarhub-client.js';

async function main() {
  logger.info('='.repeat(60));
  logger.info('NexSolarHub FusionSolar Crawler');
  logger.info('='.repeat(60));
  logger.info(`Interval: Every ${config.crawler.intervalMinutes} minutes`);
  logger.info(`Headless: ${config.crawler.headless}`);
  logger.info('');

  const crawler = new FusionSolarCrawler();
  const nexSolarHub = new NexSolarHubClient();

  // Initialize crawler (login to FusionSolar)
  try {
    await crawler.initialize();
  } catch (error) {
    logger.error('Failed to initialize crawler:', error);
    process.exit(1);
  }

  // Check NexSolarHub connection
  const hubHealthy = await nexSolarHub.healthCheck();
  if (!hubHealthy) {
    logger.warn('NexSolarHub API is not responding - data will not be pushed');
  } else {
    logger.info('NexSolarHub API connection verified');
  }

  // Function to run a crawl cycle
  const runCrawl = async () => {
    logger.info('-'.repeat(40));
    logger.info('Starting scheduled crawl...');

    try {
      const result = await crawler.crawl();

      if (result.success && result.stations.length > 0) {
        // Push to NexSolarHub
        try {
          await nexSolarHub.pushCrawlResult(result);
        } catch (pushError) {
          logger.error('Failed to push data to NexSolarHub:', pushError);
        }
      }

      logger.info(
        `Crawl completed: ${result.stations.length} stations, ` +
          `${result.errors.length} errors, ${result.duration}ms`
      );
    } catch (error) {
      logger.error('Crawl failed:', error);
    }
  };

  // Run initial crawl immediately
  await runCrawl();

  // Schedule recurring crawls
  const cronExpression = `*/${config.crawler.intervalMinutes} * * * *`;
  logger.info(`Scheduling crawls with cron: ${cronExpression}`);

  const job = new CronJob(
    cronExpression,
    runCrawl,
    null,
    true,
    config.fusionSolar.timeZoneStr
  );

  job.start();

  logger.info('Crawler is running. Press Ctrl+C to stop.');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    job.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    job.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
