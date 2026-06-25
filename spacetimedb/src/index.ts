import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// ============================================================
// Constants
// ============================================================

const MAP_SIZE = 2000;
const INITIAL_SNAKE_LENGTH = 4;
const MAX_FOOD = 200;
const MOVE_SPEED = 14.0;
const SEGMENT_SPACING = 18;
const TICK_INTERVAL_US = 50000n;
const MIN_SNAKES = 10;

const DASH_DURATION_MS = 500n;
const DASH_COOLDOWN_MS = 2500n;
const DASH_MULTIPLIER = 3;

// 90° dead zone around the 180° reverse — max turn per tick is 135°.
const MAX_TURN_ANGLE = Math.PI - Math.PI / 4;

const COLORS = [
  '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#FFB347',
  '#87CEEB', '#DDA0DD', '#98FB98', '#F0E68C',
  '#FFA07A', '#20B2AA', '#778899', '#B19CD9',
  '#5F9EA0', '#7FFFD4', '#6495ED', '#DDA0DD',
];

const BOT_NAMES = [
  'SlitherBot', 'PythonAI', 'NoodleBrain', 'CobraAI', 'ViperBot',
  'HissyFit', 'SerpentAI', 'AnacondaBot', 'RattlerAI', 'BoaBrain',
  'Copperhead', 'MambaMind', 'VineSnake', 'CornSnek', 'KingCobra',
];

// ============================================================
// Helpers
// ============================================================

function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

function wrapCoord(v: number): number {
  if (v < 0) return v + MAP_SIZE;
  if (v >= MAP_SIZE) return v - MAP_SIZE;
  return v;
}

function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// ============================================================
// Bot AI
// ============================================================

function chooseBotDirection(
  bot: any,
  foods: any[],
  botSegmentsCache: Map<bigint, any[]>,
  playerSegmentsCache: Map<string, any[]>,
  allBots: any[],
  allPlayers: any[]
): number {
  const headX = bot.x;
  const headY = bot.y;
  const currentDir = bot.direction;
  const ownSegments = botSegmentsCache.get(bot.id) ?? [];

  // Find nearest food
  let nearestFood: any = null;
  let nearestFoodDist = Infinity;
  for (const food of foods) {
    const d = distSq(food.x, food.y, headX, headY);
    if (d < nearestFoodDist) {
      nearestFoodDist = d;
      nearestFood = food;
    }
  }

  let desiredDir = currentDir;
  if (nearestFood) {
    desiredDir = Math.atan2(nearestFood.y - headY, nearestFood.x - headX);
  }

  // Check for collisions at a given angle
  const checkCollision = (angle: number, distance: number = MOVE_SPEED * 3) => {
    const checkX = headX + Math.cos(angle) * distance;
    const checkY = headY + Math.sin(angle) * distance;
    const collisionDistSq = 30 * 30;

    // Self-collision (skip head + neck)
    for (let i = 4; i < ownSegments.length; i++) {
      if (distSq(ownSegments[i].x, ownSegments[i].y, checkX, checkY) < collisionDistSq) {
        return true;
      }
    }

    // Player segments
    for (const player of allPlayers) {
      if (!player.alive) continue;
      const segs = playerSegmentsCache.get(player.identity.toString());
      if (!segs) continue;
      for (let i = 1; i < segs.length; i++) {
        if (distSq(segs[i].x, segs[i].y, checkX, checkY) < collisionDistSq) {
          return true;
        }
      }
    }

    // Other bot segments
    for (const otherBot of allBots) {
      if (otherBot.id === bot.id || !otherBot.alive) continue;
      const segs = botSegmentsCache.get(otherBot.id);
      if (!segs) continue;
      for (let i = 1; i < segs.length; i++) {
        if (distSq(segs[i].x, segs[i].y, checkX, checkY) < collisionDistSq) {
          return true;
        }
      }
    }

    return false;
  };

  // Try desired direction first
  if (!checkCollision(desiredDir)) return desiredDir;

  // Try 90° offsets (skip 180° turns)
  for (const offset of [Math.PI / 2, -Math.PI / 2]) {
    const testAngle = desiredDir + offset;
    const turnDiff = Math.abs(normalizeAngle(testAngle - currentDir));
    if (turnDiff > Math.PI * 0.9 && turnDiff < Math.PI * 1.1) continue;
    if (!checkCollision(testAngle)) return testAngle;
  }

  // Look ahead in current direction for imminent collision
  for (let dist = 1; dist <= 5; dist++) {
    const testX = headX + Math.cos(currentDir) * dist * MOVE_SPEED;
    const testY = headY + Math.sin(currentDir) * dist * MOVE_SPEED;
    for (let i = 4; i < ownSegments.length; i++) {
      if (distSq(ownSegments[i].x, ownSegments[i].y, testX, testY) < 25 * 25) {
        if (dist <= 3) {
          // Find any escape angle
          for (let j = 0; j < 8; j++) {
            const escapeAngle = (j / 8) * Math.PI * 2;
            const turnDiff = Math.abs(normalizeAngle(escapeAngle - currentDir));
            if (turnDiff > Math.PI * 0.9 && turnDiff < Math.PI * 1.1) continue;
            if (!checkCollision(escapeAngle)) return escapeAngle;
          }
        }
        break;
      }
    }
  }

  return currentDir;
}

// ============================================================
// Tables
// ============================================================

const Player = table(
  { name: 'player', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    color: t.string(),
    score: t.u32(),
    length: t.u32(),
    direction: t.f32(),
    // btree index on alive lets the tick reducer do
    // ctx.db.player.alive.filter(true) instead of
    // [...ctx.db.player.iter()].filter(p => p.alive). The
    // tick fires 20 Hz; without the index we materialize the
    // full player table on every tick just to skip dead rows.
    alive: t.bool().index('btree'),
    x: t.f32(),
    y: t.f32(),
    pending_direction: t.f32(),
    is_dashing: t.bool().default(false),
    dash_end_time: t.u64().default(0n),
    dash_cooldown_end: t.u64().default(0n),
  }
);

const SnakeSegment = table(
  { name: 'snake_segment', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    // btree index on owner_identity turns the per-player cleanup paths
    // in join_game / leave_game / on_disconnect from O(total segments)
    // full-table scans into O(segments owned by that player) seeks.
    // snake_segment is the largest, fastest-growing table, so this is
    // the single biggest bytes-scanned win in the module.
    owner_identity: t.identity().index('btree'),
    segment_index: t.u32(),
    x: t.f32(),
    y: t.f32(),
    width: t.f32().default(14.0),
  }
);

const Bot = table(
  { name: 'bot', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    color: t.string(),
    score: t.u32(),
    length: t.u32(),
    direction: t.f32(),
    // Same rationale as Player.alive. 10 bots are kept alive
    // by the MIN_SNAKES top-up, so this index stays warm and
    // every tick's alive-bots read is cheap.
    alive: t.bool().index('btree'),
    x: t.f32(),
    y: t.f32(),
    pending_direction: t.f32(),
    is_dashing: t.bool().default(false),
    dash_end_time: t.u64().default(0n),
    dash_cooldown_end: t.u64().default(0n),
  }
);

const BotSegment = table(
  { name: 'bot_segment', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    // Same rationale as SnakeSegment.owner_identity. No current code
    // path scans bot_segment by bot_id (the AI uses the in-memory
    // cache), but this is cheap insurance and makes any future
    // "delete all segments for bot X" call O(K) instead of O(N).
    bot_id: t.u64().index('btree'),
    segment_index: t.u32(),
    x: t.f32(),
    y: t.f32(),
    width: t.f32().default(14.0),
  }
);

const Food = table(
  { name: 'food', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    x: t.f32(),
    y: t.f32(),
    color: t.string(),
  }
);

// PlayerPositionEvent was originally the high-frequency position
// broadcast for client interpolation. The server never inserts
// into it (snake head positions move via snake_segment updates
// instead), and the client's onInsert handler is a no-op. Removed
// to drop the per-connection subscription overhead and the
// small "Index Key Data Storage" tax on a table that never had
// rows.

const PlayerDiedEvent = table(
  { name: 'player_died_event', public: true, event: true },
  {
    identity: t.identity(),
    killer_name: t.string(),
  }
);

const PlayerJoinedEvent = table(
  { name: 'player_joined_event', public: true, event: true },
  {
    identity: t.identity(),
    name: t.string(),
    color: t.string(),
    x: t.f32(),
    y: t.f32(),
  }
);

const BotDiedEvent = table(
  { name: 'bot_died_event', public: true, event: true },
  {
    bot_id: t.u64(),
    killer_name: t.string(),
  }
);

let tickReducer: any;

const GameTick = table(
  { name: 'game_tick', scheduled: () => tickReducer },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  }
);

// Singleton flag table that gates the tick reducer's self-reschedule.
// When `paused = true`, the tick runs its work but does NOT insert
// the next scheduled row, breaking the chain. Used by on_disconnect
// and stop_world_tick to atomically stop the 20 Hz tick.
const WorldPaused = table(
  { name: 'world_paused', public: false },
  {
    singleton: t.bool().primaryKey(),
    paused: t.bool(),
  }
);

const spacetimedb = schema({
  player: Player,
  snake_segment: SnakeSegment,
  bot: Bot,
  bot_segment: BotSegment,
  food: Food,
  player_died_event: PlayerDiedEvent,
  player_joined_event: PlayerJoinedEvent,
  bot_died_event: BotDiedEvent,
  game_tick: GameTick,
  world_paused: WorldPaused,
});

// ============================================================
// Snake factory — creates the initial segments for a new snake
// ============================================================

type SnakeRow = {
  // Common shape; the row's ID column is identity (player) or id (bot)
  name: string;
  color: string;
  score: number;
  length: number;
  direction: number;
  alive: boolean;
  x: number;
  y: number;
  pending_direction: number;
  is_dashing: boolean;
  dash_end_time: bigint;
  dash_cooldown_end: bigint;
};

function spawnInitialSegments(
  ctx: any,
  kind: 'player' | 'bot',
  ownerKey: any,
  dir: number,
  pos: { x: number; y: number },
  baseWidth: number
) {
  for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
    const offsetX = -Math.cos(dir) * i * SEGMENT_SPACING;
    const offsetY = -Math.sin(dir) * i * SEGMENT_SPACING;
    if (kind === 'player') {
      ctx.db.snake_segment.insert({
        id: 0n,
        owner_identity: ownerKey,
        segment_index: i,
        x: pos.x + offsetX,
        y: pos.y + offsetY,
        width: baseWidth,
      });
    } else {
      ctx.db.bot_segment.insert({
        id: 0n,
        bot_id: ownerKey,
        segment_index: i,
        x: pos.x + offsetX,
        y: pos.y + offsetY,
        width: baseWidth,
      });
    }
  }
}

function insertSnakeRow(ctx: any, kind: 'player' | 'bot', row: any): any {
  return kind === 'player'
    ? ctx.db.player.insert(row)
    : ctx.db.bot.insert(row);
}

function getRandomPosition(ctx: any): { x: number; y: number } {
  return { x: ctx.random() * MAP_SIZE, y: ctx.random() * MAP_SIZE };
}

// ============================================================
// Reducers
// ============================================================

export const join_game = spacetimedb.reducer(
  { name: t.string(), color: t.string() },
  (ctx: any, { name, color }: { name: string; color: string }) => {
    const sender = ctx.sender;

    // Respawn path: if the player already exists (killed, not disconnected),
    // the previous version of this reducer bailed out and the player stayed
    // dead. Drop the dead row + any orphan segments so the insert below
    // creates a fresh snake. Clients see onDelete → onInsert and rebuild
    // local state from scratch.
    const existing = ctx.db.player.identity.find(sender);
    if (existing) {
      // Indexed lookup: O(segments owned by sender) instead of
      // O(total snake_segment rows). Disconnects / respawns are a
      // constant background rate on a public web game, so this
      // loop is by far the biggest contributor to bytes-scanned.
      for (const seg of ctx.db.snake_segment.owner_identity.filter(sender)) {
        ctx.db.snake_segment.id.delete(seg.id);
      }
      ctx.db.player.identity.delete(sender);
    }

    const pos = getRandomPosition(ctx);
    const dir = ctx.random() * Math.PI * 2;

    ctx.db.player.insert({
      identity: sender,
      name,
      color,
      score: 0,
      length: INITIAL_SNAKE_LENGTH,
      direction: dir,
      alive: true,
      x: pos.x,
      y: pos.y,
      pending_direction: dir,
      is_dashing: false,
      dash_end_time: 0n,
      dash_cooldown_end: 0n,
    });

    spawnInitialSegments(ctx, 'player', sender, dir, pos, 18.0);

    ctx.db.player_joined_event.insert({
      identity: sender,
      name,
      color,
      x: pos.x,
      y: pos.y,
    });

    // Arm the tick. This is the canonical "a real player has
    // entered the world" signal — on_connect alone is not enough
    // because it also fires for spectators and background tabs.
    ensureTickScheduled(ctx);
  }
);

export const change_direction = spacetimedb.reducer(
  { direction: t.f32() },
  (ctx: any, { direction }: { direction: number }) => {
    const player = ctx.db.player.identity.find(ctx.sender);
    if (!player || !player.alive) return;

    // Clamp to max allowed turn (no 180° flips)
    let angleDiff = normalizeAngle(direction - player.direction);
    if (Math.abs(angleDiff) > MAX_TURN_ANGLE) {
      angleDiff = angleDiff > 0 ? MAX_TURN_ANGLE : -MAX_TURN_ANGLE;
      direction = player.direction + angleDiff;
    }

    ctx.db.player.identity.update({ ...player, pending_direction: direction });
  }
);

export const activateDash = spacetimedb.reducer((ctx: any) => {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player || !player.alive || player.is_dashing) return;

  const now = BigInt(Date.now());
  if (now < player.dash_cooldown_end) return;

  ctx.db.player.identity.update({
    ...player,
    is_dashing: true,
    dash_end_time: now + DASH_DURATION_MS,
    dash_cooldown_end: now + DASH_DURATION_MS + DASH_COOLDOWN_MS,
  });
});

export const leave_game = spacetimedb.reducer((ctx: any) => {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) return;

  // Indexed lookup — see join_game for the same fix.
  for (const seg of ctx.db.snake_segment.owner_identity.filter(ctx.sender)) {
    ctx.db.snake_segment.id.delete(seg.id);
  }
  ctx.db.player.identity.delete(ctx.sender);
});

// ============================================================
// Bot spawning
// ============================================================

function spawnBot(ctx: any) {
  const pos = getRandomPosition(ctx);
  const dir = ctx.random() * Math.PI * 2;
  const name = BOT_NAMES[Math.floor(ctx.random() * BOT_NAMES.length)];
  const color = COLORS[Math.floor(ctx.random() * COLORS.length)];

  const bot = ctx.db.bot.insert({
    id: 0n,
    name,
    color,
    score: 0,
    length: INITIAL_SNAKE_LENGTH,
    direction: dir,
    alive: true,
    x: pos.x,
    y: pos.y,
    pending_direction: dir,
    is_dashing: false,
    dash_end_time: 0n,
    dash_cooldown_end: 0n,
  });

  spawnInitialSegments(ctx, 'bot', bot.id, dir, pos, 14.0);
  return bot;
}

function spawnInitialFood(ctx: any, count: number) {
  for (let i = 0; i < count; i++) {
    const pos = getRandomPosition(ctx);
    ctx.db.food.insert({
      id: 0n,
      x: pos.x,
      y: pos.y,
      color: COLORS[Math.floor(ctx.random() * COLORS.length)],
    });
  }
}

function getClusterFoodPositions(ctx: any, count: number): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  const clusterX = ctx.random() * (MAP_SIZE - 200) + 100;
  const clusterY = ctx.random() * (MAP_SIZE - 200) + 100;

  if (ctx.random() < 0.5) {
    const angle = ctx.random() * Math.PI * 2;
    const spacing = 20 + ctx.random() * 15;
    for (let i = 0; i < count; i++) {
      const offset = i * spacing;
      positions.push({
        x: clusterX + Math.cos(angle) * offset,
        y: clusterY + Math.sin(angle) * offset,
      });
    }
  } else {
    for (let i = 0; i < count; i++) {
      const angle = ctx.random() * Math.PI * 2;
      const dist = ctx.random() * 80;
      positions.push({
        x: clusterX + Math.cos(angle) * dist,
        y: clusterY + Math.sin(angle) * dist,
      });
    }
  }

  return positions;
}

// ============================================================
// Snake death — collapses 5 copies of the same cleanup
// ============================================================

function killSnake(
  ctx: any,
  kind: 'player' | 'bot',
  snake: any,
  segments: any[],
  killerName: string
) {
  if (kind === 'player') {
    ctx.db.player_died_event.insert({ identity: snake.identity, killer_name: killerName });
    ctx.db.player.identity.update({ ...snake, alive: false, score: 0 });
  } else {
    ctx.db.bot_died_event.insert({ bot_id: snake.id, killer_name: killerName });
    ctx.db.bot.id.update({ ...snake, alive: false, score: 0 });
  }

  // Drop every third segment as food, delete the rest
  for (let i = 0; i < segments.length; i++) {
    if (i % 3 === 0) {
      ctx.db.food.insert({ id: 0n, x: segments[i].x, y: segments[i].y, color: '#FF6B6B' });
    }
    if (kind === 'player') {
      ctx.db.snake_segment.id.delete(segments[i].id);
    } else {
      ctx.db.bot_segment.id.delete(segments[i].id);
    }
  }
}

// ============================================================
// Shared snake movement (used by both player and bot branches)
// ============================================================

interface MoveContext {
  ctx: any;
  now: bigint;
  foods: any[];
  playerSegments: Map<string, any[]>;
  botSegments: Map<bigint, any[]>;
  alivePlayers: any[];
  aliveBots: any[];
}

function moveSnake(
  mc: MoveContext,
  kind: 'player' | 'bot',
  snake: any
): void {
  // 1. Clamp direction to max allowed turn
  let newDir = snake.pending_direction;
  let angleDiff = normalizeAngle(newDir - snake.direction);
  if (Math.abs(angleDiff) > MAX_TURN_ANGLE) {
    angleDiff = angleDiff > 0 ? MAX_TURN_ANGLE : -MAX_TURN_ANGLE;
    newDir = snake.direction + angleDiff;
  }
  snake.pending_direction = newDir;

  // 2. Dash state
  let currentSpeed = MOVE_SPEED;
  let isDashing = snake.is_dashing;
  let newCooldownEnd = snake.dash_cooldown_end;
  if (isDashing && mc.now >= snake.dash_end_time) {
    isDashing = false;
    newCooldownEnd = mc.now + DASH_COOLDOWN_MS;
  } else if (isDashing) {
    currentSpeed *= DASH_MULTIPLIER;
  }

  // 3. Move head
  const newX = wrapCoord(snake.x + Math.cos(newDir) * currentSpeed);
  const newY = wrapCoord(snake.y + Math.sin(newDir) * currentSpeed);

  // 4. Look up segments from the per-tick cache
  const segments =
    kind === 'player'
      ? mc.playerSegments.get(snake.identity.toString()) ?? []
      : mc.botSegments.get(snake.id) ?? [];

  // 5. Food collision
  const headSegment = segments.find((s: any) => s.segment_index === 0);
  const headCollisionRadius =
    kind === 'player' ? (headSegment ? Number(headSegment.width) : 18) * 0.8 : 22;
  let ateFood = false;
  let foodIndex = -1;
  for (let i = 0; i < mc.foods.length; i++) {
    if (distSq(mc.foods[i].x, mc.foods[i].y, newX, newY) < headCollisionRadius * headCollisionRadius) {
      foodIndex = i;
      ateFood = true;
      break;
    }
  }
  if (ateFood) {
    snake.score += 10;
    snake.length += 1;
  }

  // 6. Move each segment to the position of the one in front
  const newSegmentPositions: { x: number; y: number }[] = [];
  let prevX = newX;
  let prevY = newY;
  for (const segment of segments) {
    const tempX = segment.x;
    const tempY = segment.y;
    newSegmentPositions.push({ x: prevX, y: prevY });
    if (kind === 'player') {
      mc.ctx.db.snake_segment.id.update({ ...segment, x: prevX, y: prevY });
    } else {
      mc.ctx.db.bot_segment.id.update({ ...segment, x: prevX, y: prevY });
    }
    prevX = tempX;
    prevY = tempY;
  }

  // 7. Grow on eat — widen head + append new tail segment at the vacated spot
  if (ateFood && foodIndex >= 0) {
    const food = mc.foods[foodIndex];
    if (kind === 'player') {
      mc.ctx.db.food.id.delete(food.id);
      mc.ctx.db.snake_segment.id.update({
        ...headSegment,
        x: newSegmentPositions[0]?.x ?? newX,
        y: newSegmentPositions[0]?.y ?? newY,
        width: headSegment.width + 0.08,
      });
      const tail = segments[segments.length - 1];
      if (tail) {
        mc.ctx.db.snake_segment.insert({
          id: 0n,
          owner_identity: snake.identity,
          segment_index: Number(tail.segment_index) + 1,
          x: prevX,
          y: prevY,
          width: 18.0,
        });
      }
    } else {
      mc.ctx.db.food.id.delete(food.id);
      mc.ctx.db.bot_segment.id.update({
        ...headSegment,
        x: newSegmentPositions[0]?.x ?? newX,
        y: newSegmentPositions[0]?.y ?? newY,
        width: headSegment.width + 0.08,
      });
      const tail = segments[segments.length - 1];
      if (tail) {
        mc.ctx.db.bot_segment.insert({
          id: 0n,
          bot_id: snake.id,
          segment_index: Number(tail.segment_index) + 1,
          x: prevX,
          y: prevY,
          width: 18.0,
        });
      }
    }
  }

  // 8. Collisions — check all other snakes, then self
  const collisionDistSq = 15 * 15;
  const headOnDistSq = 20 * 20;
  let killerName: string | null = null;
  let headOnWinner: 'self' | 'other' | null = null;

  // Other players
  for (const other of mc.alivePlayers) {
    if (kind === 'player' && other.identity === snake.identity) continue;
    const otherSegs = mc.playerSegments.get(other.identity.toString());
    if (!otherSegs) continue;
    for (const seg of otherSegs) {
      if (distSq(seg.x, seg.y, newX, newY) >= collisionDistSq) continue;
      if (seg.segment_index === 0 && distSq(seg.x, seg.y, newX, newY) < headOnDistSq) {
        // Head-on — bigger snake wins, equal kills both (each finds the other in its own moveSnake call)
        if (kind === 'player') {
          if (snake.length > other.length) continue;       // we win, the other dies in their own tick
          killerName = other.name;
          break;
        } else {
          killerName = other.name;
          break;
        }
      } else {
        killerName = other.name; break;
      }
    }
    if (killerName) break;
  }

  // Other bots
  if (!killerName) {
    for (const otherBot of mc.aliveBots) {
      if (kind === 'bot' && otherBot.id === snake.id) continue;
      const otherSegs = mc.botSegments.get(otherBot.id);
      if (!otherSegs) continue;
      for (const seg of otherSegs) {
        if (distSq(seg.x, seg.y, newX, newY) < collisionDistSq) {
          killerName = otherBot.name;
          break;
        }
      }
      if (killerName) break;
    }
  }

  // Self-collision (skip head + neck)
  if (!killerName) {
    for (let i = 3; i < newSegmentPositions.length; i++) {
      if (distSq(newSegmentPositions[i].x, newSegmentPositions[i].y, newX, newY) < 100) {
        killerName = kind === 'player' ? 'yourself' : 'itself';
        break;
      }
    }
  }

  if (killerName) {
    killSnake(mc.ctx, kind, snake, segments, killerName);
    // Drop from the per-tick cache so subsequent moveSnake calls in this
    // tick don't see this snake's segments as a collision target.
    if (kind === 'player') {
      mc.playerSegments.delete(snake.identity.toString());
    } else {
      mc.botSegments.delete(snake.id);
    }
    return;
  }

  // 9. Survived — update position
  if (kind === 'player') {
    mc.ctx.db.player.identity.update({
      ...snake,
      x: newX,
      y: newY,
      direction: newDir,
      is_dashing: isDashing,
      dash_cooldown_end: newCooldownEnd,
    });
  } else {
    mc.ctx.db.bot.id.update({
      ...snake,
      x: newX,
      y: newY,
      direction: newDir,
      is_dashing: isDashing,
      dash_cooldown_end: newCooldownEnd,
    });
  }
}

// ============================================================
// Tick reducer
// ============================================================

tickReducer = spacetimedb.reducer(
  { timer: GameTick.rowType },
  (ctx: any, _args: any) => {
    const now = BigInt(Date.now());
    const foods = [...ctx.db.food.iter()];
    // Use the btree index on `alive` to skip dead rows without
    // materializing them. The index entry for `true` is hot
    // (almost all players/bots are alive while the tick runs)
    // so this is O(alive) instead of O(total).
    const alivePlayers = [...ctx.db.player.alive.filter(true)];
    const aliveBots = [...ctx.db.bot.alive.filter(true)];

    // Per-tick segment cache — built once, used by every collision check.
    // This is the dominant perf fix: replaces O(N² × M) full-table scans
    // with O(N) build + O(1) lookups.
    const playerSegments = new Map<string, any[]>();
    for (const seg of ctx.db.snake_segment.iter()) {
      const key = seg.owner_identity.toString();
      let list = playerSegments.get(key);
      if (!list) {
        list = [];
        playerSegments.set(key, list);
      }
      list.push(seg);
    }
    for (const list of playerSegments.values()) {
      list.sort((a: any, b: any) => Number(a.segment_index) - Number(b.segment_index));
    }

    const botSegments = new Map<bigint, any[]>();
    for (const seg of ctx.db.bot_segment.iter()) {
      let list = botSegments.get(seg.bot_id);
      if (!list) {
        list = [];
        botSegments.set(seg.bot_id, list);
      }
      list.push(seg);
    }
    for (const list of botSegments.values()) {
      list.sort((a: any, b: any) => Number(a.segment_index) - Number(b.segment_index));
    }

    const mc: MoveContext = { ctx, now, foods, playerSegments, botSegments, alivePlayers, aliveBots };

    // Move players
    for (const player of alivePlayers) {
      moveSnake(mc, 'player', player);
    }

    // Move bots — refresh filter so we skip players that just died this tick
    for (const bot of aliveBots) {
      if (!bot.alive) continue;
      // Bot decides its own direction via AI
      bot.pending_direction = chooseBotDirection(
        bot,
        foods,
        botSegments,
        playerSegments,
        aliveBots.filter((b: any) => b.alive),
        alivePlayers.filter((p: any) => p.alive)
      );

      // Bot sometimes dashes
      if (!bot.is_dashing && now >= bot.dash_cooldown_end && ctx.random() < 0.15) {
        bot.is_dashing = true;
        bot.dash_end_time = now + DASH_DURATION_MS;
        bot.dash_cooldown_end = now + DASH_DURATION_MS + DASH_COOLDOWN_MS;
      }

      moveSnake(mc, 'bot', bot);
    }

    // Top up food
    const foodCount = Number(ctx.db.food.count());
    if (foodCount < MAX_FOOD) {
      const clusterSize = Math.min(3 + Math.floor(ctx.random() * 6), MAX_FOOD - foodCount);
      for (const pos of getClusterFoodPositions(ctx, clusterSize)) {
        ctx.db.food.insert({
          id: 0n,
          x: pos.x,
          y: pos.y,
          color: COLORS[Math.floor(ctx.random() * COLORS.length)],
        });
      }
    }

    // Maintain minimum snake count
    const livePlayerCount = alivePlayers.filter((p: any) => p.alive).length;
    const liveBotCount = aliveBots.filter((b: any) => b.alive).length;
    if (livePlayerCount + liveBotCount < MIN_SNAKES) {
      for (let i = 0; i < MIN_SNAKES - livePlayerCount - liveBotCount; i++) spawnBot(ctx);
    }

    // Self-reschedule. We use a one-shot Time() row (not Interval)
    // so the schedule is fully stoppable. The world_paused flag is
    // the durable stop — it ensures the chain breaks even if a
    // tick is already in flight when stopTick / on_disconnect
    // clears the row. setPaused(true) is called BEFORE the row
    // delete in stopTick, so the in-flight tick sees paused=true
    // when it gets to this point and short-circuits. Without the
    // flag, deleting the row races with the engine's pending fire
    // and the chain self-heals within one tick interval.
    const paused = ctx.db.world_paused.singleton.find(false);
    if (paused && paused.paused) {
      return;
    }

    ctx.db.game_tick.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.time(now + TICK_INTERVAL_US + 1000n),
    });
  }
);

export const tick = tickReducer;

// ============================================================
// Connection lifecycle
// ============================================================

function setPaused(ctx: any, paused: boolean): void {
  const existing = ctx.db.world_paused.singleton.find(false);
  if (existing) {
    if (existing.paused !== paused) {
      ctx.db.world_paused.singleton.update({ singleton: existing.singleton, paused });
    }
  } else {
    ctx.db.world_paused.insert({ singleton: false, paused });
  }
}

// Arm the tick. The world is "active" — clear the pause flag and
// insert a scheduled row if one isn't already pending. Called from
// join_game (real player joining) — NOT from on_connect, because
// on_connect also fires for spectator clients, PWA background
// tabs, and reconnecting sockets that never intend to play.
function ensureTickScheduled(ctx: any) {
  setPaused(ctx, false);
  for (const _ of ctx.db.game_tick.iter()) return; // already scheduled
  // Self-rescheduling chain (see tick reducer). One-shot at
  // now+50ms; the tick reducer inserts the next one when it fires.
  ctx.db.game_tick.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(BigInt(Date.now()) + TICK_INTERVAL_US),
  });
}

function stopTick(ctx: any) {
  // Set the pause flag FIRST. If a tick is in flight, its self-
  // reschedule step will see paused=true and skip the insert,
  // breaking the chain. Then drop every scheduled game_tick row
  // so no new fires can be queued while we wait for the in-flight
  // tick to drain.
  setPaused(ctx, true);
  // Drop every scheduled game_tick row to unschedule the reducer.
  // Skipping the .delete() on a copy of the iterator and deleting
  // the row directly from the table is safe because the index is
  // the primary key (no iter-mutation hazard).
  for (const t of ctx.db.game_tick.iter()) {
    ctx.db.game_tick.scheduled_id.delete(t.scheduled_id);
  }
}

export const on_connect = spacetimedb.clientConnected((ctx: any) => {
  // Don't arm the tick here. on_connect fires for every TCP/WS
  // connection, including spectator clients, PWA background tabs,
  // and reconnecting sockets that never call join_game. If we
  // armed the tick here, the world would be "active" (and burning
  // resources) whenever any of those was connected, even with 0
  // real players. The tick is armed by join_game (a real player
  // is entering) and disarmed by on_disconnect when player.count()
  // drops to 0.
});

export const on_disconnect = spacetimedb.clientDisconnected((ctx: any) => {
  const sender = ctx.sender;
  const player = ctx.db.player.identity.find(sender);

  if (player) {
    // Drop segments as food (every 3rd), then delete the rest + the player row.
    // Indexed lookup — see join_game for the rationale. on_disconnect fires
    // for every tab close / background tab / wifi blip, so this used to be
    // the single biggest bytes-scanned contributor on the server.
    let i = 0;
    for (const seg of ctx.db.snake_segment.owner_identity.filter(sender)) {
      if (i % 3 === 0) {
        ctx.db.food.insert({ id: 0n, x: seg.x, y: seg.y, color: '#FF6B6B' });
      }
      ctx.db.snake_segment.id.delete(seg.id);
      i++;
    }
    ctx.db.player.identity.delete(sender);
  }

  // If the world is empty of players, stop the tick so we stop
  // burning bytes-scanned + bytes-written on bot movement that
  // nobody is watching. The next player to connect will re-arm
  // the schedule in join_game. Bots and food persist in the DB,
  // so the world resumes where it left off; MIN_SNAKES in the
  // tick will top the bot count back up to 10.
  const remainingPlayers = ctx.db.player.count();
  if (remainingPlayers === 0n) {
    stopTick(ctx);
  }
});

export const init = spacetimedb.init((ctx: any) => {
  spawnInitialFood(ctx, MAX_FOOD);
  for (let i = 0; i < MIN_SNAKES; i++) spawnBot(ctx);
  // Don't schedule the tick here. The world sits frozen until a
  // real player calls join_game (which arms the tick via
  // ensureTickScheduled). Pre-fix, init armed the tick at boot,
  // so the 20 Hz reducer fired 24/7 burning bytes-scanned +
  // bytes-written + bytes-sent-to-clients on a world nobody was
  // watching. The MIN_SNAKES top-up in the tick will repopulate
  // any bots that died while the world was frozen, so the
  // empty-tick state is self-healing on the first reconnect.
  //
  // init only runs on module creation (not on republish), so this
  // doesn't help on redeploy. Use `spacetime call snek-io
  // stop_world_tick` after publishing to flush any leftover
  // schedule from a previous module version.
  setPaused(ctx, true);
});

// One-shot cleanup: clears any leftover game_tick rows and sets
// the world_paused flag, atomically stopping the 20 Hz tick
// reducer. The flag is what makes the stop durable — without it,
// an in-flight tick would self-reschedule and the chain would
// come back to life. Useful for emergency stops when the normal
// on_disconnect path is somehow bypassed (e.g. a stuck client
// that has a player row but isn't really playing).
export const stop_world_tick = spacetimedb.reducer(
  {},
  (ctx: any, _args: any) => {
    setPaused(ctx, true);
    for (const t of ctx.db.game_tick.iter()) {
      ctx.db.game_tick.scheduled_id.delete(t.scheduled_id);
    }
  }
);

export default spacetimedb;
