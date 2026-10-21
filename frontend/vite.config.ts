import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The local POS API (server/, `npm run api:dev` at the repo root). The Host header is left as
    // localhost:5173, which the API's loopback guard accepts. FL2_API_URL points a second dev
    // server at another API (e.g. a QA copy of the database on another port).
    proxy: { '/api': process.env.FL2_API_URL ?? 'http://127.0.0.1:4310' },
  },
})
