import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  fusionSolar: {
    baseUrl: string;
    loginUrl: string;
    username: string;
    password: string;
    timeZone: number;
    timeZoneStr: string;
  };
  crawler: {
    intervalMinutes: number;
    retryAttempts: number;
    retryDelayMs: number;
    requestDelayMs: number;
    headless: boolean;
  };
  nexSolarHub: {
    apiUrl: string;
    apiKey: string;
  };
  logging: {
    level: string;
    file: string;
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function optionalEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

function optionalEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

export const config: Config = {
  fusionSolar: {
    baseUrl: optionalEnv('FUSIONSOLAR_BASE_URL', 'https://sg5.fusionsolar.huawei.com'),
    loginUrl: optionalEnv(
      'FUSIONSOLAR_LOGIN_URL',
      'https://sg5.fusionsolar.huawei.com/pvmswebsite/login/build/index.html'
    ),
    username: requireEnv('FUSIONSOLAR_USERNAME'),
    password: requireEnv('FUSIONSOLAR_PASSWORD'),
    timeZone: optionalEnvNumber('FUSIONSOLAR_TIMEZONE', 7),
    timeZoneStr: optionalEnv('FUSIONSOLAR_TIMEZONE_STR', 'Asia/Jakarta'),
  },
  crawler: {
    intervalMinutes: optionalEnvNumber('CRAWLER_INTERVAL_MINUTES', 5),
    retryAttempts: optionalEnvNumber('CRAWLER_RETRY_ATTEMPTS', 3),
    retryDelayMs: optionalEnvNumber('CRAWLER_RETRY_DELAY_MS', 30000),
    requestDelayMs: optionalEnvNumber('CRAWLER_REQUEST_DELAY_MS', 1000),
    headless: optionalEnvBoolean('CRAWLER_HEADLESS', true),
  },
  nexSolarHub: {
    apiUrl: requireEnv('NEXSOLARHUB_API_URL'),
    apiKey: requireEnv('NEXSOLARHUB_API_KEY'),
  },
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    file: optionalEnv('LOG_FILE', 'logs/crawler.log'),
  },
};

export default config;
