// Game class — owns the SpacetimeDB connection, the database state mirror,
// and the per-frame game loop. Wires together the renderer, UI, input, and
// sound modules.

import { DbConnection, tables } from './module_bindings/index';
import type { SnakeSegment } from './module_bindings/types';

import { COLORS, DB_NAME, MAP_SIZE, SERVER, STORAGE_KEYS } from './config';
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
    // Create the renderer FIRST, then size the canvas/viewport to match
    // the window. The previous order (resizeCanvas before renderer init)
    // made the optional chain `this.renderer?.resize(...)` a no-op, so
    // the viewport stayed at the default 800x600 while the canvas grew
    // to the full window size — every label position computed in
    // viewport coords was then 240+px off from where the head was
    // actually drawn on the canvas.
    this.renderer = new WebGPURenderer(canvas);
    const ok = await this.renderer.init();
    if (!ok) {
      console.warn('WebGPU not available — the game canvas will stay blank.');
    }

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resizeCanvas(), 100));

    this.loadSavedName();

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
      // Record the server position with a timestamp so the render loop
      // can lerp toward it. Without this, `lastServerPositions` stays
      // empty (the server never inserts into player_position_event) and
      // the camera falls back to the raw 20Hz table value, making the
      // world appear to jitter as the camera stair-steps.
      //
      // Critical: also seed the head segment's interpolation entry with
      // the SAME timestamp. The server updates `player.x` and
      // `segments[0].x` in the same transaction but their `onUpdate`
      // callbacks fire at slightly different times. If we don't sync the
      // timestamps, the identity key and the segKey lerp at different
      // rates and the smoothed head position drifts away from the
      // smoothed player position — the label (using one) and the head
      // (using the other) end up in different places, with the label
      // consistently ahead in the snake's direction of movement.
      const now = performance.now();
      this.lastServerPositions.set(p.identity.toString(), {
        x: p.x, y: p.y, direction: p.direction, t: now,
      });
      this.lastServerPositions.set(this.segKey(p.identity.toString(), 0), {
        x: p.x, y: p.y, direction: 0, t: now,
      });
      if (p.identity.toString() === this.myIdentity && p.score > this.myScore) {
        this.sound.playEatSound();
      }
      if (p.identity.toString() === this.myIdentity) this.myScore = p.score;
    });

    c.db.player.onDelete((_ctx, p) => {
      this.players.delete(p.identity.toString());
      this.playerSegments.delete(p.identity.toString());
      this.clearSegmentInterpolation(p.identity.toString());
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
      // Seed the interpolation state for this segment so the first frame
      // after insertion doesn't lerp from (0,0).
      this.lastServerPositions.set(this.segKey(id, seg.segmentIndex), {
        x: seg.x, y: seg.y, direction: 0, t: performance.now(),
      });
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
      // Record the server position with a timestamp so the render loop
      // can lerp the segment toward it. Without this the body stair-steps
      // at 20Hz while the camera (smoothed) glides — the body then appears
      // to jitter relative to the camera.
      this.lastServerPositions.set(this.segKey(id, seg.segmentIndex), {
        x: seg.x, y: seg.y, direction: 0, t: performance.now(),
      });
    });

    c.db.snake_segment.onDelete((_ctx, seg) => {
      const id = seg.ownerIdentity.toString();
      this.lastServerPositions.delete(this.segKey(id, seg.segmentIndex));
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
      // Same rationale as player.onUpdate: keep lastServerPositions in sync
      // so bot motion (and the camera, when following a bot) is smoothed.
      // Also seed the bot's head segment interpolation entry with the same
      // timestamp to keep the label anchored to the head's actual position.
      const now = performance.now();
      const botKey = 'bot-' + b.id.toString();
      this.lastServerPositions.set(botKey, {
        x: b.x, y: b.y, direction: b.direction, t: now,
      });
      this.lastServerPositions.set(this.segKey(botKey, 0), {
        x: b.x, y: b.y, direction: 0, t: now,
      });
    });

    c.db.bot.onDelete((_ctx, b) => {
      const botId = b.id.toString();
      this.bots.delete(botId);
      this.botSegments.delete(botId);
      this.clearSegmentInterpolation('bot-' + botId);
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
      this.lastServerPositions.set(this.segKey('bot-' + botId, seg.segmentIndex), {
        x: seg.x, y: seg.y, direction: 0, t: performance.now(),
      });
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
      this.lastServerPositions.set(this.segKey('bot-' + botId, seg.segmentIndex), {
        x: seg.x, y: seg.y, direction: 0, t: performance.now(),
      });
    });

    c.db.bot_segment.onDelete((_ctx, seg) => {
      this.lastServerPositions.delete(this.segKey('bot-' + seg.botId.toString(), seg.segmentIndex));
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

  // Unique key for a single segment in the interpolation state map.
  // Keeps player and bot segment positions out of each other's way and
  // out of the way of the snake-head entries (which use the plain
  // identity or 'bot-<id>').
  private segKey(ownerKey: string, segmentIndex: number): string {
    return `seg-${ownerKey}-${segmentIndex}`;
  }

  // Drop every interpolation entry that belongs to one snake. Called on
  // player/bot deletion and on respawn so stale segment positions don't
  // leak into the next life. Must clear BOTH maps — if smoothedPositions
  // keeps a stale entry for a segment index, the next segment inserted
  // at that index will lerp from the old snake's position (often across
  // the map) to the new one over 100ms, looking like the segment "flies
  // in" from nowhere.
  private clearSegmentInterpolation(ownerKey: string) {
    const prefix = `seg-${ownerKey}-`;
    for (const key of this.lastServerPositions.keys()) {
      if (key.startsWith(prefix)) this.lastServerPositions.delete(key);
    }
    for (const key of this.smoothedPositions.keys()) {
      if (key.startsWith(prefix)) this.smoothedPositions.delete(key);
    }
  }

  // Wrap a coordinate into [0, MAP_SIZE). Mirrors the server's wrapCoord
  // so the client's smoothed positions stay canonical. The fast path
  // avoids the (relatively expensive) modulo for the overwhelmingly
  // common case where the value is already in bounds.
  private wrapCoord(v: number): number {
    if (v >= 0 && v < MAP_SIZE) return v;
    return ((v % MAP_SIZE) + MAP_SIZE) % MAP_SIZE;
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
    this.clearSegmentInterpolation(this.myIdentity);
    this.smoothedPositions.delete(this.myIdentity);
    this.lastServerPositions.delete(this.myIdentity);
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

      // Viewport culling: skip the per-segment Map lookups and lerp math
      // for snakes that are clearly off-screen. The renderer also culls
      // these (snakeMightBeVisible), so passing through the raw server
      // positions is visually identical — the snake never gets drawn.
      // The margin covers a long snake's tail even when its head has
      // just left the viewport.
      const cam = this.renderer;
      if (cam) {
        const hx = player.x;
        const hy = player.y;
        const margin = 500;
        if (hx < cam.cameraX - margin || hx > cam.cameraX + cam.viewportWidth + margin ||
            hy < cam.cameraY - margin || hy > cam.cameraY + cam.viewportHeight + margin) {
          renderSnakes.set(identity, {
            x: player.x, y: player.y, color: player.color,
            alive: player.alive, direction: player.direction,
            segments: segs.map(s => ({ x: s.x, y: s.y, width: s.width })),
          });
          continue;
        }
      }

      const smoothed = this.computeSmoothedPosition(identity, player, now);
      // Smooth every segment too. The head drives the camera; if the
      // body stair-steps at 20Hz while the camera glides smoothly, the
      // snake looks like it's shuddering.
      const smoothedSegs = segs.map(s => {
        const sm = this.computeSmoothedPosition(
          this.segKey(identity, s.segmentIndex),
          { x: s.x, y: s.y, direction: 0 },
          now
        );
        return { x: sm.x, y: sm.y, width: s.width };
      });
      renderSnakes.set(identity, {
        x: smoothed.x, y: smoothed.y, color: player.color,
        alive: player.alive, direction: smoothed.direction,
        segments: smoothedSegs,
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

      // Same viewport culling as the player loop above.
      const cam = this.renderer;
      if (cam) {
        const hx = bot.x;
        const hy = bot.y;
        const margin = 500;
        if (hx < cam.cameraX - margin || hx > cam.cameraX + cam.viewportWidth + margin ||
            hy < cam.cameraY - margin || hy > cam.cameraY + cam.viewportHeight + margin) {
          renderSnakes.set(key, {
            x: bot.x, y: bot.y, color: bot.color,
            alive: bot.alive, direction: bot.direction,
            segments: segs.map(s => ({ x: s.x, y: s.y, width: s.width })),
          });
          continue;
        }
      }

      const smoothed = this.computeSmoothedPosition(key, bot, now);
      const smoothedSegs = segs.map(s => {
        const sm = this.computeSmoothedPosition(
          this.segKey(key, s.segmentIndex),
          { x: s.x, y: s.y, direction: 0 },
          now
        );
        return { x: sm.x, y: sm.y, width: s.width };
      });
      renderSnakes.set(key, {
        x: smoothed.x, y: smoothed.y, color: bot.color,
        alive: bot.alive, direction: smoothed.direction,
        segments: smoothedSegs,
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
      // No position-event updates have arrived for this entity yet, so
      // there is nothing to interpolate toward. Fall through to the live
      // server position (which is kept fresh by player.onUpdate / bot.onUpdate
      // every game tick) — NOT a cached smoothed value, which would be
      // stale by exactly one frame and would freeze the camera.
      const s = { x: server.x, y: server.y, direction: server.direction };
      this.smoothedPositions.set(key, s);
      return s;
    }

    // Shortest-path interpolation across the map wrap. The map is
    // MAP_SIZE×MAP_SIZE and positions wrap at the edges, so a segment
    // moving from x=1990 to x=10 has only traveled 20 units — but a raw
    // lerp would drag it across 1980 units of the map. We adjust the
    // target to the wrapped equivalent that's closest to the current
    // smoothed position so the lerp takes the short way around.
    //
    // The difference is bounded by MAP_SIZE, so each branch fires at
    // most once — if/else is faster than the equivalent while loop and
    // avoids the branch-prediction cost of a loop that almost never
    // iterates.
    let adjX = last.x;
    let adjY = last.y;
    if (smoothed) {
      const dx = adjX - smoothed.x;
      if (dx > MAP_SIZE / 2) adjX -= MAP_SIZE;
      else if (dx < -MAP_SIZE / 2) adjX += MAP_SIZE;
      const dy = adjY - smoothed.y;
      if (dy > MAP_SIZE / 2) adjY -= MAP_SIZE;
      else if (dy < -MAP_SIZE / 2) adjY += MAP_SIZE;
    }

    // The server target is the latest server update, not the live table
    // value. Using the update timestamp (not `now`) keeps the interpolation
    // speed independent of how stale the live value is.
    const age = Math.max(0, now - last.t);
    const t = Math.min(1, age / this.SMOOTHING_MS);

    if (!smoothed) {
      // First frame for this entity — snap to (the wrapped equivalent of)
      // the server position so we don't lerp across the map from (0,0).
      smoothed = {
        x: this.wrapCoord(adjX),
        y: this.wrapCoord(adjY),
        direction: last.direction,
      };
    } else {
      smoothed.x += (adjX - smoothed.x) * t;
      smoothed.y += (adjY - smoothed.y) * t;
      // Direction lerp: segments store direction=0 and never need it,
      // and the head only needs it while turning. Skip the shortest-arc
      // work entirely when the direction hasn't changed.
      if (last.direction !== smoothed.direction) {
        let dDir = last.direction - smoothed.direction;
        while (dDir > Math.PI) dDir -= 2 * Math.PI;
        while (dDir < -Math.PI) dDir += 2 * Math.PI;
        smoothed.direction += dDir * t;
      }
    }

    // Wrap fast path: most values are already in [0, MAP_SIZE) after the
    // lerp, so check before reaching for the modulo.
    if (smoothed.x < 0 || smoothed.x >= MAP_SIZE) smoothed.x = this.wrapCoord(smoothed.x);
    if (smoothed.y < 0 || smoothed.y >= MAP_SIZE) smoothed.y = this.wrapCoord(smoothed.y);

    this.smoothedPositions.set(key, smoothed);
    return smoothed;
  }

  private renderSnakeNames(snakes: RenderSnakes) {
    const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
    const renderer = this.renderer!;
    const cameraX = renderer.cameraX;
    const cameraY = renderer.cameraY;
    const viewportW = renderer.viewportWidth;
    const viewportH = renderer.viewportHeight;

    // Match the renderer's wrap offsets exactly. The renderer draws each
    // snake at multiple wrap offsets (0, ±MAP_SIZE) so a snake near one
    // edge of the map can also be drawn at the other edge when the camera
    // is near that edge. The label must use the SAME wrap offset the
    // rendered head actually uses — otherwise a snake whose head appears
    // at screenX=-210 (the wrap of X=1990 when the camera is near the
    // left edge) would have its label drawn at screenX=1790 (off-screen
    // right) and the two would never agree.
    const wrapOffsetsX = [0];
    const wrapOffsetsY = [0];
    if (cameraX < viewportW) wrapOffsetsX.push(-MAP_SIZE);
    if (cameraX + viewportW > MAP_SIZE - viewportW) wrapOffsetsX.push(MAP_SIZE);
    if (cameraY < viewportH) wrapOffsetsY.push(-MAP_SIZE);
    if (cameraY + viewportH > MAP_SIZE - viewportH) wrapOffsetsY.push(MAP_SIZE);

    const players: Array<{ identity: string; name: string; screenX: number; screenY: number; alive: boolean }> = [];
    for (const [id, s] of snakes) {
      if (!s.alive) continue;

      const headSeg = s.segments[0];
      if (!headSeg) continue;

      // Compute the head angle from head->next-segment with MAP_SIZE
      // wrap handling, matching the renderer's writeHead. The +π flips
      // the angle because the head points away from the body.
      let angle = s.direction;
      if (s.segments.length > 1) {
        const next = s.segments[1];
        let nx = next.x;
        let ny = next.y;
        const dx0 = nx - headSeg.x;
        const dy0 = ny - headSeg.y;
        if (Math.abs(dx0) > MAP_SIZE / 2) nx += (dx0 > 0 ? -MAP_SIZE : MAP_SIZE);
        if (Math.abs(dy0) > MAP_SIZE / 2) ny += (dy0 > 0 ? -MAP_SIZE : MAP_SIZE);
        const dx = nx - headSeg.x;
        const dy = ny - headSeg.y;
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
          angle = Math.atan2(dy, dx) + Math.PI;
        }
      }

      // The renderer's head is drawn at the head segment's world position
      // shifted forward by `headLength * 0.3` in the direction of movement.
      // The headLength depends on the segment's baseWidth (default 14),
      // so we need to use the same value the renderer uses or the label
      // and the head will sit at slightly different world positions.
      const headBaseWidth = headSeg.width || 14;
      const headShift = (headBaseWidth + 6) * 0.3;
      const headRenderedX = headSeg.x + Math.cos(angle) * headShift;
      const headRenderedY = headSeg.y + Math.sin(angle) * headShift;

      // Pick the wrap offset that puts the head closest to the camera
      // center — this is the copy the renderer actually drew and the
      // one the user can see. When the camera is in the middle of the
      // map, only wrap=0 is in wrapOffsetsX/Y, so we always pick the
      // unwrapped position (which is what the renderer draws).
      let bestScreenX = 0;
      let bestScreenY = 0;
      let bestDist = Infinity;
      for (const wrapX of wrapOffsetsX) {
        for (const wrapY of wrapOffsetsY) {
          const sx = headRenderedX + wrapX - cameraX;
          const sy = headRenderedY + wrapY - cameraY;
          const dx = sx - viewportW / 2;
          const dy = sy - viewportH / 2;
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestScreenX = sx;
            bestScreenY = sy;
          }
        }
      }

      players.push({
        identity: id,
        name: this.lookupName(id),
        screenX: bestScreenX,
        screenY: bestScreenY,
        alive: s.alive,
      });
    }
    this.ui.updateNameLabels(
      players,
      { width: viewportW, height: viewportH },
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
