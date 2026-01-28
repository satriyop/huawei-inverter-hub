import type {
  Station,
  StationRealTimeKpi,
  EnergyBalance,
  EnvironmentalData,
  Device,
  InverterRealtimeData,
  Alarm,
  CrawlResult,
  StationCrawlResult,
  DeviceCrawlResult,
  CrawlError,
  Cookie,
} from '../types/fusionsolar.js';

export function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    stationDn: 'NE=69233242',
    stationCode: 'ST001',
    stationName: 'Test Station',
    address: '123 Solar St',
    country: 'ID',
    gridConnectionDate: '2025-12-03',
    capacity: 100,
    ratedPower: 80,
    timeZone: 7,
    timeZoneStr: 'Asia/Jakarta',
    status: 'normal',
    ...overrides,
  };
}

export function makeRealtimeKpi(overrides: Partial<StationRealTimeKpi> = {}): StationRealTimeKpi {
  return {
    stationDn: 'NE=69233242',
    currentPower: 45.5,
    yieldToday: 120.3,
    totalYield: 50000,
    revenueToday: 100000,
    ratedPower: 80,
    ratedESSCapacity: 0,
    ...overrides,
  };
}

export function makeEnergyBalance(overrides: Partial<EnergyBalance> = {}): EnergyBalance {
  return {
    stationDn: 'NE=69233242',
    date: '2026-01-15 00:00:00',
    timeDim: 2,
    generatedByPV: 200,
    consumedFromPV: 150,
    fedToGrid: 50,
    consumedByAppliances: 180,
    fromPV: 150,
    fromGrid: 30,
    ...overrides,
  };
}

export function makeEnvironmental(overrides: Partial<EnvironmentalData> = {}): EnvironmentalData {
  return {
    standardCoalSaved: 5.2,
    co2Avoided: 12.8,
    equivalentTreesPlanted: 340,
    ...overrides,
  };
}

export function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    deviceDn: 'NE=69239038',
    deviceName: 'INV-TA24B0037389',
    deviceType: 'Inverter',
    deviceModel: 'SUN2000-5KTL-M1',
    softwareVersion: 'V100R001C00SPC142',
    stationDn: 'NE=69233242',
    status: 'online',
    ...overrides,
  };
}

export function makeInverterRealtimeData(
  overrides: Partial<InverterRealtimeData> = {}
): InverterRealtimeData {
  return {
    deviceDn: 'NE=69239038',
    deviceName: 'INV-TA24B0037389',
    status: 'Running',
    dailyEnergy: 25.3,
    totalYield: 12500,
    activePower: 4.2,
    reactivePower: 0.1,
    ratedPower: 5,
    powerFactor: 0.99,
    gridFrequency: 50.01,
    gridVoltage: 230.5,
    gridCurrent: 18.2,
    internalTemperature: 42,
    insulationResistance: 1000,
    outputMode: 'L/N',
    startupTime: '06:30',
    shutdownTime: '18:00',
    pvStrings: [
      { stringId: 'PV1', voltage: 320, current: 8.5 },
      { stringId: 'PV2', voltage: 318, current: 8.3 },
    ],
    ...overrides,
  };
}

export function makeAlarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    alarmId: 'ALM001',
    deviceDn: 'NE=69239038',
    stationDn: 'NE=69233242',
    alarmName: 'Grid Voltage High',
    alarmCode: 'A001',
    severity: 'warning',
    startTime: '2026-01-15T10:00:00Z',
    status: 'active',
    ...overrides,
  };
}

export function makeDeviceCrawlResult(
  overrides: Partial<DeviceCrawlResult> = {}
): DeviceCrawlResult {
  return {
    device: makeDevice(),
    realtimeData: makeInverterRealtimeData(),
    ...overrides,
  };
}

export function makeStationCrawlResult(
  overrides: Partial<StationCrawlResult> = {}
): StationCrawlResult {
  return {
    station: makeStation(),
    realtimeKpi: makeRealtimeKpi(),
    energyBalance: makeEnergyBalance(),
    devices: [makeDeviceCrawlResult()],
    alarms: [],
    environmental: makeEnvironmental(),
    ...overrides,
  };
}

export function makeCrawlError(overrides: Partial<CrawlError> = {}): CrawlError {
  return {
    stationDn: 'NE=69233242',
    endpoint: '/test-endpoint',
    message: 'Test error',
    timestamp: new Date('2026-01-15T12:00:00Z'),
    ...overrides,
  };
}

export function makeCrawlResult(overrides: Partial<CrawlResult> = {}): CrawlResult {
  return {
    timestamp: new Date('2026-01-15T12:00:00Z'),
    stations: [makeStationCrawlResult()],
    success: true,
    errors: [],
    duration: 5000,
    ...overrides,
  };
}

export function makeCookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    name: 'session_id',
    value: 'abc123',
    domain: '.fusionsolar.huawei.com',
    path: '/',
    expires: Date.now() + 3600000,
    httpOnly: true,
    secure: true,
    ...overrides,
  };
}
