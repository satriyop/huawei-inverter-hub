import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dotenv so it doesn't load from .env file during tests
vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
}));

// Config module executes on import (top-level dotenv.config() + export const config),
// so we must manipulate process.env before each dynamic import.

describe('Config helper functions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    // Start with a clean env (no .env file leaking in)
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('requireEnv', () => {
    it('throws on missing required env var', async () => {
      // No required vars set at all
      await expect(import('../../config/index.js')).rejects.toThrow(
        'Missing required environment variable'
      );
    });

    it('returns value when env var is set', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'testuser';
      process.env.FUSIONSOLAR_PASSWORD = 'testpass';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'key123';

      const { config } = await import('../../config/index.js');
      expect(config.fusionSolar.username).toBe('testuser');
      expect(config.fusionSolar.password).toBe('testpass');
    });
  });

  describe('optionalEnv', () => {
    it('returns default when env var is not set', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';

      const { config } = await import('../../config/index.js');
      expect(config.logging.level).toBe('info');
    });

    it('returns env value when set', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';
      process.env.LOG_LEVEL = 'debug';

      const { config } = await import('../../config/index.js');
      expect(config.logging.level).toBe('debug');
    });
  });

  describe('optionalEnvNumber', () => {
    it('returns default when env var is not set', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';

      const { config } = await import('../../config/index.js');
      expect(config.crawler.intervalMinutes).toBe(5);
    });

    it('parses number from env string', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';
      process.env.CRAWLER_INTERVAL_MINUTES = '15';

      const { config } = await import('../../config/index.js');
      expect(config.crawler.intervalMinutes).toBe(15);
    });
  });

  describe('optionalEnvBoolean', () => {
    it('returns default when env var is not set', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';

      const { config } = await import('../../config/index.js');
      expect(config.crawler.headless).toBe(true);
    });

    it('parses "true" as true', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';
      process.env.PUSH_TO_LARAVEL = 'true';

      const { config } = await import('../../config/index.js');
      expect(config.nexSolarHub.pushEnabled).toBe(true);
    });

    it('parses "false" as false', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';
      process.env.PUSH_TO_LARAVEL = 'false';

      const { config } = await import('../../config/index.js');
      expect(config.nexSolarHub.pushEnabled).toBe(false);
    });

    it('is case-insensitive for "TRUE"', async () => {
      process.env.FUSIONSOLAR_USERNAME = 'u';
      process.env.FUSIONSOLAR_PASSWORD = 'p';
      process.env.NEXSOLARHUB_API_URL = 'http://localhost';
      process.env.NEXSOLARHUB_API_KEY = 'k';
      process.env.PUSH_TO_LARAVEL = 'TRUE';

      const { config } = await import('../../config/index.js');
      expect(config.nexSolarHub.pushEnabled).toBe(true);
    });
  });
});
