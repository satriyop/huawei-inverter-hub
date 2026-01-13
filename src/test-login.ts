/**
 * Test script for FusionSolar login
 * Run with: npm run test:login
 */

import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { FusionSolarAuthenticator } from './services/authenticator.js';

async function testLogin() {
  logger.info('='.repeat(60));
  logger.info('FusionSolar Login Test');
  logger.info('='.repeat(60));
  logger.info(`Login URL: ${config.fusionSolar.loginUrl}`);
  logger.info(`Username: ${config.fusionSolar.username}`);
  logger.info(`Headless: ${config.crawler.headless}`);
  logger.info('');

  const authenticator = new FusionSolarAuthenticator();

  try {
    // Step 1: Login and fetch stations using browser-based API calls
    logger.info('Step 1: Logging in and fetching stations from browser...');
    const { session, stations: browserStations } = await authenticator.loginAndFetchStations();

    logger.info(`Login successful! Got ${session.cookies.length} cookies`);
    logger.info('Cookies:');
    session.cookies.forEach((cookie) => {
      logger.info(`  - ${cookie.name}: ${cookie.value.substring(0, 20)}...`);
    });
    if (session.zoneId) {
      logger.info(`Zone ID: ${session.zoneId}`);
    }

    logger.info('');
    logger.info(`Browser fetch found ${browserStations.length} stations:`);
    browserStations.forEach((station: unknown) => {
      const s = station as { stationName?: string; stationDn?: string };
      logger.info(`  - ${s.stationName || 'Unknown'} (${s.stationDn || 'Unknown'})`);
    });

    // Step 2: Log browser-extracted station data with details
    logger.info('');
    logger.info('Step 2: Station Data Summary (from browser):');
    browserStations.forEach((station: unknown) => {
      const s = station as {
        stationName: string;
        stationDn: string;
        currentPower: string | null;
        yieldToday: string | null;
      };
      logger.info(`  Station: ${s.stationName} (${s.stationDn})`);
      if (s.currentPower !== null || s.yieldToday !== null) {
        logger.info(`    - Current Power: ${s.currentPower || 'N/A'}`);
        logger.info(`    - Yield Today: ${s.yieldToday || 'N/A'}`);
      }
    });

    // Note: External axios API calls don't work due to FusionSolar's session isolation
    // All data must be fetched via browser session (page.evaluate with fetch)

    logger.info('');
    logger.info('='.repeat(60));
    logger.info('LOGIN TEST SUCCESSFUL!');
    logger.info('='.repeat(60));
  } catch (error) {
    logger.error('');
    logger.error('='.repeat(60));
    logger.error('LOGIN TEST FAILED!');
    logger.error('='.repeat(60));
    logger.error('Error:', error);
    process.exit(1);
  }
}

testLogin();
