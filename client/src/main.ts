/// <reference types="@webgpu/types" />
import { DbConnection, tables } from './module_bindings/index';
import type { SnakeSegment } from './module_bindings/types';

// Sound file imports (Vite handles these)
import backgroundMusicUrl from './assets/sounds/snek_background_song.mp3';
import eatSoundUrl from './assets/sounds/short_crunch.mp3';
import deathSoundUrl from './assets/sounds/8bit_death.mp3';

const COLORS = [
  '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#FFB347',
  '#87CEEB', '#98FB98', '#F0E68C', '#FFA07A',
  '#20B2AA', '#778899', '#B19CD9', '#5F9EA0',
  '#7FFFD4', '#6495ED', '#DDA0DD', '#40E0D0',
];

const MAP_SIZE = 2000;
const SERVER = 'wss://maincloud.spacetimedb.com';
const DB_NAME = 'snek-io';

interface Player {
  identity: string;
  name: string;
  color: string;
  x: number;
  y: number;
  direction: number;
  alive: boolean;
  score: number;
  length: number;
}

interface Bot {
  id: bigint;
  name: string;
  color: string;
  x: number;
  y: number;
  direction: number;
  alive: boolean;
  score: number;
  length: number;
}

interface Food {
  id: bigint;
  x: number;
  y: number;
  color: string;
}

class SoundManager {
  private audioContext: AudioContext | null = null;
  private backgroundMusic: HTMLAudioElement | null = null;
  private backgroundSource: MediaElementAudioSourceNode | null = null;
  private backgroundGain: GainNode | null = null;
  private lowPassFilter: BiquadFilterNode | null = null;
  private eatBuffer: AudioBuffer | null = null;
  private eatGain: GainNode | null = null;
  private deathSound: HTMLAudioElement | null = null;
  private isInitialized: boolean = false;
  private isPlaying: boolean = false;
  // VOLUME CONTROL: Adjust baseVolume to change background music volume (0.0 to 1.0)
  private baseVolume: number = 0.18; // Reduced from 0.4
  private muffledVolume: number = 0.1;
  private eatVolume: number = 0.3;
  private eatSoundPlaying: boolean = false;
  private muted: boolean = false;

  constructor() {
    this.initializeAudio();
  }

  private initializeAudio() {
    try {
      // Create audio context
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Setup background music
      this.backgroundMusic = new Audio(backgroundMusicUrl);
      this.backgroundMusic.loop = true;
      
      // Setup Web Audio API nodes for background music
      if (this.audioContext) {
        this.backgroundSource = this.audioContext.createMediaElementSource(this.backgroundMusic);
        this.backgroundGain = this.audioContext.createGain();
        this.lowPassFilter = this.audioContext.createBiquadFilter();
        
        this.lowPassFilter.type = 'lowpass';
        this.lowPassFilter.frequency.value = 20000; // Full frequency by default
        
        this.backgroundSource.connect(this.lowPassFilter);
        this.lowPassFilter.connect(this.backgroundGain);
        this.backgroundGain.connect(this.audioContext.destination);
        
        this.backgroundGain.gain.value = this.baseVolume;
      }
      
      // Setup eat sound - decode as AudioBuffer for low latency through Web Audio API
      fetch(eatSoundUrl)
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => {
          if (this.audioContext) {
            return this.audioContext.decodeAudioData(arrayBuffer);
          }
          return null;
        })
        .then(buffer => {
          this.eatBuffer = buffer;
          // Create gain node for eat sound
          if (this.audioContext) {
            this.eatGain = this.audioContext.createGain();
            this.eatGain.gain.value = this.eatVolume;
            this.eatGain.connect(this.audioContext.destination);
          }
        })
        .catch(err => console.warn('Failed to load eat sound:', err));
      
      // Setup death sound
      this.deathSound = new Audio(deathSoundUrl);
      
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize SoundManager:', error);
    }
  }

  private ensureAudioContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  startBackgroundMusic() {
    if (!this.isInitialized || !this.backgroundMusic) return;
    
    this.ensureAudioContext();
    
    if (!this.isPlaying) {
      // Ensure audio context is running
      if (this.audioContext?.state === 'suspended') {
        this.audioContext.resume().then(() => {
          this.playBackgroundMusic();
        });
      } else {
        this.playBackgroundMusic();
      }
    }
  }

  private playBackgroundMusic() {
    if (!this.backgroundMusic) return;
    
    this.backgroundMusic.currentTime = 0;
    this.backgroundMusic.play().then(() => {
      this.isPlaying = true;
    }).catch(err => {
      console.warn('Failed to play background music:', err);
      this.isPlaying = false;
    });
  }

  playEatSound() {
    if (!this.isInitialized || !this.eatBuffer || !this.audioContext || !this.eatGain) return;
    
    // Don't play if already playing
    if (this.eatSoundPlaying) return;
    
    this.ensureAudioContext();
    this.eatSoundPlaying = true;
    
    // Play through Web Audio API to avoid system audio ducking
    const source = this.audioContext.createBufferSource();
    source.buffer = this.eatBuffer;
    source.connect(this.eatGain);
    source.start(0);
    
    // Reset flag after sound duration
    setTimeout(() => {
      this.eatSoundPlaying = false;
    }, 100);
  }

  playDeathSound() {
    if (!this.isInitialized || !this.deathSound || !this.audioContext) return;
    
    this.ensureAudioContext();
    
    // Clone audio to allow overlapping sounds
    const soundClone = this.deathSound.cloneNode() as HTMLAudioElement;
    const source = this.audioContext.createMediaElementSource(soundClone);
    const gain = this.audioContext.createGain();
    
    gain.gain.value = 0.6;
    source.connect(gain);
    gain.connect(this.audioContext.destination);
    
    soundClone.currentTime = 0;
    soundClone.play().catch(err => {
      console.warn('Failed to play death sound:', err);
    });
    
    // Cleanup after playback
    soundClone.addEventListener('ended', () => {
      soundClone.remove();
    });
  }

  setMenuMode(isMenuVisible: boolean, isDeathScreenVisible: boolean) {
    if (!this.isInitialized || !this.backgroundGain || !this.lowPassFilter) return;
    
    const isMuffled = isMenuVisible || isDeathScreenVisible;
    const targetVolume = this.muted ? 0 : (isMuffled ? this.muffledVolume : this.baseVolume);
    const targetFreq = isMuffled ? 400 : 20000;
    
    // Use immediate transition (0) when muted, otherwise 0.3s for smooth fade
    const transitionTime = this.muted ? 0 : 0.3;
    
    this.backgroundGain.gain.setTargetAtTime(targetVolume, this.audioContext!.currentTime, transitionTime);
    this.lowPassFilter.frequency.setTargetAtTime(targetFreq, this.audioContext!.currentTime, transitionTime);
  }

  toggleMute(): boolean {
    if (!this.isInitialized || !this.backgroundGain) return false;
    
    this.muted = !this.muted;
    
    if (this.muted) {
      // Mute - set to 0
      this.backgroundGain.gain.setTargetAtTime(0, this.audioContext!.currentTime, 0.1);
    } else {
      // Unmute - restore to base volume
      this.backgroundGain.gain.setTargetAtTime(this.baseVolume, this.audioContext!.currentTime, 0.1);
    }
    
    return !this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }
}

class WebGPURenderer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private canvas: HTMLCanvasElement;
  private players: Map<string, { x: number; y: number; color: string; alive: boolean; direction: number; segments: { x: number; y: number; width: number }[] }> = new Map();
  private foods: Food[] = [];
  private myIdentity: string = '';
  private cameraX: number = 1000;
  private cameraY: number = 1000;
  private viewportWidth: number = 800;
  private viewportHeight: number = 600;
  private maxVertices: number = 500000; // Increased from 100k to prevent invisibility bugs

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<boolean> {
    if (!navigator.gpu) {
      console.error('WebGPU not supported');
      return false;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.error('No GPU adapter found');
        return false;
      }

      this.device = await adapter.requestDevice();
      
      const context = this.canvas.getContext('webgpu');
      if (!context) {
        console.error('Could not get WebGPU context');
        return false;
      }
      this.context = context as GPUCanvasContext;

      const format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: format,
        alphaMode: 'premultiplied',
      });

      this.createBuffers();
      this.createPipeline(format);
      this.createBindGroup();

      return true;
    } catch (e) {
      console.error('WebGPU init failed:', e);
      return false;
    }
  }

  private createPipeline(format: GPUTextureFormat) {
    const shaderCode = `
      struct Uniforms {
        viewProjection: mat4x4<f32>,
      };
      
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      
      struct VertexInput {
        @location(0) position: vec2<f32>,
        @location(1) color: vec3<f32>,
      };
      
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec3<f32>,
      };
      
      @vertex
      fn vs_main(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniforms.viewProjection * vec4<f32>(input.position, 0.0, 1.0);
        output.color = input.color;
        return output;
      }
      
      @fragment
      fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
        return vec4<f32>(input.color, 1.0);
      }
    `;

    const shaderModule = this.device!.createShaderModule({ code: shaderCode });

    const bindGroupLayout = this.device!.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      }],
    });

    const pipelineLayout = this.device!.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = this.device!.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.bindGroupLayout = bindGroupLayout;
  }

  private createBindGroup() {
    if (!this.bindGroupLayout || !this.uniformBuffer) return;
    
    this.bindGroup = this.device!.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer },
      }],
    });
  }

  private createBuffers() {
    this.vertexBuffer = this.device!.createBuffer({
      size: this.maxVertices * 20,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.uniformBuffer = this.device!.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  resize(width: number, height: number) {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  setPlayers(players: Map<string, { x: number; y: number; color: string; alive: boolean; direction: number; segments: { x: number; y: number; width: number }[] }>) {
    this.players = players;
  }

  setFoods(foods: Food[]) {
    this.foods = foods;
  }

  setMyIdentity(identity: string) {
    this.myIdentity = identity;
  }

  private hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255,
    ] : [1, 1, 1];
  }

  private orthographicMatrix(left: number, right: number, bottom: number, top: number, near: number, far: number): Float32Array {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    return new Float32Array([
      -2 * lr, 0, 0, 0,
      0, -2 * bt, 0, 0,
      0, 0, 2 * nf, 0,
      (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1,
    ]);
  }

  private addQuad(vertices: number[], x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
    // Add 1 pixel padding to ensure segments fully cover underlying elements (like food)
    const padding = 1;
    const x1 = x - padding, y1 = y - padding;
    const x2 = x + w + padding, y2 = y + h + padding;
    vertices.push(x1, y1, r, g, b);
    vertices.push(x2, y1, r, g, b);
    vertices.push(x1, y2, r, g, b);
    vertices.push(x1, y2, r, g, b);
    vertices.push(x2, y1, r, g, b);
    vertices.push(x2, y2, r, g, b);
  }

  private rotatePoint(x: number, y: number, cx: number, cy: number, angleRad: number): [number, number] {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const dx = x - cx;
    const dy = y - cy;
    return [
      cx + dx * cos - dy * sin,
      cy + dx * sin + dy * cos
    ];
  }

  private addTriangle(vertices: number[], x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, r: number, g: number, b: number) {
    vertices.push(x1, y1, r, g, b);
    vertices.push(x2, y2, r, g, b);
    vertices.push(x3, y3, r, g, b);
  }

  private addTrapezoidHead(vertices: number[], cx: number, cy: number, backWidth: number, frontWidth: number, length: number, angleRad: number, r: number, g: number, b: number) {
    // Trapezoid with narrow front (pointy end) and wide back
    // Front is at +length/2, back is at -length/2 relative to center
    // Angle: 0 = pointing right, PI/2 = pointing up, etc.
    
    const halfBack = backWidth / 2;
    const halfFront = frontWidth / 2;
    const halfLen = length / 2;
    
    // Local coordinates (before rotation)
    // Back left, back right, front right, front left
    const localPoints: [number, number][] = [
      [-halfLen, -halfBack],   // back left
      [-halfLen, halfBack],    // back right  
      [halfLen, halfFront],    // front right
      [halfLen, -halfFront],   // front left
    ];
    
    // Rotate and translate to world position
    const worldPoints = localPoints.map(([lx, ly]) => this.rotatePoint(cx + lx, cy + ly, cx, cy, angleRad));
    
    // Draw as two triangles: (0,1,2) and (0,2,3)
    this.addTriangle(vertices, worldPoints[0][0], worldPoints[0][1], worldPoints[1][0], worldPoints[1][1], worldPoints[2][0], worldPoints[2][1], r, g, b);
    this.addTriangle(vertices, worldPoints[0][0], worldPoints[0][1], worldPoints[2][0], worldPoints[2][1], worldPoints[3][0], worldPoints[3][1], r, g, b);
  }

  private addCircle(vertices: number[], cx: number, cy: number, radius: number, r: number, g: number, b: number, segments: number = 16) {
    for (let i = 0; i < segments; i++) {
      const angle1 = (i / segments) * Math.PI * 2;
      const angle2 = ((i + 1) / segments) * Math.PI * 2;
      const x1 = cx + Math.cos(angle1) * radius;
      const y1 = cy + Math.sin(angle1) * radius;
      const x2 = cx + Math.cos(angle2) * radius;
      const y2 = cy + Math.sin(angle2) * radius;
      this.addTriangle(vertices, cx, cy, x1, y1, x2, y2, r, g, b);
    }
  }

  render() {
    if (!this.device || !this.context || !this.pipeline || !this.vertexBuffer || !this.uniformBuffer) return;

    const player = this.players.get(this.myIdentity);
    if (player) {
      this.cameraX = player.x - this.viewportWidth / 2;
      this.cameraY = player.y - this.viewportHeight / 2;
    }

    const projection = this.orthographicMatrix(this.cameraX, this.cameraX + this.viewportWidth, this.cameraY + this.viewportHeight, this.cameraY, -1, 1);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, projection as any);

    const vertices: number[] = [];
    
    // Background
    this.addQuad(vertices, this.cameraX, this.cameraY, this.viewportWidth, this.viewportHeight, 0.08, 0.08, 0.14);

    // Grid
    const gridSize = 40;
    const gridR = 0.12, gridG = 0.12, gridB = 0.18;
    const startX = Math.floor(this.cameraX / gridSize) * gridSize;
    const endX = Math.ceil((this.cameraX + this.viewportWidth) / gridSize) * gridSize;
    const startY = Math.floor(this.cameraY / gridSize) * gridSize;
    const endY = Math.ceil((this.cameraY + this.viewportHeight) / gridSize) * gridSize;
    
    for (let wx = startX; wx <= endX; wx += gridSize) {
      if (wx >= this.cameraX && wx <= this.cameraX + this.viewportWidth) {
        this.addQuad(vertices, wx - 1, this.cameraY, 2, this.viewportHeight, gridR, gridG, gridB);
      }
    }
    for (let wy = startY; wy <= endY; wy += gridSize) {
      if (wy >= this.cameraY && wy <= this.viewportHeight + this.cameraY) {
        this.addQuad(vertices, this.cameraX, wy - 1, this.viewportWidth, 2, gridR, gridG, gridB);
      }
    }

    // Food - skip rendering food very close to player head to avoid visual glitches
    const foodSize = 10;
    const playerPos = this.players.get(this.myIdentity);
    const playerHeadX = playerPos?.x ?? 0;
    const playerHeadY = playerPos?.y ?? 0;
    
    // Calculate wrap offsets - show wrapped view when camera is near edges
    const wrapThresholdX = this.viewportWidth;
    const wrapThresholdY = this.viewportHeight;
    const wrapOffsetsX: number[] = [0];
    const wrapOffsetsY: number[] = [0];
    
    if (this.cameraX < wrapThresholdX) {
      wrapOffsetsX.push(-MAP_SIZE);
    }
    if (this.cameraX + this.viewportWidth > MAP_SIZE - wrapThresholdX) {
      wrapOffsetsX.push(MAP_SIZE);
    }
    if (this.cameraY < wrapThresholdY) {
      wrapOffsetsY.push(-MAP_SIZE);
    }
    if (this.cameraY + this.viewportHeight > MAP_SIZE - wrapThresholdY) {
      wrapOffsetsY.push(MAP_SIZE);
    }
    
    for (const food of this.foods) {
      // Skip food that's near the player's head to avoid visual glitches
      if (Math.abs(food.x - playerHeadX) < 20 && Math.abs(food.y - playerHeadY) < 20) {
        continue;
      }
      
      // Render food at all relevant wrap positions
      for (const wrapX of wrapOffsetsX) {
        for (const wrapY of wrapOffsetsY) {
          const fx = food.x + wrapX;
          const fy = food.y + wrapY;
          
          if (fx >= this.cameraX - foodSize && fx <= this.cameraX + this.viewportWidth + foodSize &&
              fy >= this.cameraY - foodSize && fy <= this.cameraY + this.viewportHeight + foodSize) {
            const [fr, fg, fb] = this.hexToRgb(food.color);
            this.addQuad(vertices, fx - foodSize/2, fy - foodSize/2, foodSize, foodSize, fr, fg, fb);
          }
        }
      }
    }

    // Players and Bots - render from tail to head so head is drawn last (on top)
    let totalSegments = 0;
    for (const [identity, data] of this.players) {
      const [r, g, b] = this.hexToRgb(data.color);
      const segments = data.segments?.length ? data.segments : [{ x: data.x, y: data.y, width: 14 }];
      totalSegments += segments.length;
      
      // Render segments at all relevant wrap positions
      for (const wrapX of wrapOffsetsX) {
        for (const wrapY of wrapOffsetsY) {
          // Render from last segment (tail) to first (head) so head is on top
          // segments is sorted: [0]=head, [1]=body, ..., [last]=tail
          for (let i = segments.length - 1; i >= 0; i--) {
            const sx = segments[i].x + wrapX;
            const sy = segments[i].y + wrapY;
            
            // Head is at index 0 (first in sorted array)
            const isHead = i === 0;
            const baseWidth = segments[i].width || 14;
            
            if (isHead) {
              // Calculate direction angle from head to next segment
              // The head should point AWAY from the body (opposite of body direction)
              let angleRad = 0;
              if (segments.length > 1) {
                const nextSeg = segments[1];
                // Handle world wrapping for angle calculation
                let nx = nextSeg.x + wrapX;
                let ny = nextSeg.y + wrapY;
                const xDiff = nx - sx;
                const yDiff = ny - sy;
                if (Math.abs(xDiff) > MAP_SIZE / 2) {
                  nx = xDiff > 0 ? nx - MAP_SIZE : nx + MAP_SIZE;
                }
                if (Math.abs(yDiff) > MAP_SIZE / 2) {
                  ny = yDiff > 0 ? ny - MAP_SIZE : ny + MAP_SIZE;
                }
                // Angle from head to body, then flip 180° to point forward
                const dx = nx - sx;
                const dy = ny - sy;
                // Check for invalid positions (same point)
                if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
                  // Segments are at same position - use direction from player data
                  angleRad = data.direction || 0;
                } else {
                  angleRad = Math.atan2(dy, dx) + Math.PI;
                }
                // Validate angle is not NaN
                if (isNaN(angleRad) || !isFinite(angleRad)) {
                  angleRad = data.direction || 0;
                }
              }
              
              // Ensure we have a valid angle for rendering
              const safeAngle = (isNaN(angleRad) || !isFinite(angleRad)) ? 0 : angleRad;
              
              // Head is larger and brighter - trapezoid shape
              const backWidth = baseWidth + 12;
              const frontWidth = baseWidth * 0.35;
              const headLength = baseWidth + 6;
              const br = Math.min(1, r * 1.3);
              const bg = Math.min(1, g * 1.3);
              const bb = Math.min(1, b * 1.3);

              // Shift head forward in direction of movement so it leads the body
              const headForwardShift = headLength * 0.3;
              const headX = sx + Math.cos(safeAngle) * headForwardShift;
              const headY = sy + Math.sin(safeAngle) * headForwardShift;

              // Draw trapezoid head pointing in direction of movement
              this.addTrapezoidHead(vertices, headX, headY, backWidth, frontWidth, headLength, safeAngle, br, bg, bb);

              // Calculate positions for eyes and nostrils relative to head
              // Eyes are positioned further back on the wide part of the head
              const eyeBackOffset = headLength * 0.22; // Eyes moved forward a bit
              const eyeSpacing = backWidth * 0.22; // Closer to center so they don't stick out
              const eyeRadius = baseWidth * 0.18; // Slightly smaller eyes
              
              // Perpendicular angle for eye offset (90 degrees from movement direction)
              const perpAngle = safeAngle + Math.PI / 2;
              
              // Left eye position (back from center, offset perpendicular) - use headX/headY as base
              const leftEyeX = headX - Math.cos(safeAngle) * eyeBackOffset + Math.cos(perpAngle) * eyeSpacing;
              const leftEyeY = headY - Math.sin(safeAngle) * eyeBackOffset + Math.sin(perpAngle) * eyeSpacing;
              
              // Right eye position (back from center, offset opposite perpendicular)
              const rightEyeX = headX - Math.cos(safeAngle) * eyeBackOffset - Math.cos(perpAngle) * eyeSpacing;
              const rightEyeY = headY - Math.sin(safeAngle) * eyeBackOffset - Math.sin(perpAngle) * eyeSpacing;
              
              // Draw googly eyes (white sclera)
              this.addCircle(vertices, leftEyeX, leftEyeY, eyeRadius, 1, 1, 1);
              this.addCircle(vertices, rightEyeX, rightEyeY, eyeRadius, 1, 1, 1);
              
              // Draw pupils (black, slightly offset for googly effect - offset in direction of movement)
              const pupilRadius = eyeRadius * 0.45;
              const pupilOffset = eyeRadius * 0.3;
              const pupilX = Math.cos(safeAngle) * pupilOffset;
              const pupilY = Math.sin(safeAngle) * pupilOffset;
              
              this.addCircle(vertices, leftEyeX + pupilX, leftEyeY + pupilY, pupilRadius, 0, 0, 0);
              this.addCircle(vertices, rightEyeX + pupilX, rightEyeY + pupilY, pupilRadius, 0, 0, 0);
              
              // Draw nostrils at the very front (narrow part of trapezoid)
              const nostrilForwardOffset = headLength * 0.35; // Very front
              const nostrilSpacing = frontWidth * 0.25;
              const nostrilRadius = baseWidth * 0.08;
              
              // Left nostril
              const leftNostrilX = headX + Math.cos(safeAngle) * nostrilForwardOffset + Math.cos(perpAngle) * nostrilSpacing;
              const leftNostrilY = headY + Math.sin(safeAngle) * nostrilForwardOffset + Math.sin(perpAngle) * nostrilSpacing;
              
              // Right nostril
              const rightNostrilX = headX + Math.cos(safeAngle) * nostrilForwardOffset - Math.cos(perpAngle) * nostrilSpacing;
              const rightNostrilY = headY + Math.sin(safeAngle) * nostrilForwardOffset - Math.sin(perpAngle) * nostrilSpacing;
              
              this.addCircle(vertices, leftNostrilX, leftNostrilY, nostrilRadius, 0.2, 0.1, 0.05);
              this.addCircle(vertices, rightNostrilX, rightNostrilY, nostrilRadius, 0.2, 0.1, 0.05);
            } else {
              // Body segments - render as circles
              const renderWidth = Math.max(baseWidth, 15);
              this.addCircle(vertices, sx, sy, renderWidth / 2, r, g, b);
            }
          }
        }
      }
    }

    if (vertices.length === 0) return;
    
    // Prevent vertex buffer overflow
    const maxFloats = this.maxVertices * 5;
    if (vertices.length > maxFloats) {
      console.warn(`Vertex overflow: ${vertices.length} floats, max ${maxFloats}. Truncating.`);
      vertices.length = maxFloats;
    }

    const vertexData = new Float32Array(vertices);
    this.device.queue.writeBuffer(this.vertexBuffer!, 0, vertexData as any);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    const renderPass: GPURenderPassDescriptor = {
      colorAttachments: [{ view: textureView, clearValue: { r: 0.1, g: 0.1, b: 0.18, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPass);
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup!);
    passEncoder.setVertexBuffer(0, this.vertexBuffer!);
    passEncoder.draw(vertices.length / 5, 1, 0, 0);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }
}

class Game {
  private conn: DbConnection | null = null;
  private renderer: WebGPURenderer | null = null;
  private soundManager: SoundManager;
  private players: Map<string, Player> = new Map();
  private segments: Map<string, { segmentIndex: number; x: number; y: number; width: number }[]> = new Map();
  private bots: Map<string, Bot> = new Map();
  private botSegments: Map<string, { segmentIndex: number; x: number; y: number; width: number }[]> = new Map();
  private foods: Food[] = [];
  private myIdentity: string = '';
  private myScore: number = 0;
  private myPreviousScore: number = 0;
  private connected: boolean = false;
  private leaderboardUpdateCounter: number = 0;

  // Input state for 360-degree movement
  private pressedKeys: Set<string> = new Set();
  private mouseX: number = 0;
  private mouseY: number = 0;
  private lastInputType: 'keyboard' | 'mouse' | 'touch' = 'keyboard';
  private currentDirectionAngle: number = 0;
  private directionUpdateInterval: number | null = null;
  private lastTapTime: number = 0;

  constructor() {
    this.soundManager = new SoundManager();
  }

  async init() {
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    this.renderer = new WebGPURenderer(canvas);
    
    const success = await this.renderer.init();
    if (!success) {
      alert('WebGPU not supported. Please use a modern browser.');
      return;
    }

    this.setupColorPicker();
    this.setupEventListeners();
    this.setupPwaInstallPrompt();
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.resizeCanvas(), 100);
    });

    await this.connectToServer();
    
    // Background music starts in onConnect callback when SpaceTimeDB connects
    
    // Start the game loop
    requestAnimationFrame(this.gameLoop);
  }

  private setupColorPicker() {
    const picker = document.getElementById('color-picker');
    if (!picker) return;

    COLORS.forEach((color, i) => {
      const div = document.createElement('div');
      div.className = 'color-option' + (i === this.selectedColorIndex ? ' selected' : '');
      div.style.backgroundColor = color;
      div.dataset.color = color;
      div.addEventListener('click', () => {
        this.selectedColorIndex = i;
        picker.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
      });
      picker.appendChild(div);
    });
  }

  private setupEventListeners() {
    document.getElementById('play-btn')?.addEventListener('click', () => this.joinGame());
    document.getElementById('respawn-btn')?.addEventListener('click', () => this.respawn());
    document.getElementById('speaker-icon')?.addEventListener('click', () => this.toggleMute());

    // Keyboard controls
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    window.addEventListener('blur', () => this.handleWindowBlur());

    // Mouse controls
    window.addEventListener('mousemove', (e) => this.handleMouseMove(e));

    // Touch controls
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    canvas.addEventListener('touchend', () => this.handleTouchEnd());
    canvas.addEventListener('touchcancel', () => this.handleTouchEnd());
    canvas.addEventListener('dblclick', () => this.activateDash());
  }

  private resizeCanvas() {
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    canvas.width = screen.width || window.outerWidth || window.innerWidth;
    canvas.height = screen.height || window.outerHeight || window.innerHeight;
    this.renderer?.resize(canvas.width, canvas.height);
  }

  private selectedColorIndex: number = Math.floor(Math.random() * COLORS.length);

  private handleKeyDown(e: KeyboardEvent) {
    // Check if menu is visible
    const menu = document.getElementById('menu');
    const isMenuVisible = menu && !menu.classList.contains('hidden');

    // Handle color selection with arrow keys when menu is visible
    if (isMenuVisible) {
      let colorChanged = false;
      const numColorsPerRow = 10;

      switch (e.key) {
        case 'ArrowRight':
          this.selectedColorIndex = (this.selectedColorIndex + 1) % COLORS.length;
          colorChanged = true;
          break;
        case 'ArrowLeft':
          this.selectedColorIndex = (this.selectedColorIndex - 1 + COLORS.length) % COLORS.length;
          colorChanged = true;
          break;
        case 'ArrowDown':
          this.selectedColorIndex = Math.min(COLORS.length - 1, this.selectedColorIndex + numColorsPerRow);
          colorChanged = true;
          break;
        case 'ArrowUp':
          this.selectedColorIndex = Math.max(0, this.selectedColorIndex - numColorsPerRow);
          colorChanged = true;
          break;
      }

      if (colorChanged) {
        e.preventDefault();
        const picker = document.getElementById('color-picker');
        if (picker) {
          const options = picker.querySelectorAll('.color-option');
          options.forEach((el, i) => {
            if (i === this.selectedColorIndex) {
              el.classList.add('selected');
            } else {
              el.classList.remove('selected');
            }
          });
        }
        return;
      }
    }

    // Handle Enter key for play/respawn
    if (e.key === 'Enter') {
      const deathScreen = document.getElementById('death-screen');

      if (isMenuVisible) {
        this.joinGame();
        return;
      }

      if (deathScreen && !deathScreen.classList.contains('hidden')) {
        this.respawn();
        return;
      }
    }

    // Handle dash (space)
    if (e.code === 'Space') {
      this.activateDash();
      e.preventDefault();
      return;
    }

    // Track movement keys
    const validKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D'];
    if (validKeys.includes(e.key) || validKeys.includes(e.code)) {
      this.pressedKeys.add(e.code);
      this.lastInputType = 'keyboard';
      this.updateDirectionAndSend();
    }
  }

  private handleKeyUp(e: KeyboardEvent) {
    this.pressedKeys.delete(e.code);
    if (this.lastInputType === 'keyboard') {
      this.updateDirectionAndSend();
    }
  }

  private handleWindowBlur() {
    this.pressedKeys.clear();
  }

  private handleMouseMove(e: MouseEvent) {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.lastInputType = 'mouse';
    this.updateDirectionAndSend();
  }

  private handleTouchStart(e: TouchEvent) {
    e.preventDefault();
    
    // Check for double-tap (within 300ms)
    const now = Date.now();
    if (now - this.lastTapTime < 300) {
      this.activateDash();
    }
    this.lastTapTime = now;
    
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      this.mouseX = touch.clientX;
      this.mouseY = touch.clientY;
      this.lastInputType = 'touch';
      this.updateDirectionAndSend();
    }
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      this.mouseX = touch.clientX;
      this.mouseY = touch.clientY;
      this.lastInputType = 'touch';
      this.updateDirectionAndSend();
    }
  }

  private handleTouchEnd() {
    // Touch ended, but keep last direction (snake keeps moving)
  }

  private calculateDirection(): number {
    if (this.lastInputType === 'keyboard') {
      // Check key combinations for 8-directional movement
      const up = this.pressedKeys.has('ArrowUp') || this.pressedKeys.has('KeyW');
      const down = this.pressedKeys.has('ArrowDown') || this.pressedKeys.has('KeyS');
      const left = this.pressedKeys.has('ArrowLeft') || this.pressedKeys.has('KeyA');
      const right = this.pressedKeys.has('ArrowRight') || this.pressedKeys.has('KeyD');

      // Cancel out opposing keys
      const netY = (down ? 1 : 0) - (up ? 1 : 0);
      const netX = (right ? 1 : 0) - (left ? 1 : 0);

      if (netX === 0 && netY === 0) {
        return this.currentDirectionAngle;
      }

      return Math.atan2(netY, netX);
    } else {
      // Mouse or touch: angle from screen center to cursor
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      return Math.atan2(this.mouseY - centerY, this.mouseX - centerX);
    }
  }

  private updateDirectionAndSend() {
    const newAngle = this.calculateDirection();

    // Only send if angle changed significantly (0.01 radians ~ 0.57 degrees)
    if (Math.abs(newAngle - this.currentDirectionAngle) > 0.01) {
      this.currentDirectionAngle = newAngle;
      this.conn?.reducers.changeDirection({ direction: newAngle });
    }
  }

  private activateDash() {
    this.conn?.reducers.activateDash({});
  }

  private async connectToServer() {
    const savedToken = localStorage.getItem('snek-token');
    
    this.conn = DbConnection.builder()
      .withUri(SERVER)
      .withDatabaseName(DB_NAME)
      .withToken(savedToken || undefined)
      .onConnect((conn: any, identity: any, token: string) => {
        localStorage.setItem('snek-token', token);
        this.myIdentity = identity.toString();
        this.renderer?.setMyIdentity(this.myIdentity);
        this.connected = true;
        this.setupCallbacks();
        document.getElementById('loading')?.classList.add('hidden');
        
        conn.subscriptionBuilder()
          .onApplied(() => {
          })
          .subscribe([
            tables.player, 
            tables.snake_segment, 
            tables.bot, 
            tables.bot_segment, 
            tables.food, 
            tables.player_position_event, 
            tables.player_joined_event, 
            tables.player_died_event,
            tables.bot_died_event
          ]);
      })
      .onDisconnect(() => {
        this.connected = false;
      })
      .build();
  }

  private setupCallbacks() {
    if (!this.conn) return;

    // Player callbacks
    this.conn.db.player.onInsert((ctx, player) => {
      this.players.set(player.identity.toString(), { 
        identity: player.identity.toString(), 
        name: player.name, 
        color: player.color, 
        x: player.x, 
        y: player.y, 
        direction: player.direction, 
        alive: player.alive, 
        score: player.score, 
        length: player.length 
      });
    });

    this.conn.db.player.onUpdate((ctx, oldPlayer, newPlayer) => {
      const player = this.players.get(newPlayer.identity.toString());
      if (player) {
        Object.assign(player, { 
          name: newPlayer.name, 
          color: newPlayer.color, 
          x: newPlayer.x, 
          y: newPlayer.y, 
          direction: newPlayer.direction, 
          alive: newPlayer.alive, 
          score: newPlayer.score, 
          length: newPlayer.length 
        });
        if (newPlayer.identity.toString() === this.myIdentity) { 
          // Check if score increased (food eaten)
          if (newPlayer.score > this.myScore) {
            this.soundManager.playEatSound();
          }
          this.myScore = newPlayer.score; 
        }
      }
    });

    this.conn.db.player.onDelete((ctx, player) => { 
      this.players.delete(player.identity.toString()); 
      this.segments.delete(player.identity.toString()); 
    });

    this.conn.db.snake_segment.onInsert((ctx, seg) => {
      const id = seg.ownerIdentity.toString();
      if (!this.segments.has(id)) this.segments.set(id, []);
      const segment = seg as unknown as SnakeSegment;
      this.segments.get(id)!.push({ 
        segmentIndex: seg.segmentIndex, 
        x: seg.x, 
        y: seg.y, 
        width: segment.width || 14 
      });
    });

    this.conn.db.snake_segment.onUpdate((ctx, oldSeg, newSeg) => {
      const id = newSeg.ownerIdentity.toString();
      const segs = this.segments.get(id);
      if (segs) { 
        const idx = segs.findIndex(s => s.segmentIndex === newSeg.segmentIndex); 
        if (idx >= 0) {
          const segment = newSeg as unknown as SnakeSegment;
          segs[idx] = { 
            segmentIndex: newSeg.segmentIndex, 
            x: newSeg.x, 
            y: newSeg.y, 
            width: segment.width || segs[idx].width 
          };
        }
      }
    });

    // Bot callbacks
    this.conn.db.bot.onInsert((ctx, bot) => {
      const botId = bot.id.toString();
      this.bots.set(botId, { 
        id: bot.id, 
        name: bot.name, 
        color: bot.color, 
        x: bot.x, 
        y: bot.y, 
        direction: bot.direction, 
        alive: bot.alive, 
        score: bot.score, 
        length: bot.length 
      });
    });

    this.conn.db.bot.onUpdate((ctx, oldBot, newBot) => {
      const botId = newBot.id.toString();
      const bot = this.bots.get(botId);
      if (bot) {
        Object.assign(bot, { 
          name: newBot.name, 
          color: newBot.color, 
          x: newBot.x, 
          y: newBot.y, 
          direction: newBot.direction, 
          alive: newBot.alive, 
          score: newBot.score, 
          length: newBot.length 
        });
      }
    });

    this.conn.db.bot.onDelete((ctx, bot) => { 
      const botId = bot.id.toString();
      this.bots.delete(botId); 
      this.botSegments.delete(botId); 
    });

    this.conn.db.bot_segment.onInsert((ctx, seg) => {
      const botId = seg.botId.toString();
      if (!this.botSegments.has(botId)) this.botSegments.set(botId, []);
      this.botSegments.get(botId)!.push({ 
        segmentIndex: seg.segmentIndex, 
        x: seg.x, 
        y: seg.y, 
        width: seg.width || 14 
      });
    });

    this.conn.db.bot_segment.onUpdate((ctx, oldSeg, newSeg) => {
      const botId = newSeg.botId.toString();
      const segs = this.botSegments.get(botId);
      if (segs) { 
        const idx = segs.findIndex(s => s.segmentIndex === newSeg.segmentIndex); 
        if (idx >= 0) {
          segs[idx] = { 
            segmentIndex: newSeg.segmentIndex, 
            x: newSeg.x, 
            y: newSeg.y, 
            width: newSeg.width || segs[idx].width 
          }; 
        }
      }
    });

    // Food callbacks
    this.conn.db.food.onInsert((ctx, food) => { 
      this.foods.push({ id: food.id, x: food.x, y: food.y, color: food.color }); 
    });
    
    this.conn.db.food.onDelete((ctx, food) => { 
      const idx = this.foods.findIndex(f => f.id === food.id); 
      if (idx >= 0) {
        this.foods.splice(idx, 1); 
      }
    });

    // Event callbacks
    this.conn.db.player_position_event.onInsert((ctx, event) => {
      const player = this.players.get(event.identity.toString());
      if (player) { 
        player.x = event.x; 
        player.y = event.y; 
        player.direction = event.direction; 
      }
    });

    this.conn.db.player_died_event.onInsert((ctx, event) => {
      const identity = event.identity.toString();
      if (identity === this.myIdentity) this.showDeathScreen(event.killerName);
    });

    this.conn.db.bot_died_event.onInsert((ctx, event) => {
    });
  }

  private joinGame() {
    const name = (document.getElementById('name-input') as HTMLInputElement).value.trim() || 'Anonymous';
    localStorage.setItem('snek-name', name);
    let selectedColor = COLORS[0];
    document.querySelectorAll('.color-option.selected').forEach(el => { selectedColor = (el as any).dataset.color || COLORS[0]; });
    document.getElementById('menu')?.classList.add('hidden');
    document.getElementById('leaderboard')?.classList.remove('hidden');
    document.getElementById('loading')?.classList.add('hidden');

    // Start background music when user starts playing
    this.soundManager.startBackgroundMusic();

    // Update sound mode for gameplay
    this.soundManager.setMenuMode(false, false);

    // Start direction update loop
    this.startDirectionUpdateLoop();

    if (this.conn) this.conn.reducers.joinGame({ name, color: selectedColor });
  }

  private startDirectionUpdateLoop() {
    // Send direction periodically (every 50ms = 20 updates/sec)
    if (this.directionUpdateInterval) {
      clearInterval(this.directionUpdateInterval);
    }
    this.directionUpdateInterval = window.setInterval(() => {
      if (this.lastInputType === 'keyboard') {
        this.updateDirectionAndSend();
      }
    }, 50);
  }

  private respawn() {
    document.getElementById('death-screen')?.classList.add('hidden');
    document.getElementById('leaderboard')?.classList.remove('hidden');
    
    // Update sound mode for gameplay
    this.soundManager.setMenuMode(false, false);
    
    const name = (document.getElementById('name-input') as HTMLInputElement).value.trim() || 'Anonymous';
    let selectedColor = COLORS[0];
    document.querySelectorAll('.color-option.selected').forEach(el => { selectedColor = (el as any).dataset.color || COLORS[0]; });
    if (this.conn) this.conn.reducers.joinGame({ name, color: selectedColor });
  }

  private showDeathScreen(killerName: string) {
    const stats = document.getElementById('death-stats');
    if (stats) {
      stats.innerHTML = `You were killed by ${killerName || 'unknown'}<br>Final Score: ${this.myScore}`;
    }
    document.getElementById('death-screen')?.classList.remove('hidden');
    document.getElementById('leaderboard')?.classList.add('hidden');
    document.getElementById('speaker-icon')?.classList.add('hidden');
    
    // Play death sound and muffle background music
    this.soundManager.playDeathSound();
    this.soundManager.setMenuMode(false, true);
  }

  private toggleMute() {
    this.soundManager.toggleMute();
    // Always sync icon from actual mute state
    const speakerIcon = document.getElementById('speaker-icon');
    if (speakerIcon) {
      speakerIcon.textContent = this.soundManager.isMuted() ? '🔇' : '🔊';
    }
  }

  private updateLeaderboard() {
    // Collect all scores from players and bots
    const allScores: Array<{ name: string; score: number; isPlayer: boolean; identity?: string }> = [];

    // Add human players
    for (const [identity, player] of this.players) {
      if (player.alive) {
        allScores.push({
          name: player.name,
          score: player.score,
          isPlayer: true,
          identity: identity
        });
      }
    }

    // Add bots
    for (const [botId, bot] of this.bots) {
      if (bot.alive) {
        allScores.push({
          name: bot.name,
          score: bot.score,
          isPlayer: false
        });
      }
    }

    // Sort by score descending
    allScores.sort((a, b) => b.score - a.score);

    // Get top 10
    const top10 = allScores.slice(0, 10);

    // Find current player rank if not in top 10
    let currentPlayerRank = -1;
    let currentPlayerData = null;
    for (let i = 0; i < allScores.length; i++) {
      if (allScores[i].identity === this.myIdentity) {
        currentPlayerRank = i + 1;
        currentPlayerData = allScores[i];
        break;
      }
    }

    // Update leaderboard UI
    const leaderboardList = document.getElementById('leaderboard-list');
    if (!leaderboardList) return;

    leaderboardList.innerHTML = '';

    // Render top 10
    top10.forEach((entry, index) => {
      const rank = index + 1;
      const isCurrentPlayer = entry.identity === this.myIdentity;

      const item = document.createElement('div');
      item.className = `leaderboard-item${isCurrentPlayer ? ' current-player' : ''}`;
      item.innerHTML = `
        <span class="leaderboard-rank">#${rank}</span>
        <span class="leaderboard-name">${entry.name}</span>
        <span class="leaderboard-score">${entry.score}</span>
      `;
      leaderboardList.appendChild(item);
    });

    // If current player is not in top 10, show them at the bottom
    if (currentPlayerRank > 10 && currentPlayerData) {
      const divider = document.createElement('div');
      divider.className = 'leaderboard-divider';
      leaderboardList.appendChild(divider);

      const item = document.createElement('div');
      item.className = 'leaderboard-item current-player';
      item.innerHTML = `
        <span class="leaderboard-rank">#${currentPlayerRank}</span>
        <span class="leaderboard-name">${currentPlayerData.name}</span>
        <span class="leaderboard-score">${currentPlayerData.score}</span>
      `;
      leaderboardList.appendChild(item);
    }
  }

  private gameLoop = () => {
    if (this.renderer && this.conn) {
      const playerData = new Map<string, { x: number; y: number; color: string; alive: boolean; direction: number; segments: { x: number; y: number; width: number }[] }>();

      // Add human players
      for (const [identity, player] of this.players) {
        if (!player.alive) continue;
        const segs = this.segments.get(identity) || [];
        const sortedSegs = [...segs].sort((a, b) => a.segmentIndex - b.segmentIndex);
        playerData.set(identity, {
          x: player.x,
          y: player.y,
          color: player.color,
          alive: player.alive,
          direction: player.direction,
          segments: sortedSegs.map(s => ({ x: s.x, y: s.y, width: s.width }))
        });
      }

      // Add bots - use 'bot-' prefix to distinguish from players
      for (const [botId, bot] of this.bots) {
        if (!bot.alive) continue;
        const segs = this.botSegments.get(botId) || [];
        const sortedSegs = [...segs].sort((a, b) => a.segmentIndex - b.segmentIndex);
        playerData.set(`bot-${botId}`, {
          x: bot.x,
          y: bot.y,
          color: bot.color,
          alive: bot.alive,
          direction: bot.direction,
          segments: sortedSegs.map(s => ({ x: s.x, y: s.y, width: s.width }))
        });
      }

      this.renderer.setPlayers(playerData);
      this.renderer.setFoods(this.foods);
      this.renderer.render();
      
      // Render snake names
      this.renderSnakeNames();

      // Update leaderboard every 30 frames (~0.5 seconds at 60fps)
      this.leaderboardUpdateCounter++;
      if (this.leaderboardUpdateCounter >= 30) {
        this.leaderboardUpdateCounter = 0;
        this.updateLeaderboard();
      }
    }
    requestAnimationFrame(this.gameLoop);
  };

  private renderSnakeNames() {
    const namesContainer = document.getElementById('snake-names');
    if (!namesContainer) return;
    
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    if (!canvas) return;
    
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    
    // Get camera position (centered on player)
    let cameraX = centerX;
    let cameraY = centerY;
    if (this.myIdentity) {
      const myPlayer = this.players.get(this.myIdentity);
      if (myPlayer && myPlayer.alive) {
        cameraX = myPlayer.x;
        cameraY = myPlayer.y;
      }
    }
    
    // Clear existing names
    namesContainer.innerHTML = '';
    
    // Render player names
    for (const [identity, player] of this.players) {
      if (!player.alive) continue;
      this.addNameLabel(namesContainer, player.name, player.x, player.y, cameraX, cameraY, width, height);
    }
    
    // Render bot names
    for (const [botId, bot] of this.bots) {
      if (!bot.alive) continue;
      this.addNameLabel(namesContainer, bot.name, bot.x, bot.y, cameraX, cameraY, width, height);
    }
  }
  
  private addNameLabel(container: HTMLElement, name: string, worldX: number, worldY: number, cameraX: number, cameraY: number, screenWidth: number, screenHeight: number) {
    const offset = 25;
    const screenX = screenWidth / 2 + (worldX - cameraX);
    const screenY = screenHeight / 2 + (worldY - cameraY) - offset;
    
    // Skip if outside viewport
    if (screenX < -50 || screenX > screenWidth + 50 || screenY < -50 || screenY > screenHeight + 50) return;
    
    const div = document.createElement('div');
    div.className = 'snake-name';
    div.textContent = name;
    div.style.left = `${screenX}px`;
    div.style.top = `${screenY}px`;
    container.appendChild(div);
  }

  private setupPwaInstallPrompt() {
    let deferredPrompt: Event | null = null;
    
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      this.showInstallButton(deferredPrompt);
    });
    
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      this.enableLandscapeOrientation();
    });
    
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      this.enableLandscapeOrientation();
      return;
    }
    
    // Check immediately for mobile
    this.checkAndShowInstallButton();
    
    // Also check when menu becomes visible
    const menuObserver = new MutationObserver(() => {
      const menu = document.getElementById('menu');
      if (menu && !menu.classList.contains('hidden')) {
        this.checkAndShowInstallButton();
      }
    });
    
    const menu = document.getElementById('menu');
    if (menu) {
      menuObserver.observe(menu, { attributes: true, attributeFilter: ['class'] });
    }
  }
  
  private isMobile(): boolean {
    return /Mobi|Android/i.test(navigator.userAgent) || /iPad|iPhone|iPod/i.test(navigator.userAgent);
  }
  
  private checkAndShowInstallButton() {
    if (!this.isMobile()) return;
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    
    const menu = document.getElementById('menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.querySelector('.install-btn')) return;
    
    // Create button but don't show yet - wait for deferredPrompt
    const btn = document.createElement('button');
    btn.className = 'play-btn install-btn';
    btn.textContent = 'Mobile App';
    btn.style.marginTop = '1rem';
    btn.style.display = 'none';
    
    btn.onclick = async () => {
      const prompt = (window as any).deferredInstallPrompt;
      if (prompt) {
        prompt.prompt();
        const { outcome } = await prompt.userChoice;
        if (outcome === 'accepted') {
          btn.remove();
        }
        (window as any).deferredInstallPrompt = null;
      } else if (/iPad|iPhone|iPod/i.test(navigator.userAgent)) {
        alert('To install: Tap Share button below, then tap "Add to Home Screen"');
      }
    };
    
    menu.querySelector('.menu-panel')?.appendChild(btn);
  }
  
  private showInstallButton(prompt: Event) {
    (window as any).deferredInstallPrompt = prompt;
    const btn = document.querySelector('.install-btn') as HTMLElement;
    if (btn) {
      btn.style.display = 'block';
    }
  }
  
  private enableLandscapeOrientation() {
    // Lock to landscape when app is installed on mobile
    if (screen.orientation && 'lock' in screen.orientation) {
      (screen.orientation.lock as (type: string) => Promise<void>)('landscape').catch(() => {
        // Lock not supported or denied
      });
    }
  }
}

window.addEventListener('load', () => { const game = new Game(); game.init(); });
