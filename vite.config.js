import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Content Security Policy of the built app (GRB-04). Scripts and styles come only from the app
// itself; thumbnails may come from any https host; nothing may be framed, posted or connected to.
// Added at build time only: the Vite dev server needs inline scripts and a websocket.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const contentSecurityPolicy = () => ({
  name: 'grab-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  base: './',
  server: { port: 5173, strictPort: true },
});
