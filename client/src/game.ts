// Game class — owns the SpacetimeDB connection, the database state mirror,
// and the per-frame game loop. Wires together the renderer, UI, input, and
// sound modules.

import { DbConnection, tables } from './module_bindings/index';
import type { SnakeSegment } from './module_bindings/types';

import { COLORS, DB_NAME, SERVER, STORAGE_KEYS } from './config';
import { SoundManager } from './sound';
import { WebGPURenderer, type Food, type RenderSnakes } from './renderer';
import { InputState } from './input';
import { UI } from './ui';

interface PlayerRow {
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

interface BotRow {
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

interface LocalSegment { segmentIndex: number; x: number; y: number; width: number }

export class Game {
  private conn: DbConnection | null = null;
  private renderer: WebGPURenderer | null = null;
  private sound = new SoundManager();
  private input = new InputState();
  private ui = new UI();

  private players = new Map<string, PlayerRow>();
  private playerSegments = new Map<string, LocalSegment[]>();
  private bots = new Map<string, BotRow>();
  private botSegments = new Map<string, LocalSegment[]>();
  private foods: Food[] = [];

  // Client-side interpolation state. The server broadcasts position updates
  // at the game tick rate (~20Hz), and the render loop runs at the display
  // refresh rate (~60Hz). Without smoothing the snake visibly teleports
  // between ticks. We store the last server-authoritative position and a
  // smoothed render position that lerps toward the target each frame.
  // The interpolation horizon is 100ms — enough to span a full server tick
  // plus a small buffer, short enough that the snake still feels responsive.
  private lastServerPositions = new Map<string, { x: number; y: number; direction: number; t: number }>();
  private smoothedPositions = new Map<string, { x: number; y: number; direction: number }>();
  private readonly SMOOTHING_MS = 100;

  private myIdentity = '';
  private myScore = 0;
  private selectedColorIndex = Math.floor(Math.random() * COLORS.length);
  private leaderboardUpdateCounter = 0;
  private directionRefreshInterval: number | null = null;

  async init() {
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('gameCanvas not found');

    // Build the menu UI first — the user can still see/set their name and
    // color even if WebGPU is unavailable, and the renderer failure happens
    // gracefully (the canvas just stays blank) instead of triggering an
    // alert that blocks the page.
    this.ui.buildColorPicker(this.selectedColorIndex, (i) => { this.selectedColorIndex = i; });
    this.ui.attachArrowKeyColorNav(
      () => this.selectedColorIndex,
      (i) => { this.selectedColorIndex = i; }
    );
    this.ui.setupPwaInstallPrompt(() => this.ui.enableLandscapeOrientation());

    this.input.onDirectionChange = () => this.sendDirection();
    this.input.onDash = () => this.activateDash();
    this.input.attach();

    this.setupButtonHandlers();
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resizeCanvas(), 100));

    this.loadSavedName();

    this.renderer = new WebGPURenderer(canvas);
    const ok = await this.renderer.init();
    if (!ok) {
      console.warn('WebGPU not available — the game canvas will stay blank.');
    }

    await this.connectToServer();
    requestAnimationFrame(this.gameLoop);
  }

  // ============================================================
  // Setup helpers
  // ============================================================

  private setupButtonHandlers() {
    document.getElementById('play-btn')?.addEventListener('click', () => this.joinGame());
    document.getElementById('respawn-btn')?.addEventListener('click', () => this.respawn());
    document.getElementById('speaker-icon')?.addEventListener('click', () => this.toggleMute());

    // Enter plays or respawns
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (this.ui.isMenuVisible()) this.joinGame();
      else if (this.ui.isDeathScreenVisible()) this.respawn();
    });
  }

  private loadSavedName() {
    const saved = localStorage.getItem(STORAGE_KEYS.name);
    if (saved) {
      (document.getElementById('name-input') as HTMLInputElement | null) &&
        ((document.getElementById('name-input') as HTMLInputElement).value = saved);
    }
  }

  private resizeCanvas() {
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    this.renderer?.resize(canvas.width, canvas.height);
  }

  // ============================================================
  // Connection
  // ============================================================

  private async connectToServer() {
    const token = localStorage.getItem(STORAGE_KEYS.token) ?? undefined;
    this.conn = DbConnection.builder()
      .withUri(SERVER)
      .withDatabaseName(DB_NAME)
      .withToken(token)
      .onConnect((conn: any, identity: any, newToken: string) => {
        localStorage.setItem(STORAGE_KEYS.token, newToken);
        this.myIdentity = identity.toString();
        this.renderer?.setMyIdentity(this.myIdentity);
        this.ui.setMyIdentity(this.myIdentity);
        this.setupCallbacks();
        this.ui.hideLoading();
        conn.subscriptionBuilder()
          .onApplied(() => {})
          .subscribe([
            tables.player,
            tables.snake_segment,
            tables.bot,
            tables.bot_segment,
            tables.food,
            tables.player_position_event,
            tables.player_joined_event,
            tables.player_died_event,
            tables.bot_died_event,
          ]);
      })
      .onDisconnect(() => {})
      .build();
  }

  // ============================================================
  // Callbacks — keep segment arrays sorted on insert (no per-frame sort)
  // ============================================================

  private setupCallbacks() {
    if (!this.conn) return;
    const c = this.conn;

    c.db.player.onInsert((_ctx, p) => {
      this.players.set(p.identity.toString(), {
        identity: p.identity.toString(),
        name: p.name, color: p.color, x: p.x, y: p.y,
        direction: p.direction, alive: p.alive, score: p.score, length: p.length,
      });
    });

    c.db.player.onUpdate((_ctx, _old, p) => {
      const existing = this.players.get(p.identity.toString());
      if (!existing) return;
      Object.assign(existing, {
        name: p.name, color: p.color, x: p.x, y: p.y,
        direction: p.direction, alive: p.alive, score: p.score, length: p.length,
      });
      if (p.identity.toString() === this.myIdentity && p.score > this.myScore) {
        this.sound.playEatSound();
      }
      if (p.identity.toString() === this.myIdentity) this.myScore = p.score;
    });

    c.db.player.onDelete((_ctx, p) => {
      this.players.delete(p.identity.toString());
      this.playerSegments.delete(p.identity.toString());
      this.ui.removeNameLabel(p.identity.toString());
    });

    c.db.snake_segment.onInsert((_ctx, seg) => {
      const id = seg.ownerIdentity.toString();
      const local: LocalSegment = {
        segmentIndex: seg.segmentIndex,
        x: seg.x, y: seg.y,
        width: (seg as unknown as SnakeSegment).width || 14,
      };
      this.insertSorted(this.playerSegments, id, local);
    });

    c.db.snake_segment.onUpdate((_ctx, _old, seg) => {
      const id = seg.ownerIdentity.toString();
      const segs = this.playerSegments.get(id);
      if (!segs) return;
      const idx = segs.findIndex(s => s.segmentIndex === seg.segmentIndex);
      if (idx < 0) return;
      segs[idx] = {
        segmentIndex: seg.segmentIndex,
        x: seg.x, y: seg.y,
        width: (seg as unknown as SnakeSegment).width || segs[idx].width,
      };
    });

    c.db.bot.onInsert((_ctx, b) => {
      const botId = b.id.toString();
      this.bots.set(botId, {
        id: b.id, name: b.name, color: b.color, x: b.x, y: b.y,
        direction: b.direction, alive: b.alive, score: b.score, length: b.length,
      });
    });

    c.db.bot.onUpdate((_ctx, _old, b) => {
      const existing = this.bots.get(b.id.toString());
      if (!existing) return;
      Object.assign(existing, {
        name: b.name, color: b.color, x: b.x, y: b.y,
        direction: b.direction, alive: b.alive, score: b.score, length: b.length,
      });
    });

    c.db.bot.onDelete((_ctx, b) => {
      const botId = b.id.toString();
      this.bots.delete(botId);
      this.botSegments.delete(botId);
      this.ui.removeNameLabel('bot-' + botId);
    });

    c.db.bot_segment.onInsert((_ctx, seg) => {
      const botId = seg.botId.toString();
      const local: LocalSegment = {
        segmentIndex: seg.segmentIndex,
        x: seg.x, y: seg.y,
        width: seg.width || 14,
      };
      this.insertSorted(this.botSegments, botId, local);
    });

    c.db.bot_segment.onUpdate((_ctx, _old, seg) => {
      const botId = seg.botId.toString();
      const segs = this.botSegments.get(botId);
      if (!segs) return;
      const idx = segs.findIndex(s => s.segmentIndex === seg.segmentIndex);
      if (idx < 0) return;
      segs[idx] = {
        segmentIndex: seg.segmentIndex,
        x: seg.x, y: seg.y,
        width: seg.width || segs[idx].width,
      };
    });

    c.db.food.onInsert((_ctx, f) => {
      this.foods.push({ id: f.id, x: f.x, y: f.y, color: f.color });
    });
    c.db.food.onDelete((_ctx, f) => {
      const idx = this.foods.findIndex(x => x.id === f.id);
      if (idx >= 0) this.foods.splice(idx, 1);
    });

    c.db.player_position_event.onInsert((_ctx, ev) => {
      const p = this.players.get(ev.identity.toString());
      if (p) {
        p.x = ev.x;
        p.y = ev.y;
        p.direction = ev.direction;
      }
      // Record the server-authoritative position with a timestamp so the
      // render loop can lerp toward it over the interpolation window.
      this.lastServerPositions.set(ev.identity.toString(), {
        x: ev.x, y: ev.y, direction: ev.direction, t: performance.now(),
      });
    });

    c.db.player_died_event.onInsert((_ctx, ev) => {
      if (ev.identity.toString() === this.myIdentity) {
        this.handleMyDeath(ev.killerName);
      }
    });

    c.db.bot_died_event.onInsert(() => {});
  }

  // Binary-search insert into a sorted-by-segmentIndex list. New segments
  // usually land at the tail (the snake just grew), so we check there first
  // and fall back to binary search.
  private insertSorted(
    map: Map<string, LocalSegment[]>,
    key: string,
    seg: LocalSegment
  ) {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    const last = list[list.length - 1];
    if (!last || last.segmentIndex < seg.segmentIndex) {
      list.push(seg);
      return;
    }
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].segmentIndex < seg.segmentIndex) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, seg);
  }

  // ============================================================
  // Input → server
  // ============================================================

  private sendDirection() {
    const angle = this.input.recalculateDirection();
    this.conn?.reducers.changeDirection({ direction: angle });
  }

  private activateDash() {
    this.conn?.reducers.activateDash({});
  }

  // ============================================================
  // Join / respawn / die
  // ============================================================

  private joinGame() {
    const name = this.ui.getNameInput();
    localStorage.setItem(STORAGE_KEYS.name, name);
    const color = this.ui.getSelectedColor();

    this.ui.hideMenu();
    this.ui.showLeaderboard();
    this.ui.hideLoading();

    this.sound.startBackgroundMusic();
    this.sound.setMenuMode(false, false);
    this.startDirectionRefresh();

    this.conn?.reducers.joinGame({ name, color });
  }

  private respawn() {
    // Clean up any stale state from the previous life so the renderer and
    // leaderboard don't briefly show a dead snake or duplicate segments.
    this.playerSegments.delete(this.myIdentity);
    this.lastServerPositions.delete(this.myIdentity);
    this.smoothedPositions.delete(this.myIdentity);
    this.ui.removeNameLabel(this.myIdentity);

    this.ui.hideDeathScreen();
    this.ui.showLeaderboard();
    this.ui.showSpeaker();
    this.sound.setMenuMode(false, false);

    const name = this.ui.getNameInput();
    const color = this.ui.getSelectedColor();
    this.conn?.reducers.joinGame({ name, color });

    // Re-attach the keyboard refresh loop defensively. The interval from
    // the initial joinGame should still be running, but a stutter or a
    // future refactor could clear it — better to guarantee it's live after
    // a respawn so the player can steer immediately.
    this.startDirectionRefresh();
  }

  private startDirectionRefresh() {
    if (this.directionRefreshInterval !== null) {
      clearInterval(this.directionRefreshInterval);
    }
    this.directionRefreshInterval = this.input.startKeyboardRefreshLoop(50);
  }

  private handleMyDeath(killerName: string) {
    this.ui.showDeathScreen(killerName, this.myScore);
    this.ui.hideLeaderboard();
    this.ui.hideSpeaker();
    this.sound.playDeathSound();
    this.sound.setMenuMode(false, true);
  }

  private toggleMute() {
    this.sound.toggleMute();
    this.ui.setSpeakerIcon(!this.sound.isMuted());
  }

  // ============================================================
  // Game loop
  // ============================================================

  private gameLoop = () => {
    if (!this.renderer || !this.conn) {
      requestAnimationFrame(this.gameLoop);
      return;
    }

    const now = performance.now();
    const renderSnakes: RenderSnakes = new Map();

    for (const [identity, player] of this.players) {
      if (!player.alive) {
        this.smoothedPositions.delete(identity);
        this.lastServerPositions.delete(identity);
        continue;
      }
      const segs = this.playerSegments.get(identity) ?? [];
      const smoothed = this.computeSmoothedPosition(identity, player, now);
      renderSnakes.set(identity, {
        x: smoothed.x, y: smoothed.y, color: player.color,
        alive: player.alive, direction: smoothed.direction,
        segments: segs.map(s => ({ x: s.x, y: s.y, width: s.width })),
      });
    }

    for (const [botId, bot] of this.bots) {
      if (!bot.alive) {
        this.smoothedPositions.delete('bot-' + botId);
        this.lastServerPositions.delete('bot-' + botId);
        continue;
      }
      const segs = this.botSegments.get(botId) ?? [];
      const key = 'bot-' + botId;
      const smoothed = this.computeSmoothedPosition(key, bot, now);
      renderSnakes.set(key, {
        x: smoothed.x, y: smoothed.y, color: bot.color,
        alive: bot.alive, direction: smoothed.direction,
        segments: segs.map(s => ({ x: s.x, y: s.y, width: s.width })),
      });
    }

    this.renderer.setPlayers(renderSnakes);
    this.renderer.setFoods(this.foods);
    this.renderer.render();

    this.renderSnakeNames(renderSnakes);

    this.leaderboardUpdateCounter++;
    if (this.leaderboardUpdateCounter >= 30) {
      this.leaderboardUpdateCounter = 0;
      this.updateLeaderboard();
    }

    requestAnimationFrame(this.gameLoop);
  };

  // Lerp from the last smoothed position toward the latest server position,
  // using a fixed interpolation window. The first frame after a server
  // update snaps directly to the new position (no rubber-banding on the
  // first tick). For subsequent frames we advance the smoothed position
  // by (frameDelta / SMOOTHING_MS) of the remaining distance.
  private computeSmoothedPosition(
    key: string,
    server: { x: number; y: number; direction: number },
    now: number
  ): { x: number; y: number; direction: number } {
    const last = this.lastServerPositions.get(key);
    let smoothed = this.smoothedPositions.get(key);

    if (!last) {
      // No server update seen yet — just use the current server position.
      const s = smoothed ?? { x: server.x, y: server.y, direction: server.direction };
      this.smoothedPositions.set(key, s);
      return s;
    }

    // The server target is the latest server update, not the live table
    // value. Using the update timestamp (not `now`) keeps the interpolation
    // speed independent of how stale the live value is.
    const age = Math.max(0, now - last.t);
    const t = Math.min(1, age / this.SMOOTHING_MS);

    if (!smoothed) {
      // First frame for this entity — snap to the server position so we
      // don't lerp across the map from (0,0).
      smoothed = { x: last.x, y: last.y, direction: last.direction };
    } else {
      // Shortest-arc interpolation for direction (radians wrap at ±PI).
      let dDir = last.direction - smoothed.direction;
      while (dDir > Math.PI) dDir -= 2 * Math.PI;
      while (dDir < -Math.PI) dDir += 2 * Math.PI;
      smoothed.x += (last.x - smoothed.x) * t;
      smoothed.y += (last.y - smoothed.y) * t;
      smoothed.direction += dDir * t;
    }
    this.smoothedPositions.set(key, smoothed);
    return smoothed;
  }

  private renderSnakeNames(snakes: RenderSnakes) {
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    const players: Array<{ identity: string; name: string; x: number; y: number; direction: number; alive: boolean }> = [];
    for (const [id, s] of snakes) {
      players.push({
        identity: id,
        name: this.lookupName(id),
        x: s.x, y: s.y,
        direction: s.direction,
        alive: s.alive,
      });
    }
    this.ui.updateNameLabels(
      players,
      { x: this.renderer!.cameraX, y: this.renderer!.cameraY },
      { width: this.renderer!.viewportWidth, height: this.renderer!.viewportHeight },
      { width: canvas.width, height: canvas.height }
    );
  }

  private lookupName(identityOrBotId: string): string {
    if (identityOrBotId.startsWith('bot-')) {
      const id = identityOrBotId.slice(4);
      return this.bots.get(id)?.name ?? '';
    }
    return this.players.get(identityOrBotId)?.name ?? '';
  }

  private updateLeaderboard() {
    const entries: Array<{ name: string; score: number; identity?: string }> = [];
    for (const [id, p] of this.players) {
      if (p.alive) entries.push({ name: p.name, score: p.score, identity: id });
    }
    for (const [, b] of this.bots) {
      if (b.alive) entries.push({ name: b.name, score: b.score });
    }
    entries.sort((a, b) => b.score - a.score);
    this.ui.renderLeaderboard(entries, this.myIdentity);
  }
}
