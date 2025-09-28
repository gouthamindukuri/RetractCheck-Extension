# RetractCheck Extension

RetractCheck is a browser extension that extracts the DOI from the page you are reading and checks it against the [Retraction Watch database](https://retractionwatch.com/) via the RetractCheck API. If the DOI has any associated retractions, expressions of concern, or corrections, the popup highlights the records and links back to the dataset so you can decide how to proceed.

- **Chrome / Chromium** builds target Manifest V3 with a service-worker background script.
- **Firefox** builds include a fallback background script until Manifest V3 service workers are fully enabled.
- The supported-host allow list is forked from the [PubPeer browser extension](https://github.com/PubPeerFoundation/pubpeer-chrome-extension). Open an issue if we are missing a venue you rely on.

## Getting Started

```bash
git clone https://github.com/gouthamindukuri/RetractCheck-Extension.git
cd RetractCheck-Extension
bun install

# provide your Worker endpoint (e.g. https://your-worker.workers.dev)
export RETRACTCHECK_WORKER_URL="https://your-worker.workers.dev"

# build once
bun run build

# lint / test
bun run lint
bun run test

# package for stores
bun run package         # builds both bundles
bun run package:chrome  # emits RetractCheck-chrome.zip
bun run package:firefox # emits RetractCheck-firefox.xpi
```

The Firefox packaging task swaps in `public/manifest.firefox.json` before zipping and restores the Chrome manifest afterward.

## API (Cloudflare Worker)

The extension talks to the Worker in `apps/api`. Copy the example configuration and add your own bindings:

```bash
cp apps/api/wrangler.example.toml apps/api/wrangler.toml
# edit the KV + D1 identifiers inside

cd apps/api
bunx wrangler secret put RETRACTCHECK_SOURCE_URL  # optional CSV override
bunx wrangler deploy
```

## Contributing & Support

- File bugs or host-coverage requests in the [issues section](https://github.com/gouthamindukuri/RetractCheck-Extension/issues).
- Pull requests are welcome—please run `bun run lint` and `bun run test` before submitting.

## License

MIT © Goutham Indukuri
