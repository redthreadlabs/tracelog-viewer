import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the built dist/ also works from a file:// URL
  // or any static host without configuration (SPEC §1: "deployable from a
  // file:// URL, GitHub Pages, or an S3 static site").
  base: './',
  // the store worker code-splits (SDK dynamic imports), which iife can't do
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // bridge.html is the apex workspace-directory keeper (src/bridge.ts),
      // loaded in a hidden iframe by every subdomain
      input: { main: 'index.html', bridge: 'bridge.html' },
    },
  },
  server: {
    port: 5173,
    strictPort: true, // the bucket CORS rule allows exactly this origin
  },
});
