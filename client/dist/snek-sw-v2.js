// Minimal service worker. Its only job is to make the page "installable"
// on Android Chrome (which requires a service worker for the
// beforeinstallprompt event to fire). We deliberately do NOT cache
// the app shell — snek.io is a live WebSocket game where stale JS would
// silently desync the client from the server, and the only "offline"
// experience we want is the install-availability heuristic.
//
// The handler is a passthrough that always goes to the network.
//
// Version: 2 (renamed from sw.js to ensure fresh registration after
// repeated installability fix attempts — old SW was likely cached).

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

// Service-Worker-Allowed header would let us expand the scope, but
// we're registering at the app's base path with default scope so we
// don't need it.
