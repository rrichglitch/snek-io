/// <reference types="@webgpu/types" />

import { Game } from './game';

window.addEventListener('load', () => {
  const game = new Game();
  game.init().catch(err => console.error('Game init failed:', err));
});
