# Getting Started

This guide covers everything you need to set up RetractCheck for local development, deploy the API, and package the extension for browser stores.

## Requirements

- [Bun](https://bun.sh/) 1.2.22 or later
- A Cloudflare account (free tier works) if you want to self-host the API
- macOS, Linux, or Windows 10+

## Quick Start

```bash
git clone https://github.com/gouthamindukuri/RetractCheck-Extension.git
cd RetractCheck-Extension
bun install
```

Create a `.env` file in the root:

```bash
cp .env.example .env
```

Edit `.env` and set your worker URL:

```
RETRACTCHECK_WORKER_URL=https://your-worker.workers.dev
```

Build everything:

```bash
bun run build
```

Run tests:

```bash
bun run test
```

## Project Structure

```
RetractCheck-Extension/
├── apps/
│   ├── api/          # Cloudflare Worker (REST API)
│   └── extension/    # Browser extension (Chrome, Firefox, Edge)
├── packages/
│   ├── doi/          # DOI extraction and normalization
│   ├── types/        # Shared TypeScript types
│   └── config/       # Shared ESLint config
└── scripts/          # Build utilities
```

## Loading the Extension Locally

After building, load the extension in your browser:

**Chrome / Edge:**
1. Go to `chrome://extensions` or `edge://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `apps/extension/dist`

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `apps/extension/dist/manifest.json`

## Packaging for Browser Stores

```bash
cd apps/extension

# Package for all browsers
RETRACTCHECK_WORKER_URL=https://your-worker.workers.dev bun run package

# Or individually
bun run package:chrome   # Creates RetractCheck-chrome.zip
bun run package:firefox  # Creates RetractCheck-firefox.xpi
bun run package:edge     # Creates RetractCheck-edge.zip
```

## API Deployment (Cloudflare Workers)

The extension talks to a Cloudflare Worker that queries the Retraction Watch database.

### Setup

```bash
cd apps/api

# Copy the example config
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml` with your Cloudflare account details:
- Create a D1 database and add its ID
- Create a KV namespace and add its ID

### Secrets

```bash
bun wrangler secret put INGEST_TOKEN          # Required: token for data ingestion
bun wrangler secret put HEALTHCHECK_PING_URL  # Optional: healthchecks.io URL
bun wrangler secret put TELEGRAM_BOT_TOKEN    # Optional: for host request notifications
bun wrangler secret put TELEGRAM_CHAT_ID      # Optional: your Telegram chat ID
```

### Deploy

```bash
bun wrangler deploy
```

### Local Development

```bash
bun wrangler dev --local
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/status?doi=<doi>` | GET | Look up retraction status for a DOI |
| `/v1/health` | GET | Health check |
| `/v1/info` | GET | Data freshness info |
| `/v1/override` | POST | Log a host support request |
| `/v1/ingest` | POST | Trigger data refresh (requires auth) |

## Data Source

Retraction data comes from the [Retraction Watch Database](https://gitlab.com/crossref/retraction-watch-data) hosted on GitLab. The API fetches fresh data daily at 2:00 AM UTC.

## Common Commands

```bash
# Build all packages
bun run build

# Run all tests
bun run test

# Lint everything
bun run lint

# Clean build outputs
bun run clean

# Bump version
bun run version:patch   # 0.2.0 -> 0.2.1
bun run version:minor   # 0.2.0 -> 0.3.0
bun run version:major   # 0.2.0 -> 1.0.0
```

## Troubleshooting

**Build fails with "RETRACTCHECK_WORKER_URL not set"**

Set the environment variable before building:

```bash
export RETRACTCHECK_WORKER_URL=https://your-worker.workers.dev
bun run build
```

Or add it to your `.env` file.

**Extension shows "Unsupported website"**

The site isn't in the allow-list. Click "Check anyway" to check it manually, or open an issue to request permanent support.

**API returns 429 Too Many Requests**

You've hit the rate limit. Wait for the window to reset (check the `Retry-After` header). Extension users with a client ID get higher limits than anonymous requests.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `bun run lint && bun run test`
5. Open a pull request

File bugs or site support requests in [GitHub Issues](https://github.com/gouthamindukuri/RetractCheck-Extension/issues).
