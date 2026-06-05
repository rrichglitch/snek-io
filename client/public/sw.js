// Minimal service worker. Its only job is to make the page "installable"
// on Android Chrome (which requires a service worker for the
// beforeinstallprompt event to fire). We deliberately do NOT cache
// the app shell — snek.io is a live WebSocket game where stale JS would
// silently desync the client from the server, and the only "offline"
// experience we want is the install-availability heuristic.
//
// The handler is a passthrough that always goes to the network.

self.addEventListener('install', (event) => {
  // Activate the new SW as soon as it finishes installing so users
  // get the no-op behavior immediately on first visit.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of all open clients right away — no waiting for
  // a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass through every request unmodified. We deliberately do not
  // call event.respondWith() — leaving it unhandled makes the browser
  // fall through to its normal network stack, which is exactly what
  // we want for a real-time game.
  return;
});
