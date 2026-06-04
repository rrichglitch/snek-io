// Wraps Web Audio + HTMLAudio for background music, eat, and death sounds.
// Background music runs through a low-pass filter that munges it when the
// menu or death screen is showing.

import { SOUND_URLS } from './config';

export class SoundManager {
  private audioContext: AudioContext | null = null;
  private backgroundMusic: HTMLAudioElement | null = null;
  private backgroundSource: MediaElementAudioSourceNode | null = null;
  private backgroundGain: GainNode | null = null;
  private lowPassFilter: BiquadFilterNode | null = null;
  private eatBuffer: AudioBuffer | null = null;
  private eatGain: GainNode | null = null;
  private deathSound: HTMLAudioElement | null = null;

  private isInitialized = false;
  private isPlaying = false;
  private eatSoundPlaying = false;
  private muted = false;

  // Tunables. Crank/lower at your leisure.
  private baseVolume = 0.18;
  private muffledVolume = 0.1;
  private eatVolume = 0.3;

  constructor() {
    this.initializeAudio();
  }

  private initializeAudio() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.backgroundMusic = new Audio(SOUND_URLS.background);
      this.backgroundMusic.loop = true;

      if (this.audioContext) {
        this.backgroundSource = this.audioContext.createMediaElementSource(this.backgroundMusic);
        this.backgroundGain = this.audioContext.createGain();
        this.lowPassFilter = this.audioContext.createBiquadFilter();
        this.lowPassFilter.type = 'lowpass';
        this.lowPassFilter.frequency.value = 20000;

        this.backgroundSource.connect(this.lowPassFilter);
        this.lowPassFilter.connect(this.backgroundGain);
        this.backgroundGain.connect(this.audioContext.destination);
        this.backgroundGain.gain.value = this.baseVolume;
      }

      fetch(SOUND_URLS.eat)
        .then(r => r.arrayBuffer())
        .then(buf => this.audioContext?.decodeAudioData(buf))
        .then(buffer => {
          this.eatBuffer = buffer ?? null;
          if (this.audioContext) {
            this.eatGain = this.audioContext.createGain();
            this.eatGain.gain.value = this.eatVolume;
            this.eatGain.connect(this.audioContext.destination);
          }
        })
        .catch(err => console.warn('Failed to load eat sound:', err));

      this.deathSound = new Audio(SOUND_URLS.death);
      this.isInitialized = true;
    } catch (err) {
      console.error('Failed to initialize SoundManager:', err);
    }
  }

  private resumeContext() {
    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  startBackgroundMusic() {
    if (!this.isInitialized || !this.backgroundMusic || this.isPlaying) return;
    this.resumeContext();

    const play = () => {
      if (!this.backgroundMusic) return;
      this.backgroundMusic.currentTime = 0;
      this.backgroundMusic.play()
        .then(() => { this.isPlaying = true; })
        .catch(err => {
          console.warn('Failed to play background music:', err);
          this.isPlaying = false;
        });
    };

    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume().then(play);
    } else {
      play();
    }
  }

  playEatSound() {
    if (!this.isInitialized || !this.eatBuffer || !this.audioContext || !this.eatGain) return;
    if (this.eatSoundPlaying) return; // debounce — eat sounds overlap constantly

    this.resumeContext();
    this.eatSoundPlaying = true;

    const source = this.audioContext.createBufferSource();
    source.buffer = this.eatBuffer;
    source.connect(this.eatGain);
    source.start(0);

    setTimeout(() => { this.eatSoundPlaying = false; }, 100);
  }

  playDeathSound() {
    if (!this.isInitialized || !this.deathSound || !this.audioContext) return;
    this.resumeContext();

    const clone = this.deathSound.cloneNode() as HTMLAudioElement;
    const source = this.audioContext.createMediaElementSource(clone);
    const gain = this.audioContext.createGain();
    gain.gain.value = 0.6;
    source.connect(gain);
    gain.connect(this.audioContext.destination);

    clone.currentTime = 0;
    clone.play().catch(err => console.warn('Failed to play death sound:', err));
    clone.addEventListener('ended', () => clone.remove(), { once: true });
  }

  setMenuMode(isMenuVisible: boolean, isDeathScreenVisible: boolean) {
    if (!this.isInitialized || !this.backgroundGain || !this.lowPassFilter || !this.audioContext) return;

    const isMuffled = isMenuVisible || isDeathScreenVisible;
    const targetVolume = this.muted ? 0 : (isMuffled ? this.muffledVolume : this.baseVolume);
    const targetFreq = isMuffled ? 400 : 20000;
    const transitionTime = this.muted ? 0 : 0.3;

    this.backgroundGain.gain.setTargetAtTime(targetVolume, this.audioContext.currentTime, transitionTime);
    this.lowPassFilter.frequency.setTargetAtTime(targetFreq, this.audioContext.currentTime, transitionTime);
  }

  toggleMute(): boolean {
    if (!this.isInitialized || !this.backgroundGain || !this.audioContext) return false;
    this.muted = !this.muted;
    this.backgroundGain.gain.setTargetAtTime(
      this.muted ? 0 : this.baseVolume,
      this.audioContext.currentTime,
      0.1
    );
    return !this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }
}
