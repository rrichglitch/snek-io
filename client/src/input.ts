// Input handling: keyboard, mouse, touch.
// Tracks pressed keys, cursor position, and the most-recent input source.
// Exposes a single `getDirectionAngle()` for the game loop.

type InputType = 'keyboard' | 'mouse' | 'touch';

const KEYBOARD_DIRECTION_CODES = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
];

export class InputState {
  private pressedKeys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private lastInputType: InputType = 'keyboard';
  private currentDirectionAngle = 0;
  private lastTapTime = 0;

  // Fires on dash trigger (space, double-click, double-tap)
  onDash: (() => void) | null = null;
  // Fires whenever the user does something that should refresh the direction
  onDirectionChange: (() => void) | null = null;

  attach() {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleWindowBlur);
    window.addEventListener('mousemove', this.handleMouseMove);
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
    if (canvas) {
      canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
      canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
      canvas.addEventListener('touchend', this.handleTouchEnd);
      canvas.addEventListener('touchcancel', this.handleTouchEnd);
      canvas.addEventListener('dblclick', this.handleDblClick);
    }
  }

  detach() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleWindowBlur);
    window.removeEventListener('mousemove', this.handleMouseMove);
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
    if (canvas) {
      canvas.removeEventListener('touchstart', this.handleTouchStart);
      canvas.removeEventListener('touchmove', this.handleTouchMove);
      canvas.removeEventListener('touchend', this.handleTouchEnd);
      canvas.removeEventListener('touchcancel', this.handleTouchEnd);
      canvas.removeEventListener('dblclick', this.handleDblClick);
    }
  }

  // Start a 20Hz tick to keep the direction fresh even if the user is just
  // holding a key (no further key events fire after the first one).
  startKeyboardRefreshLoop(intervalMs: number = 50) {
    return window.setInterval(() => {
      if (this.lastInputType === 'keyboard' && this.pressedKeys.size > 0) {
        this.onDirectionChange?.();
      }
    }, intervalMs);
  }

  currentAngle(): number { return this.currentDirectionAngle; }

  // ============================================================
  // Handlers
  // ============================================================

  private handleKeyDown = (e: KeyboardEvent) => {
    // Space = dash
    if (e.code === 'Space') {
      e.preventDefault();
      this.onDash?.();
      return;
    }

    if (!KEYBOARD_DIRECTION_CODES.includes(e.code)) return;

    this.pressedKeys.add(e.code);
    this.lastInputType = 'keyboard';
    this.onDirectionChange?.();
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    if (!this.pressedKeys.delete(e.code)) return;
    if (this.lastInputType === 'keyboard') {
      this.onDirectionChange?.();
    }
  };

  private handleWindowBlur = () => this.pressedKeys.clear();

  private handleMouseMove = (e: MouseEvent) => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.lastInputType = 'mouse';
    this.onDirectionChange?.();
  };

  private handleTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    const now = Date.now();
    if (now - this.lastTapTime < 300) this.onDash?.();
    this.lastTapTime = now;

    if (e.touches.length > 0) {
      this.mouseX = e.touches[0].clientX;
      this.mouseY = e.touches[0].clientY;
      this.lastInputType = 'touch';
      this.onDirectionChange?.();
    }
  };

  private handleTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length > 0) {
      this.mouseX = e.touches[0].clientX;
      this.mouseY = e.touches[0].clientY;
      this.lastInputType = 'touch';
      this.onDirectionChange?.();
    }
  };

  private handleTouchEnd = () => { /* keep last direction */ };

  private handleDblClick = () => this.onDash?.();

  // ============================================================
  // Direction calculation
  // ============================================================

  recalculateDirection(): number {
    let newAngle: number;
    if (this.lastInputType === 'keyboard') {
      newAngle = this.keyboardAngle();
    } else {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      newAngle = Math.atan2(this.mouseY - cy, this.mouseX - cx);
    }

    // Throttle: only update if the angle changed by more than 0.01 rad (~0.57°)
    if (Math.abs(newAngle - this.currentDirectionAngle) > 0.01) {
      this.currentDirectionAngle = newAngle;
    }
    return this.currentDirectionAngle;
  }

  private keyboardAngle(): number {
    const up    = this.pressedKeys.has('ArrowUp')    || this.pressedKeys.has('KeyW');
    const down  = this.pressedKeys.has('ArrowDown')  || this.pressedKeys.has('KeyS');
    const left  = this.pressedKeys.has('ArrowLeft')  || this.pressedKeys.has('KeyA');
    const right = this.pressedKeys.has('ArrowRight') || this.pressedKeys.has('KeyD');

    const netX = (right ? 1 : 0) - (left ? 1 : 0);
    const netY = (down ? 1 : 0) - (up ? 1 : 0);
    if (netX === 0 && netY === 0) return this.currentDirectionAngle;
    return Math.atan2(netY, netX);
  }
}
