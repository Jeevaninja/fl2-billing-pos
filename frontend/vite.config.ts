import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The local POS API (server/, `npm run api:dev` at the repo root). The Host header is left as
    // localhost:5173, which the API's loopback guard accepts.
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
})
