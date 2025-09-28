import { defineConfig } from 'tsup';

const workerEndpoint = process.env.RETRACTCHECK_WORKER_URL;
if (!workerEndpoint) {
  throw new Error('RETRACTCHECK_WORKER_URL is required (e.g. https://your-worker.workers.dev)');
}
const isDev = process.env.NODE_ENV === 'development';

const shared = {
  platform: 'browser' as const,
  target: 'es2022',
  sourcemap: true,
  minify: !isDev,
  treeshake: true,
  splitting: false,
  dts: false,
  outExtension() {
    return {
      js: '.js',
    };
  },
  define: {
    __WORKER_ENDPOINT__: JSON.stringify(workerEndpoint),
  },
};

export default defineConfig([
  {
    ...shared,
    entry: { content: 'src/content.ts' },
    format: 'iife',
    clean: true,
  },
  {
    ...shared,
    entry: { popup: 'src/popup.ts' },
    format: 'iife',
    clean: false,
  },
  {
    ...shared,
    entry: { background: 'src/background.ts' },
    format: 'esm',
    clean: false,
  },
]);

