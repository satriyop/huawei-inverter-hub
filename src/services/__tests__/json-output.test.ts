import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import { makeCrawlResult, makeStationCrawlResult } from '../../__tests__/fixtures.js';

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    readdir: vi.fn(),
  },
}));

vi.mock('../../config/index.js', () => ({
  config: {
    logging: { level: 'info', file: 'logs/crawler.log' },
  },
}));

import { JsonOutput } from '../../services/json-output.js';

describe('JsonOutput', () => {
  let jsonOutput: JsonOutput;

  beforeEach(() => {
    jsonOutput = new JsonOutput('test-output');
  });

  describe('init', () => {
    it('creates 3 directories', async () => {
      await jsonOutput.init();

      expect(fs.mkdir).toHaveBeenCalledTimes(3);
      expect(fs.mkdir).toHaveBeenCalledWith('test-output', { recursive: true });
      expect(fs.mkdir).toHaveBeenCalledWith('test-output/stations', { recursive: true });
      expect(fs.mkdir).toHaveBeenCalledWith('test-output/screenshots', { recursive: true });
    });
  });

  describe('saveCrawlResult', () => {
    it('writes timestamped file and latest file', async () => {
      const result = makeCrawlResult();

      await jsonOutput.saveCrawlResult(result);

      expect(fs.writeFile).toHaveBeenCalledTimes(2);

      const calls = vi.mocked(fs.writeFile).mock.calls;
      // First call: timestamped file
      expect(calls[0][0]).toMatch(/test-output\/crawl-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json/);
      // Second call: latest file
      expect(calls[1][0]).toBe('test-output/crawl-latest.json');
    });

    it('formats duration correctly', async () => {
      const result = makeCrawlResult({ duration: 12500 });

      await jsonOutput.saveCrawlResult(result);

      const writtenJson = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenJson);
      expect(parsed.durationFormatted).toBe('12.5s');
    });

    it('includes station count and errors count', async () => {
      const result = makeCrawlResult();

      await jsonOutput.saveCrawlResult(result);

      const writtenJson = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenJson);
      expect(parsed.stationsCount).toBe(1);
      expect(parsed.errorsCount).toBe(0);
      expect(parsed.success).toBe(true);
    });
  });

  describe('saveStation', () => {
    it('sanitizes DN for filename', async () => {
      const station = makeStationCrawlResult();
      station.station.stationDn = 'NE=69233242';

      await jsonOutput.saveStation(station);

      const filepath = vi.mocked(fs.writeFile).mock.calls[0][0] as string;
      expect(filepath).toBe('test-output/stations/NE_69233242.json');
    });
  });

  describe('formatStation (via saveCrawlResult)', () => {
    it('includes all sections', async () => {
      const result = makeCrawlResult();

      await jsonOutput.saveCrawlResult(result);

      const writtenJson = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenJson);
      const station = parsed.stations[0];

      // Realtime section
      expect(station.realtime).toBeDefined();
      expect(station.realtime.currentPower).toBe(45.5);
      expect(station.realtime.currentPowerUnit).toBe('kW');

      // Energy balance section
      expect(station.energyBalance).toBeDefined();
      expect(station.energyBalance.generatedByPV).toBe(200);

      // Environmental section
      expect(station.environmental).toBeDefined();
      expect(station.environmental.co2Avoided).toBe(12.8);

      // Devices section
      expect(station.devicesCount).toBe(1);
      expect(station.devices).toHaveLength(1);

      // Alarms section
      expect(station.alarmsCount).toBe(0);
      expect(station.alarms).toHaveLength(0);
    });
  });

  describe('getLatest', () => {
    it('reads and parses latest file', async () => {
      const mockData = { crawledAt: '2026-01-15', success: true };
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockData));

      const result = await jsonOutput.getLatest();

      expect(result).toEqual(mockData);
      expect(fs.readFile).toHaveBeenCalledWith('test-output/crawl-latest.json', 'utf-8');
    });

    it('returns null when file does not exist', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await jsonOutput.getLatest();

      expect(result).toBeNull();
    });
  });

  describe('listCrawls', () => {
    it('filters and sorts correctly', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        'crawl-2026-01-15T10-00-00.json',
        'crawl-2026-01-15T11-00-00.json',
        'crawl-latest.json',
        'other-file.txt',
        'crawl-2026-01-14T10-00-00.json',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const result = await jsonOutput.listCrawls();

      // Should exclude crawl-latest.json and non-crawl files
      expect(result).toHaveLength(3);
      // Should be sorted in reverse (newest first)
      expect(result[0]).toBe('crawl-2026-01-15T11-00-00.json');
      expect(result[1]).toBe('crawl-2026-01-15T10-00-00.json');
      expect(result[2]).toBe('crawl-2026-01-14T10-00-00.json');
    });

    it('returns empty array on error', async () => {
      vi.mocked(fs.readdir).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await jsonOutput.listCrawls();

      expect(result).toEqual([]);
    });
  });
});
