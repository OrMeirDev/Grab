// The one place the renderer reaches the preload bridge (window.grab). Undefined when the UI runs
// in a plain browser (vite dev without Electron).
export const api = typeof window !== 'undefined' ? window.grab : undefined;
