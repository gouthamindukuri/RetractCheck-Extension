# RetractCheck Extension

RetractCheck is a browser extension that extracts the DOI from the page you are reading and checks it against the [Retraction Watch database](https://retractionwatch.com/) via the RetractCheck API. If the DOI has any associated retractions, expressions of concern, or corrections, the popup highlights the records and links back to the dataset so you can decide how to proceed.

- **Chrome / Chromium** builds target Manifest V3 with a service-worker background script.
- **Firefox** builds include a fallback background script until Manifest V3 service workers are fully enabled.
- The supported-host allow list is forked from the [PubPeer browser extension](https://github.com/PubPeerFoundation/PubPeerBrowserExtensions/tree/master). Open an issue if we are missing a venue you rely on.

## Requirements

- [Bun](https://bun.sh/) 1.2.22+
- macOS, Linux, or Windows 10+
- A Cloudflare account to self-host the API (optional)

## Getting Started

```bash
git clone https://github.com/gouthamindukuri/RetractCheck-Extension.git
cd RetractCheck-Extension
bun install

# Set your Worker endpoint (required)
cp .env.example .env
# Edit .env with your worker URL

# Build
bun run build

# Lint and test
bun run lint
bun run test

# Package for browser stores
bun run package         # All browsers
bun run package:firefox # Firefox only
bun run package:edge    # Edge only
```

## API (Cloudflare Worker)

The extension talks to the Worker in `apps/api`:

```bash
cp apps/api/wrangler.example.toml apps/api/wrangler.toml
# Edit wrangler.toml with your KV and D1 bindings

cd apps/api
bunx wrangler secret put INGEST_TOKEN
bunx wrangler deploy
```

## Contributing

- File bugs or host-coverage requests in the [issues section](https://github.com/gouthamindukuri/RetractCheck-Extension/issues).
- Pull requests welcome. Run `bun run lint && bun run test` before submitting.

## License

MIT © Goutham Indukuri
