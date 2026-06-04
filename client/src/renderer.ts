// WebGPU renderer for the snake game.
//
// Perf notes:
//   * Single reusable Float32Array vertex buffer, write cursor (no per-frame
//     array allocation).
//   * Viewport culling — snakes whose bounding box doesn't overlap the
//     camera viewport are skipped entirely. This is what makes "longer
//     snake = slower" go away: a long snake only pays for the segments that
//     are actually on screen.

import { MAP_SIZE } from './config';

interface Segment { x: number; y: number; width: number }
interface RenderSnake {
  x: number;
  y: number;
  color: string;
  alive: boolean;
  direction: number;
  segments: Segment[];
}
export type RenderSnakes = Map<string, RenderSnake>;

export interface Food { id: bigint; x: number; y: number; color: string }

const MAX_VERTICES = 500_000;
const FLOATS_PER_VERTEX = 5;
const CIRCLE_SEGMENTS = 16;

export class WebGPURenderer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  private canvas: HTMLCanvasElement;
  private players: RenderSnakes = new Map();
  private foods: Food[] = [];
  private myIdentity = '';

  // Camera
  cameraX = 0;
  cameraY = 0;
  viewportWidth = 800;
  viewportHeight = 600;

  // Reusable vertex buffer state
  private vertexData: Float32Array = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX);
  private vertexCursor = 0;
  private vertexCount = 0;

  // Scratch for hex parsing
  private hexRgbCache = new Map<string, [number, number, number]>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  // ============================================================
  // Lifecycle
  // ============================================================

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
      this.context.configure({ device: this.device, format, alphaMode: 'premultiplied' });

      this.createBuffers();
      this.createPipeline(format);
      this.createBindGroup();
      return true;
    } catch (e) {
      console.error('WebGPU init failed:', e);
      return false;
    }
  }

  resize(width: number, height: number) {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  setPlayers(players: RenderSnakes) { this.players = players; }
  setFoods(foods: Food[]) { this.foods = foods; }
  setMyIdentity(identity: string) { this.myIdentity = identity; }

  // ============================================================
  // Pipeline
  // ============================================================

  private createPipeline(format: GPUTextureFormat) {
    if (!this.device) return;

    const shaderCode = `
      struct Uniforms { viewProjection: mat4x4<f32> };
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

    const module = this.device.createShaderModule({ code: shaderCode });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });

    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    this.pipeline = this.device.createRenderPipeline({
      layout,
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private createBindGroup() {
    if (!this.device || !this.uniformBuffer) return;
    const layout = this.pipeline!.getBindGroupLayout(0);
    this.bindGroup = this.device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  private createBuffers() {
    if (!this.device) return;
    this.vertexBuffer = this.device.createBuffer({
      size: MAX_VERTICES * 20,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.uniformBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ============================================================
  // Math helpers
  // ============================================================

  // Standard 2D orthographic projection. Identical to the original — column-major
  // for WGSL. Returns the same Float32Array each call (caller writes to GPU).
  private readonly projection: Float32Array = new Float32Array(16);
  private orthographicProjection(): Float32Array {
    const left = this.cameraX;
    const right = this.cameraX + this.viewportWidth;
    const top = this.cameraY;
    const bottom = this.cameraY + this.viewportHeight;
    const near = -1, far = 1;
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    const p = this.projection;
    p[0]  = -2 * lr; p[1]  = 0;      p[2]  = 0; p[3]  = 0;
    p[4]  = 0;      p[5]  = -2 * bt; p[6]  = 0; p[7]  = 0;
    p[8]  = 0;      p[9]  = 0;       p[10] = 2 * nf; p[11] = 0;
    p[12] = (left + right) * lr;
    p[13] = (top + bottom) * bt;
    p[14] = (far + near) * nf;
    p[15] = 1;
    return p;
  }

  private hexToRgb(hex: string): [number, number, number] {
    const cached = this.hexRgbCache.get(hex);
    if (cached) return cached;
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    const result: [number, number, number] = m
      ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
      : [1, 1, 1];
    this.hexRgbCache.set(hex, result);
    return result;
  }

  // ============================================================
  // Vertex emission — all writes go into the shared Float32Array
  // ============================================================

  private writeQuad(x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
    const PADDING = 1;
    const x1 = x - PADDING, y1 = y - PADDING;
    const x2 = x + w + PADDING, y2 = y + h + PADDING;
    const v = this.vertexData;
    let i = this.vertexCursor;
    // Triangle 1
    v[i++] = x1; v[i++] = y1; v[i++] = r; v[i++] = g; v[i++] = b;
    v[i++] = x2; v[i++] = y1; v[i++] = r; v[i++] = g; v[i++] = b;
    v[i++] = x1; v[i++] = y2; v[i++] = r; v[i++] = g; v[i++] = b;
    // Triangle 2
    v[i++] = x1; v[i++] = y2; v[i++] = r; v[i++] = g; v[i++] = b;
    v[i++] = x2; v[i++] = y1; v[i++] = r; v[i++] = g; v[i++] = b;
    v[i++] = x2; v[i++] = y2; v[i++] = r; v[i++] = g; v[i++] = b;
    this.vertexCursor = i;
    this.vertexCount += 6;
  }

  private writeTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, r: number, g: number, b: number) {
    const v = this.vertexData;
    let i = this.vertexCursor;
    v[i++] = x1; v[i++] = y1; v[i++] = r; v[i++] = g; v[i++] = b;
    v[i++] = x2; v[i++] = y2; v[i++] = r; v[i++] = g; v[i++] = b;
    v[i++] = x3; v[i++] = y3; v[i++] = r; v[i++] = g; v[i++] = b;
    this.vertexCursor = i;
    this.vertexCount += 3;
  }

  private writeCircle(cx: number, cy: number, radius: number, r: number, g: number, b: number) {
    const v = this.vertexData;
    let i = this.vertexCursor;
    for (let s = 0; s < CIRCLE_SEGMENTS; s++) {
      const a1 = (s / CIRCLE_SEGMENTS) * Math.PI * 2;
      const a2 = ((s + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
      const x1 = cx + Math.cos(a1) * radius;
      const y1 = cy + Math.sin(a1) * radius;
      const x2 = cx + Math.cos(a2) * radius;
      const y2 = cy + Math.sin(a2) * radius;
      v[i++] = cx; v[i++] = cy; v[i++] = r; v[i++] = g; v[i++] = b;
      v[i++] = x1; v[i++] = y1; v[i++] = r; v[i++] = g; v[i++] = b;
      v[i++] = x2; v[i++] = y2; v[i++] = r; v[i++] = g; v[i++] = b;
    }
    this.vertexCursor = i;
    this.vertexCount += CIRCLE_SEGMENTS * 3;
  }

  private writeTrapezoidHead(
    cx: number, cy: number,
    backWidth: number, frontWidth: number, length: number,
    angle: number,
    r: number, g: number, b: number
  ) {
    const halfBack = backWidth / 2;
    const halfFront = frontWidth / 2;
    const halfLen = length / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // 4 corners, rotated and translated
    const local: [number, number][] = [
      [-halfLen, -halfBack],
      [-halfLen, halfBack],
      [halfLen, halfFront],
      [halfLen, -halfFront],
    ];
    const wx: number[] = new Array(4);
    const wy: number[] = new Array(4);
    for (let k = 0; k < 4; k++) {
      const lx = local[k][0], ly = local[k][1];
      wx[k] = cx + lx * cos - ly * sin;
      wy[k] = cy + lx * sin + ly * cos;
    }

    this.writeTriangle(wx[0], wy[0], wx[1], wy[1], wx[2], wy[2], r, g, b);
    this.writeTriangle(wx[0], wy[0], wx[2], wy[2], wx[3], wy[3], r, g, b);
  }

  // ============================================================
  // Snake / head rendering
  // ============================================================

  private writeHead(
    sx: number, sy: number, sx2: number, sy2: number,
    baseWidth: number, direction: number, wrapX: number, wrapY: number,
    segments: Segment[], r: number, g: number, b: number
  ) {
    // Compute head angle from the head->next-segment vector, with world-wrap handling.
    let angle: number = direction;
    if (segments.length > 1) {
      let nx = segments[1].x + wrapX;
      let ny = segments[1].y + wrapY;
      const dx0 = nx - sx;
      const dy0 = ny - sy;
      if (Math.abs(dx0) > MAP_SIZE / 2) nx += (dx0 > 0 ? -MAP_SIZE : MAP_SIZE);
      if (Math.abs(dy0) > MAP_SIZE / 2) ny += (dy0 > 0 ? -MAP_SIZE : MAP_SIZE);
      const dx = nx - sx;
      const dy = ny - sy;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        angle = Math.atan2(dy, dx) + Math.PI;
      }
      if (!isFinite(angle)) angle = direction;
    }

    const backWidth = baseWidth + 12;
    const frontWidth = baseWidth * 0.35;
    const headLength = baseWidth + 6;
    const br = Math.min(1, r * 1.3);
    const bg = Math.min(1, g * 1.3);
    const bb = Math.min(1, b * 1.3);

    // Shift head forward in direction of movement so it leads the body
    const headShift = headLength * 0.3;
    const headX = sx + Math.cos(angle) * headShift;
    const headY = sy + Math.sin(angle) * headShift;

    this.writeTrapezoidHead(headX, headY, backWidth, frontWidth, headLength, angle, br, bg, bb);

    // Eyes, pupils, nostrils
    const perpAngle = angle + Math.PI / 2;
    const eyeBackOffset = headLength * 0.22;
    const eyeSpacing = backWidth * 0.22;
    const eyeRadius = baseWidth * 0.18;
    const leftEyeX = headX - Math.cos(angle) * eyeBackOffset + Math.cos(perpAngle) * eyeSpacing;
    const leftEyeY = headY - Math.sin(angle) * eyeBackOffset + Math.sin(perpAngle) * eyeSpacing;
    const rightEyeX = headX - Math.cos(angle) * eyeBackOffset - Math.cos(perpAngle) * eyeSpacing;
    const rightEyeY = headY - Math.sin(angle) * eyeBackOffset - Math.sin(perpAngle) * eyeSpacing;
    this.writeCircle(leftEyeX, leftEyeY, eyeRadius, 1, 1, 1);
    this.writeCircle(rightEyeX, rightEyeY, eyeRadius, 1, 1, 1);

    const pupilOffset = eyeRadius * 0.3;
    const pupilRadius = eyeRadius * 0.45;
    const pupilX = Math.cos(angle) * pupilOffset;
    const pupilY = Math.sin(angle) * pupilOffset;
    this.writeCircle(leftEyeX + pupilX, leftEyeY + pupilY, pupilRadius, 0, 0, 0);
    this.writeCircle(rightEyeX + pupilX, rightEyeY + pupilY, pupilRadius, 0, 0, 0);

    const nostrilForward = headLength * 0.35;
    const nostrilSpacing = frontWidth * 0.25;
    const nostrilRadius = baseWidth * 0.08;
    this.writeCircle(
      headX + Math.cos(angle) * nostrilForward + Math.cos(perpAngle) * nostrilSpacing,
      headY + Math.sin(angle) * nostrilForward + Math.sin(perpAngle) * nostrilSpacing,
      nostrilRadius, 0.2, 0.1, 0.05
    );
    this.writeCircle(
      headX + Math.cos(angle) * nostrilForward - Math.cos(perpAngle) * nostrilSpacing,
      headY + Math.sin(angle) * nostrilForward - Math.sin(perpAngle) * nostrilSpacing,
      nostrilRadius, 0.2, 0.1, 0.05
    );
  }

  private writeSnake(data: RenderSnake, wrapOffsetsX: number[], wrapOffsetsY: number[]) {
    const [r, g, b] = this.hexToRgb(data.color);
    const segments = data.segments.length ? data.segments : [{ x: data.x, y: data.y, width: 14 }];

    for (const wrapX of wrapOffsetsX) {
      for (const wrapY of wrapOffsetsY) {
        // Render from tail to head so the head draws on top
        for (let i = segments.length - 1; i >= 0; i--) {
          const sx = segments[i].x + wrapX;
          const sy = segments[i].y + wrapY;
          const baseWidth = segments[i].width || 14;

          if (i === 0) {
            this.writeHead(sx, sy, sx, sy, baseWidth, data.direction, wrapX, wrapY, segments, r, g, b);
          } else {
            const radius = Math.max(baseWidth, 15) / 2;
            this.writeCircle(sx, sy, radius, r, g, b);
          }
        }
      }
    }
  }

  // ============================================================
  // Viewport culling — the main "longer snake = slower" fix
  // ============================================================

  private snakeMightBeVisible(snake: RenderSnake): boolean {
    const segs = snake.segments;
    if (segs.length === 0) return true;
    const margin = 60; // bigger than the biggest segment

    // Quick AABB test: scan until we find a segment inside the camera + margin.
    const x0 = this.cameraX - margin;
    const x1 = this.cameraX + this.viewportWidth + margin;
    const y0 = this.cameraY - margin;
    const y1 = this.cameraY + this.viewportHeight + margin;

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      // Head is at i=0
      if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) return true;
      // Also check the wrap-shifted positions
      if (s.x - MAP_SIZE >= x0 && s.x - MAP_SIZE <= x1 && s.y >= y0 && s.y <= y1) return true;
      if (s.x + MAP_SIZE >= x0 && s.x + MAP_SIZE <= x1 && s.y >= y0 && s.y <= y1) return true;
      if (s.x >= x0 && s.x <= x1 && s.y - MAP_SIZE >= y0 && s.y - MAP_SIZE <= y1) return true;
      if (s.x >= x0 && s.x <= x1 && s.y + MAP_SIZE >= y0 && s.y + MAP_SIZE <= y1) return true;
    }
    return false;
  }

  // ============================================================
  // Frame
  // ============================================================

  render() {
    if (!this.device || !this.context || !this.pipeline || !this.vertexBuffer || !this.uniformBuffer) return;

    // Camera follows my snake
    const player = this.players.get(this.myIdentity);
    if (player) {
      this.cameraX = player.x - this.viewportWidth / 2;
      this.cameraY = player.y - this.viewportHeight / 2;
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.orthographicProjection() as any);

    // Reset write cursor for this frame
    this.vertexCursor = 0;
    this.vertexCount = 0;

    // Background
    this.writeQuad(this.cameraX, this.cameraY, this.viewportWidth, this.viewportHeight, 0.08, 0.08, 0.14);

    // Grid
    const gridSize = 40;
    const startX = Math.floor(this.cameraX / gridSize) * gridSize;
    const endX = Math.ceil((this.cameraX + this.viewportWidth) / gridSize) * gridSize;
    const startY = Math.floor(this.cameraY / gridSize) * gridSize;
    const endY = Math.ceil((this.cameraY + this.viewportHeight) / gridSize) * gridSize;
    for (let wx = startX; wx <= endX; wx += gridSize) {
      if (wx >= this.cameraX && wx <= this.cameraX + this.viewportWidth) {
        this.writeQuad(wx - 1, this.cameraY, 2, this.viewportHeight, 0.12, 0.12, 0.18);
      }
    }
    for (let wy = startY; wy <= endY; wy += gridSize) {
      if (wy >= this.cameraY && wy <= this.cameraY + this.viewportHeight) {
        this.writeQuad(this.cameraX, wy - 1, this.viewportWidth, 2, 0.12, 0.12, 0.18);
      }
    }

    // Wrap offsets — only the edges of the map that the camera can see
    const wrapOffsetsX = [0];
    const wrapOffsetsY = [0];
    if (this.cameraX < this.viewportWidth) wrapOffsetsX.push(-MAP_SIZE);
    if (this.cameraX + this.viewportWidth > MAP_SIZE - this.viewportWidth) wrapOffsetsX.push(MAP_SIZE);
    if (this.cameraY < this.viewportHeight) wrapOffsetsY.push(-MAP_SIZE);
    if (this.cameraY + this.viewportHeight > MAP_SIZE - this.viewportHeight) wrapOffsetsY.push(MAP_SIZE);

    // Food — only the ones near the player head get hidden
    const myHead = this.players.get(this.myIdentity);
    const headX = myHead?.x ?? 0;
    const headY = myHead?.y ?? 0;
    const foodSize = 10;
    for (const food of this.foods) {
      if (Math.abs(food.x - headX) < 20 && Math.abs(food.y - headY) < 20) continue;
      for (const wrapX of wrapOffsetsX) {
        for (const wrapY of wrapOffsetsY) {
          const fx = food.x + wrapX;
          const fy = food.y + wrapY;
          if (fx >= this.cameraX - foodSize && fx <= this.cameraX + this.viewportWidth + foodSize &&
              fy >= this.cameraY - foodSize && fy <= this.cameraY + this.viewportHeight + foodSize) {
            const [fr, fg, fb] = this.hexToRgb(food.color);
            this.writeQuad(fx - foodSize / 2, fy - foodSize / 2, foodSize, foodSize, fr, fg, fb);
          }
        }
      }
    }

    // Snakes — cull off-screen ones
    for (const [, snake] of this.players) {
      if (!snake.alive) continue;
      if (!this.snakeMightBeVisible(snake)) continue;
      this.writeSnake(snake, wrapOffsetsX, wrapOffsetsY);
    }

    if (this.vertexCount === 0) return;

    // Guard against overflow
    if (this.vertexCount > MAX_VERTICES) {
      console.warn(`Vertex overflow: ${this.vertexCount} vertices, max ${MAX_VERTICES}. Truncating.`);
      this.vertexCount = MAX_VERTICES;
      this.vertexCursor = MAX_VERTICES * FLOATS_PER_VERTEX;
    }

    // Upload only the used portion
    this.device.queue.writeBuffer(
      this.vertexBuffer,
      0,
      this.vertexData.buffer,
      this.vertexData.byteOffset,
      this.vertexCursor * Float32Array.BYTES_PER_ELEMENT
    );

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{ view: textureView, clearValue: { r: 0.1, g: 0.1, b: 0.18, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup!);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.draw(this.vertexCount, 1, 0, 0);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }
}
