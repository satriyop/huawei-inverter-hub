import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { makeCookie } from '../../__tests__/fixtures.js';

vi.mock('../../config/index.js', () => ({
  config: {
    fusionSolar: {
      baseUrl: 'https://sg5.fusionsolar.huawei.com',
      loginUrl: 'https://sg5.fusionsolar.huawei.com/pvmswebsite/login/build/index.html',
      username: 'testuser',
      password: 'testpass',
      timeZone: 7,
      timeZoneStr: 'Asia/Jakarta',
    },
    crawler: {
      intervalMinutes: 5,
      retryAttempts: 3,
      retryDelayMs: 30000,
      requestDelayMs: 1000,
      headless: true,
    },
  },
}));

vi.mock('axios', () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} as Record<string, string> } },
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

function getMockClient() {
  return (axios as unknown as { __mockInstance: AxiosInstance }).__mockInstance;
}

import { FusionSolarApiClient } from '../../services/api-client.js';

describe('FusionSolarApiClient', () => {
  let client: FusionSolarApiClient;
  let mockAxios: ReturnType<typeof getMockClient>;

  beforeEach(() => {
    const mock = getMockClient();
    // Reset defaults.headers.common between tests
    mock.defaults.headers.common = {} as Record<string, string>;
    client = new FusionSolarApiClient();
    mockAxios = mock;
  });

  describe('setCookies', () => {
    it('sets Cookie header and extracts XSRF token', () => {
      const cookies = [
        makeCookie({ name: 'session_id', value: 'abc123' }),
        makeCookie({ name: 'XSRF-TOKEN', value: 'xsrf%3Dvalue' }),
      ];

      client.setCookies(cookies);

      const headers = mockAxios.defaults.headers.common as Record<string, string>;
      expect(headers['Cookie']).toBe('session_id=abc123; XSRF-TOKEN=xsrf%3Dvalue');
      expect(headers['X-XSRF-TOKEN']).toBe('xsrf=value');
    });

    it('sets roarand header when zoneId provided', () => {
      const cookies = [makeCookie()];

      client.setCookies(cookies, 'region-7-abc123');

      const headers = mockAxios.defaults.headers.common as Record<string, string>;
      expect(headers['roarand']).toBe('region-7-abc123');
    });

    it('does not set roarand when zoneId is not provided', () => {
      const cookies = [makeCookie()];

      client.setCookies(cookies);

      const headers = mockAxios.defaults.headers.common as Record<string, string>;
      expect(headers['roarand']).toBeUndefined();
    });
  });

  describe('isSessionAlive', () => {
    it('returns true on 200 response', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({ status: 200, data: {} });

      const result = await client.isSessionAlive();

      expect(result).toBe(true);
      expect(mockAxios.get).toHaveBeenCalledWith('/rest/dpcloud/auth/v1/is-session-alive');
    });

    it('returns false on error', async () => {
      vi.mocked(mockAxios.get).mockRejectedValueOnce(new Error('Timeout'));

      const result = await client.isSessionAlive();

      expect(result).toBe(false);
    });
  });

  describe('getStationList', () => {
    it('handles data.data.list response structure', async () => {
      const stations = [{ stationDn: 'NE=1', stationName: 'Station 1' }];
      vi.mocked(mockAxios.post).mockResolvedValueOnce({
        status: 200,
        data: { data: { list: stations } },
      });

      const result = await client.getStationList();

      expect(result).toEqual(stations);
    });

    it('handles data.data response structure', async () => {
      const stations = [{ stationDn: 'NE=2', stationName: 'Station 2' }];
      vi.mocked(mockAxios.post).mockResolvedValueOnce({
        status: 200,
        data: { data: stations },
      });

      const result = await client.getStationList();

      expect(result).toEqual(stations);
    });

    it('handles data.list response structure', async () => {
      const stations = [{ stationDn: 'NE=3', stationName: 'Station 3' }];
      vi.mocked(mockAxios.post).mockResolvedValueOnce({
        status: 200,
        data: { list: stations },
      });

      const result = await client.getStationList();

      expect(result).toEqual(stations);
    });

    it('handles array response structure', async () => {
      const stations = [{ stationDn: 'NE=4', stationName: 'Station 4' }];
      vi.mocked(mockAxios.post).mockResolvedValueOnce({
        status: 200,
        data: stations,
      });

      const result = await client.getStationList();

      expect(result).toEqual(stations);
    });

    it('returns empty array when response is HTML string', async () => {
      vi.mocked(mockAxios.post).mockResolvedValueOnce({
        status: 200,
        data: '<html><body>Login page</body></html>',
      });

      const result = await client.getStationList();

      expect(result).toEqual([]);
    });
  });

  describe('parseNumber (via getDeviceRealtimeData / parseInverterData)', () => {
    // parseNumber is private, so we test through parseInverterData
    // We can access it via getDeviceRealtimeData which calls parseInverterData

    it('handles numeric values in device data', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({
        status: 200,
        data: {
          deviceName: 'INV-001',
          status: 'Running',
          dailyEnergy: 25.3,
          totalYield: 12500,
          activePower: 4.2,
          reactivePower: 0,
          ratedPower: 5,
          powerFactor: 0.99,
          gridFrequency: 50.01,
          gridVoltage: 230.5,
          gridCurrent: 18.2,
          internalTemperature: 42,
          insulationResistance: 1000,
        },
      });

      const result = await client.getDeviceRealtimeData('NE=123');

      expect(result).not.toBeNull();
      expect(result!.dailyEnergy).toBe(25.3);
      expect(result!.activePower).toBe(4.2);
      expect(result!.gridVoltage).toBe(230.5);
    });

    it('handles string number values', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({
        status: 200,
        data: {
          deviceName: 'INV-001',
          status: 'Running',
          dailyEnergy: '25.3',
          totalYield: '12500',
          activePower: '4.2',
        },
      });

      const result = await client.getDeviceRealtimeData('NE=123');

      expect(result!.dailyEnergy).toBe(25.3);
      expect(result!.totalYield).toBe(12500);
    });

    it('handles undefined/NaN values as 0', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({
        status: 200,
        data: {
          deviceName: 'INV-001',
          status: 'Running',
          dailyEnergy: undefined,
          totalYield: 'not-a-number',
          activePower: null,
        },
      });

      const result = await client.getDeviceRealtimeData('NE=123');

      expect(result!.dailyEnergy).toBe(0);
      expect(result!.totalYield).toBe(0);
      expect(result!.activePower).toBe(0);
    });
  });

  describe('parsePvStrings (via getDeviceRealtimeData)', () => {
    it('extracts PV1-PV24 voltage/current pairs', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({
        status: 200,
        data: {
          deviceName: 'INV-001',
          status: 'Running',
          pv1Voltage: 320,
          pv1Current: 8.5,
          pv2Voltage: 318,
          pv2Current: 8.3,
          pv3Voltage: 315,
          pv3Current: 8.1,
        },
      });

      const result = await client.getDeviceRealtimeData('NE=123');

      expect(result!.pvStrings).toHaveLength(3);
      expect(result!.pvStrings[0]).toEqual({
        stringId: 'PV1',
        voltage: 320,
        current: 8.5,
      });
      expect(result!.pvStrings[1]).toEqual({
        stringId: 'PV2',
        voltage: 318,
        current: 8.3,
      });
    });

    it('returns empty array when no PV strings present', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({
        status: 200,
        data: {
          deviceName: 'Meter-001',
          status: 'Running',
          activePower: 5,
        },
      });

      const result = await client.getDeviceRealtimeData('NE=123');

      expect(result!.pvStrings).toEqual([]);
    });
  });

  describe('formatDate (tested indirectly via getEnergyBalance)', () => {
    it('formats date with zero-padded month and day', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({
        status: 200,
        data: { generatedByPV: 100 },
      });

      // January 5th - both month and day need zero-padding
      const date = new Date(2026, 0, 5); // Jan 5, 2026

      await client.getEnergyBalance('NE=123', 2, date);

      const call = vi.mocked(mockAxios.get).mock.calls[0];
      expect(call[1]?.params?.dateStr).toBe('2026-01-05 00:00:00');
    });

    it('formats double-digit month/day correctly', async () => {
      vi.mocked(mockAxios.get).mockResolvedValueOnce({
        status: 200,
        data: { generatedByPV: 100 },
      });

      const date = new Date(2026, 11, 25); // Dec 25, 2026

      await client.getEnergyBalance('NE=123', 2, date);

      const call = vi.mocked(mockAxios.get).mock.calls[0];
      expect(call[1]?.params?.dateStr).toBe('2026-12-25 00:00:00');
    });
  });
});
