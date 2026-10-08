import { defineConfig } from 'vite';

// In development the Go collector runs separately (`make run`); Vite proxies its event stream.
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/events': 'http://127.0.0.1:7777' },
  },
  // three.js alone is ~600 kB (150 kB gzipped). One hashed chunk, cached for good by the collector, is fine.
  build: { target: 'es2022', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
