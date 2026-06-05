/// <reference types="@webgpu/types" />

import { Game } from './game';

// Register the service worker. Android Chrome won't fire
// `beforeinstallprompt` — so the "Install App" button click does
// nothing — unless a service worker is registered for the page. The SW
// itself is a no-op (see public/sw.js); it's only here to satisfy
// the installability heuristic.
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
