/// <reference types="@webgpu/types" />

import { Game } from './game';

// Register the service worker. Android Chrome won't fire
// `beforeinstallprompt` — so the "Install App" button click does
// nothing — unless a service worker is registered for the page. The SW
// itself is a no-op (see public/sw.js); it's only here to satisfy
// the installability heuristic.
//
// We register at /sw.js (default scope "/") rather than fighting the
// Service Worker spec to scope it to /snek-io/. The SW is a strict
// no-op pass-through so a broader scope is harmless — the alternative
// (registering under /snek-io/sw.js with scope /snek-io/) would
// require moving every manifest icon path to /snek-io/... and would
// break for any future page hosted at the github.io root.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

window.addEventListener('load', () => {
  const game = new Game();
  game.init().catch(err => console.error('Game init failed:', err));
});
