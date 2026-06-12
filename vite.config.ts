import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the built dist/ also works from a file:// URL
  // or any static host without configuration (SPEC §1: "deployable from a
  // file:// URL, GitHub Pages, or an S3 static site").
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true, // the bucket CORS rule allows exactly this origin
  },
});
