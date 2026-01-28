import { vi, beforeEach } from 'vitest';

// Mock logger globally - prevents winston initialization which requires config
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});
