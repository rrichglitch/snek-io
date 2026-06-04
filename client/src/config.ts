// Shared client constants and asset URLs.

import backgroundMusicUrl from './assets/sounds/snek_background_song.mp3';
import eatSoundUrl from './assets/sounds/short_crunch.mp3';
import deathSoundUrl from './assets/sounds/8bit_death.mp3';

export const COLORS = [
  '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#FFB347',
  '#87CEEB', '#98FB98', '#F0E68C', '#FFA07A',
  '#20B2AA', '#778899', '#B19CD9', '#5F9EA0',
  '#7FFFD4', '#6495ED', '#DDA0DD', '#40E0D0',
];

export const MAP_SIZE = 2000;
export const SERVER = 'wss://maincloud.spacetimedb.com';
export const DB_NAME = 'snek-io';
export const STORAGE_KEYS = {
  name: 'snek-name',
  token: 'snek-token',
} as const;

export const SOUND_URLS = {
  background: backgroundMusicUrl,
  eat: eatSoundUrl,
  death: deathSoundUrl,
} as const;
