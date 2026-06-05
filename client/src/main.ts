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
    // Versioned SW URL so Chrome treats it as a new registration
    // (cached old /sw.js registrations were likely contributing to
    // repeated installability check failures).
    navigator.serviceWorker.register('/snek-io/snek-sw-v2.js', { scope: '/snek-io/' }).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

window.addEventListener('load', () => {
  // Stamp the build version into the menu so the user can see they're
  // on a fresh deploy. If they ever report "nothing changed" again, the
  // first diagnostic is to ask what the build-version text says.
  const versionEl = document.getElementById('build-version');
  if (versionEl) {
    // Use the current git HEAD short hash, replaced at build time via
    // a literal that the build process bakes in. For now we use a date
    // stamp + the asset filename so we can tell caches apart.
    const asset = Array.from(document.querySelectorAll('script[src*="/assets/"]'))
      .map(s => (s as HTMLScriptElement).src.split('/').pop() || '')
      .find(s => s.startsWith('index-')) || 'unknown';
    versionEl.textContent = `build ${asset.replace('index-', '').replace('.js', '')}`;
  }

  const game = new Game();
  game.init().catch(err => console.error('Game init failed:', err));
});
