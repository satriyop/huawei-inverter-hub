import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { makeCrawlResult, makeStationCrawlResult, makeAlarm } from '../../__tests__/fixtures.js';

// Mock config before importing the client
vi.mock('../../config/index.js', () => ({
  config: {
    nexSolarHub: {
      apiUrl: 'http://localhost:3000/api',
      apiKey: 'test-api-key',
      pushEnabled: true,
    },
  },
}));

vi.mock('axios', () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
      __mockInstance: mockAxiosInstance,
    },
  };
});

// Access the mock instance
function getMockClient(): AxiosInstance {
  return (axios as unknown as { __mockInstance: AxiosInstance }).__mockInstance;
}

// Need to import after mocks are set up
import { NexSolarHubClient } from '../../services/nexsolarhub-client.js';

describe('NexSolarHubClient', () => {
  let client: NexSolarHubClient;
  let mockAxios: AxiosInstance;

  beforeEach(() => {
    client = new NexSolarHubClient();
    mockAxios = getMockClient();
  });

  describe('constructor', () => {
    it('creates axios instance with correct config', () => {
      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://localhost:3000/api',
          timeout: 30000,
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-API-Key': 'test-api-key',
          }),
        })
      );
    });
  });

  describe('healthCheck', () => {
    it('returns true on 200', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({ status: 200, data: {} });

      const result = await client.healthCheck();
      expect(result).toBe(true);
      expect(mockAxios.get).toHaveBeenCalledWith('/health');
    });

    it('returns false on error', async () => {
      vi.mocked(mockAxios.get).mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe('pushCrawlResult', () => {
    it('returns early with empty stations', async () => {
      const result = makeCrawlResult({ stations: [] });

      const pushResult = await client.pushCrawlResult(result);

      expect(pushResult.success).toBe(true);
      expect(pushResult.stationsPushed).toBe(0);
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    it('pushes station, readings, devices, alarms, and summary', async () => {
      const alarm = makeAlarm();
      const stationResult = makeStationCrawlResult({ alarms: [alarm] });
      const result = makeCrawlResult({ stations: [stationResult] });

      vi.mocked(mockAxios.post).mockResolvedValue({ status: 200, data: {} });

      const pushResult = await client.pushCrawlResult(result);

      expect(pushResult.success).toBe(true);
      expect(pushResult.stationsPushed).toBe(1);
      expect(pushResult.readingsPushed).toBe(1);
      expect(pushResult.devicesPushed).toBe(1);
      expect(pushResult.alarmsPushed).toBe(1);

      // Verify the endpoints called: station, reading, device, alarm, summary
      const postCalls = vi.mocked(mockAxios.post).mock.calls;
      const endpoints = postCalls.map((call) => call[0]);
      expect(endpoints).toContain('/ingestion/stations');
      expect(endpoints).toContain('/ingestion/readings');
      expect(endpoints).toContain('/ingestion/devices');
      expect(endpoints).toContain('/ingestion/alarms');
      expect(endpoints).toContain('/ingestion/crawl-summary');
    });

    it('handles partial failures and collects errors', async () => {
      const stationResult = makeStationCrawlResult();
      const result = makeCrawlResult({ stations: [stationResult] });

      // First call (station push) fails
      vi.mocked(mockAxios.post).mockRejectedValueOnce(
        Object.assign(new Error('Server error'), {
          response: { status: 400 },
          config: {},
        })
      );

      const pushResult = await client.pushCrawlResult(result);

      expect(pushResult.success).toBe(false);
      expect(pushResult.errors.length).toBeGreaterThan(0);
      expect(pushResult.errors[0]).toContain('NE=69233242');
    });
  });

  describe('pushStationData', () => {
    it('maps station fields correctly to API payload', async () => {
      const stationResult = makeStationCrawlResult();
      vi.mocked(mockAxios.post).mockResolvedValue({ status: 200, data: {} });

      await client.pushStationData(stationResult);

      const stationCall = vi.mocked(mockAxios.post).mock.calls.find(
        (call) => call[0] === '/ingestion/stations'
      );
      expect(stationCall).toBeDefined();
      expect(stationCall![1]).toEqual(
        expect.objectContaining({
          external_id: 'NE=69233242',
          name: 'Test Station',
          country: 'ID',
          status: 'normal',
        })
      );
    });
  });

  describe('withRetry (via pushCrawlSummary)', () => {
    it('retries on 5xx errors', async () => {
      const result = makeCrawlResult();

      const error5xx = Object.assign(new Error('Service Unavailable'), {
        response: { status: 503 },
        config: {},
        code: undefined,
      });

      vi.mocked(mockAxios.post)
        .mockRejectedValueOnce(error5xx)
        .mockRejectedValueOnce(error5xx)
        .mockResolvedValueOnce({ status: 200, data: {} });

      // pushCrawlSummary uses withRetry internally
      await expect(client.pushCrawlSummary(result)).resolves.not.toThrow();

      // Should have been called 3 times (2 failures + 1 success)
      const summaryCalls = vi.mocked(mockAxios.post).mock.calls.filter(
        (call) => call[0] === '/ingestion/crawl-summary'
      );
      expect(summaryCalls).toHaveLength(3);
    });

    it('retries on 429 (rate limit)', async () => {
      const result = makeCrawlResult();

      const error429 = Object.assign(new Error('Too Many Requests'), {
        response: { status: 429 },
        config: {},
        code: undefined,
      });

      vi.mocked(mockAxios.post)
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({ status: 200, data: {} });

      await expect(client.pushCrawlSummary(result)).resolves.not.toThrow();
    });

    it('does NOT retry on 4xx (except 429)', async () => {
      const result = makeCrawlResult();

      const error400 = Object.assign(new Error('Bad Request'), {
        response: { status: 400 },
        config: {},
        code: undefined,
      });

      vi.mocked(mockAxios.post).mockRejectedValueOnce(error400);

      await expect(client.pushCrawlSummary(result)).rejects.toThrow('Bad Request');

      const summaryCalls = vi.mocked(mockAxios.post).mock.calls.filter(
        (call) => call[0] === '/ingestion/crawl-summary'
      );
      expect(summaryCalls).toHaveLength(1);
    });
  });
});
