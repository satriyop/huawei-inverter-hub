/**
 * FusionSolar API Types
 * Based on API discovery from FusionSolar web interface
 */

// Station/Plant Types
export interface Station {
  stationDn: string;           // e.g., "NE=69233242"
  stationCode: string;
  stationName: string;
  address: string;
  country: string;
  gridConnectionDate: string;  // e.g., "2025-12-03"
  capacity: number;            // kWp
  ratedPower: number;          // kW
  timeZone: number;            // e.g., 7.0
  timeZoneStr: string;         // e.g., "Asia/Jakarta"
  status: StationStatus;
}

export type StationStatus = 'normal' | 'faulty' | 'disconnected';

export interface StationListResponse {
  data: Station[];
  totalCount: number;
  pageNo: number;
  pageSize: number;
}

// Real-time KPIs
export interface StationRealTimeKpi {
  stationDn: string;
  currentPower: number;        // kW
  yieldToday: number;          // kWh
  totalYield: number;          // kWh
  revenueToday: number;        // local currency
  ratedPower: number;          // kW
  ratedESSCapacity: number;    // kWh
}

// Energy Balance
export interface EnergyBalance {
  stationDn: string;
  date: string;
  timeDim: TimeDimension;
  generatedByPV: number;       // kWh
  consumedFromPV: number;      // kWh
  fedToGrid: number;           // kWh
  consumedByAppliances: number; // kWh
  fromPV: number;              // kWh
  fromGrid: number;            // kWh
}

export type TimeDimension = 1 | 2 | 3 | 4 | 5; // hour, day, month, year, lifetime

// Device Types
export interface Device {
  deviceDn: string;            // e.g., "NE=69239038"
  deviceName: string;          // e.g., "INV-TA24B0037389"
  deviceType: DeviceType;
  deviceModel: string;
  softwareVersion: string;
  stationDn: string;
  status: DeviceStatus;
}

export type DeviceType = 'Inverter' | 'Battery' | 'Meter' | 'Optimizer' | 'Gateway';
export type DeviceStatus = 'online' | 'offline' | 'standby' | 'fault';

// Inverter Real-time Data
export interface InverterRealtimeData {
  deviceDn: string;
  deviceName: string;
  status: string;              // e.g., "Standby"
  dailyEnergy: number;         // kWh
  totalYield: number;          // kWh
  activePower: number;         // kW
  reactivePower: number;       // kvar
  ratedPower: number;          // kW
  powerFactor: number;
  gridFrequency: number;       // Hz
  gridVoltage: number;         // V
  gridCurrent: number;         // A
  internalTemperature: number; // °C
  insulationResistance: number; // MΩ
  outputMode: string;          // e.g., "L/N"
  startupTime: string;
  shutdownTime: string;
  pvStrings: PVString[];
}

export interface PVString {
  stringId: string;            // e.g., "PV1", "PV2"
  voltage: number;             // V
  current: number;             // A
}

// Alarm Types
export interface Alarm {
  alarmId: string;
  deviceDn: string;
  stationDn: string;
  alarmName: string;
  alarmCode: string;
  severity: AlarmSeverity;
  startTime: string;
  endTime?: string;
  status: 'active' | 'cleared';
}

export type AlarmSeverity = 'critical' | 'major' | 'minor' | 'warning';

export interface AlarmSummary {
  total: number;
  critical: number;
  major: number;
  minor: number;
  warning: number;
}

// Environmental Data
export interface EnvironmentalData {
  standardCoalSaved: number;   // tons
  co2Avoided: number;          // tons
  equivalentTreesPlanted: number;
}

// Weather Data
export interface WeatherData {
  temperature: string;         // e.g., "24~31"
  condition: string;           // e.g., "Patchy rain nearby"
}

// API Request Types
export interface StationListRequest {
  pageNo: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface EnergyBalanceRequest {
  stationDn: string;
  timeDim: TimeDimension;
  timeZone: number;
  timeZoneStr: string;
  queryTime: number;           // Unix timestamp in ms
  dateStr: string;             // e.g., "2026-01-13 00:00:00"
}

export interface DeviceKpiRequest {
  deviceDn: string;
  signalIds: number[];
}

// Session Types
export interface SessionInfo {
  cookies: Cookie[];
  isAlive: boolean;
  lastChecked: Date;
  zoneId?: string;  // e.g., "region-7-c7e0bcd3-ac22-4ad2-bb65-3d2c7c8b8008"
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

// Crawl Result Types
export interface CrawlResult {
  timestamp: Date;
  stations: StationCrawlResult[];
  success: boolean;
  errors: CrawlError[];
  duration: number;            // ms
}

export interface StationCrawlResult {
  station: Station;
  realtimeKpi: StationRealTimeKpi;
  energyBalance: EnergyBalance;
  devices: DeviceCrawlResult[];
  alarms: Alarm[];
  environmental: EnvironmentalData;
}

export interface DeviceCrawlResult {
  device: Device;
  realtimeData: InverterRealtimeData | null;
}

export interface CrawlError {
  stationDn?: string;
  deviceDn?: string;
  endpoint: string;
  message: string;
  timestamp: Date;
}

// Signal ID Mapping (based on discovery)
export const SignalIds = {
  // Power & Energy
  ACTIVE_POWER: 10006,
  POWER_FACTOR: 10022,
  DAILY_YIELD: 10023,
  TOTAL_YIELD: 10047,
  TEMPERATURE: 10025,
  GRID_VOLTAGE: 10019,
  GRID_CURRENT: 10020,
  GRID_FREQUENCY: 10018,
  STATUS: 10032,
  PERFORMANCE_RATIO: 10095,

  // Status codes
  DEVICE_STATUS: 21001,
  ALARM_INDICATOR: 21009,
  COMM_STATUS: 21020,
  REACTIVE_POWER: 21029,
} as const;
