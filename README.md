# Huawei FusionSolar Crawler

Node.js crawler for Huawei FusionSolar monitoring system. Part of the NexSolarHub project.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    huawei-inverter-crawler (Node.js)            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │  Puppeteer   │→ │  API Client  │→ │  Data Pusher       │     │
│  │  (Login)     │  │  (Axios)     │  │  (NexSolarHub)     │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

- **Puppeteer**: Handles JavaScript-heavy login page
- **API Client**: Makes direct HTTP calls to FusionSolar REST APIs
- **Data Pusher**: Sends collected data to NexSolarHub Laravel backend

## Prerequisites

- Node.js >= 18
- Chromium/Chrome (installed automatically with Puppeteer)

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `FUSIONSOLAR_USERNAME` | FusionSolar account username |
| `FUSIONSOLAR_PASSWORD` | FusionSolar account password |
| `NEXSOLARHUB_API_URL` | NexSolarHub API base URL |
| `NEXSOLARHUB_API_KEY` | API key for authentication |

## Usage

### Test Login

Test the FusionSolar login process:

```bash
npm run test:login
```

### Run Single Crawl

Execute a single crawl cycle:

```bash
npm run crawl:once
```

### Run Continuous Crawler

Start the crawler with scheduled intervals:

```bash
npm run crawl
```

Or for development with auto-reload:

```bash
npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run compiled JavaScript |
| `npm run dev` | Development mode with watch |
| `npm run crawl` | Run crawler (same as dev) |
| `npm run crawl:once` | Single crawl cycle |
| `npm run test:login` | Test FusionSolar login |
| `npm run typecheck` | Type checking without emit |

## Project Structure

```
src/
├── config/          # Configuration management
├── services/
│   ├── authenticator.ts    # Puppeteer login handler
│   ├── api-client.ts       # FusionSolar API client
│   ├── crawler.ts          # Main crawler orchestration
│   └── nexsolarhub-client.ts # NexSolarHub API client
├── types/           # TypeScript type definitions
├── utils/           # Utilities (logger, etc.)
├── index.ts         # Main entry (continuous)
├── crawl-once.ts    # Single crawl entry
└── test-login.ts    # Login test script
```

## Crawl Process

1. **Authentication**: Login via Puppeteer, extract session cookies
2. **Station List**: Fetch all accessible stations
3. **For Each Station**:
   - Get energy balance data
   - Get device list
   - For each device, get real-time data
   - Get active alarms
4. **Push Data**: Send to NexSolarHub API
5. **Wait**: Sleep until next interval

## API Endpoints Used

### Authentication
- `GET /rest/dpcloud/auth/v1/is-session-alive`
- `GET /rest/dpcloud/auth/v1/keep-alive`

### Station Data
- `POST /rest/pvms/web/station/v1/station/station-list`
- `GET /rest/pvms/web/station/v3/overview/energy-balance`

### Device Data
- `GET /rest/neteco/web/config/device/v1/device-list`
- `GET /rest/pvms/web/device/v1/device-realtime-data`
- `GET /rest/pvms/web/device/v1/device-real-kpi`

## Troubleshooting

### Login Fails

1. Check credentials in `.env`
2. Set `CRAWLER_HEADLESS=false` to see browser
3. Check `logs/login-failed.png` for screenshot

### Session Expires

The crawler automatically re-authenticates when session expires.

### Rate Limiting

Increase `CRAWLER_REQUEST_DELAY_MS` if you see rate limiting errors.

## License

MIT
