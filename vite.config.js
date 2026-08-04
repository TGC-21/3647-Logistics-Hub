import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html'
    }
  },
  server: {
    proxy: {
      // Forwards relative /api/* fetches (see src/services/*Api.js) to the
      // standalone Hono backend during local dev. Vercel used to make this
      // unnecessary since functions and frontend shared an origin.
      '/api': 'http://localhost:3000'
    }
  }
})