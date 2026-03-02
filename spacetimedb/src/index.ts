import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

const MAP_SIZE = 2000;
const INITIAL_SNAKE_LENGTH = 4;
const MAX_FOOD = 200;
const MOVE_SPEED = 8.0;
const SEGMENT_SPACING = 18;
const TICK_INTERVAL_US = 50000n;
const MIN_SNAKES = 10; // Minimum total snakes (players + bots)

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

function getRandomPosition(ctx: any): { x: number; y: number } {
  return {
    x: ctx.random() * MAP_SIZE,
    y: ctx.random() * MAP_SIZE,
  };
}

function getRandomColor(ctx: any): string {
  return COLORS[Math.floor(ctx.random() * COLORS.length)];
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

function getSegmentsByOwner(ctx: any, owner: any) {
  const allSegments = [...ctx.db.snake_segment.iter()];
  const ownerStr = owner.toString();
  return allSegments.filter((s: any) => {
    const segOwnerStr = s.owner_identity.toString();
    return segOwnerStr === ownerStr || segOwnerStr.replace('0x', '') === ownerStr.replace('0x', '');
  }).sort((a: any, b: any) => Number(a.segment_index) - Number(b.segment_index));
}

function getBotSegments(ctx: any, botId: bigint) {
  return [...ctx.db.bot_segment.iter()]
    .filter((s: any) => s.bot_id === botId)
    .sort((a: any, b: any) => Number(a.segment_index) - Number(b.segment_index));
}

function deleteSegmentsByOwner(ctx: any, owner: any) {
  const segments = getSegmentsByOwner(ctx, owner);
  for (const seg of segments) {
    ctx.db.snake_segment.id.delete(seg.id);
  }
}

function deleteBotSegments(ctx: any, botId: bigint) {
  const segments = getBotSegments(ctx, botId);
  for (const seg of segments) {
    ctx.db.bot_segment.id.delete(seg.id);
  }
}

// Bot AI: Choose direction based on food, walls, and other snakes
function chooseBotDirection(ctx: any, bot: any, foods: any[], players: any[], bots: any[]): number {
  const headX = bot.x;
  const headY = bot.y;
  const currentDir = bot.direction;

  // Get bot's own segments for self-collision checking
  const ownSegments = getBotSegments(ctx, bot.id);

  // Find nearest food
  let nearestFood = null;
  let nearestFoodDist = Infinity;
  for (const food of foods) {
    const dist = Math.sqrt(Math.pow(food.x - headX, 2) + Math.pow(food.y - headY, 2));
    if (dist < nearestFoodDist) {
      nearestFoodDist = dist;
      nearestFood = food;
    }
  }

  // Calculate desired direction toward food as angle
  let desiredDir = currentDir;
  if (nearestFood) {
    const dx = nearestFood.x - headX;
    const dy = nearestFood.y - headY;
    desiredDir = Math.atan2(dy, dx);
  }

  // Check for collisions at a given angle
  const checkCollision = (angle: number, distance: number = MOVE_SPEED * 3) => {
    const checkX = headX + Math.cos(angle) * distance;
    const checkY = headY + Math.sin(angle) * distance;

    // Check distance to other snakes (players and bots)
    const checkDistance = (segments: any[], skipFirstN: number = 0) => {
      for (const seg of segments) {
        if (seg.segment_index < skipFirstN) continue;
        const dist = Math.sqrt(Math.pow(seg.x - checkX, 2) + Math.pow(seg.y - checkY, 2));
        if (dist < 30) return true;
      }
      return false;
    };

    // Check self-collision (skip first 4 segments: head + neck)
    if (ownSegments.length > 4) {
      if (checkDistance(ownSegments, 4)) {
        return true;
      }
    }

    // Check all player segments
    for (const player of players) {
      if (player.alive) {
        const segments = getSegmentsByOwner(ctx, player.identity);
        if (checkDistance(segments, 1)) return true;
      }
    }

    // Check all bot segments
    for (const otherBot of bots) {
      if (otherBot.id !== bot.id && otherBot.alive) {
        const segments = getBotSegments(ctx, otherBot.id);
        if (checkDistance(segments, 1)) return true;
      }
    }

    return false;
  };

  // Try desired direction first
  if (!checkCollision(desiredDir)) {
    return desiredDir;
  }

  // Try angles at 45-degree increments from desired direction
  const angleOffsets = [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, 3 * Math.PI / 4, -3 * Math.PI / 4, Math.PI];

  for (const offset of angleOffsets) {
    const testAngle = desiredDir + offset;
    if (!checkCollision(testAngle)) {
      return testAngle;
    }
  }

  // If all directions have obstacles, look further ahead in current direction
  // to see if we can continue straight
  let collisionDistance = Infinity;
  for (let dist = 1; dist <= 5; dist++) {
    const testX = headX + Math.cos(currentDir) * dist * MOVE_SPEED;
    const testY = headY + Math.sin(currentDir) * dist * MOVE_SPEED;

    // Check self-collision at this projected position
    if (ownSegments.length > 4) {
      for (let i = 4; i < ownSegments.length; i++) {
        const seg = ownSegments[i];
        const distToSeg = Math.sqrt(Math.pow(seg.x - testX, 2) + Math.pow(seg.y - testY, 2));
        if (distToSeg < 25) {
          collisionDistance = dist;
          break;
        }
      }
    }
    if (collisionDistance < Infinity) break;
  }

  // If collision imminent, pick any available escape angle
  if (collisionDistance <= 3) {
    for (let i = 0; i < 8; i++) {
      const escapeAngle = (i / 8) * Math.PI * 2;
      if (!checkCollision(escapeAngle)) {
        return escapeAngle;
      }
    }
  }

  // Continue in current direction
  return currentDir;
}

const Player = table(
  { name: 'player', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    color: t.string(),
    score: t.u32(),
    length: t.u32(),
    direction: t.f32(),
    alive: t.bool(),
    x: t.f32(),
    y: t.f32(),
    pending_direction: t.f32(),
  }
);

const SnakeSegment = table(
  { name: 'snake_segment', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    owner_identity: t.identity(),
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
    alive: t.bool(),
    x: t.f32(),
    y: t.f32(),
    pending_direction: t.f32(),
  }
);

const BotSegment = table(
  { name: 'bot_segment', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    bot_id: t.u64(),
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

const PlayerPositionEvent = table(
  { name: 'player_position_event', public: true, event: true },
  {
    identity: t.identity(),
    x: t.f32(),
    y: t.f32(),
    direction: t.f32(),
  }
);

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

const spacetimedb = schema({
  player: Player,
  snake_segment: SnakeSegment,
  bot: Bot,
  bot_segment: BotSegment,
  food: Food,
  player_position_event: PlayerPositionEvent,
  player_died_event: PlayerDiedEvent,
  player_joined_event: PlayerJoinedEvent,
  bot_died_event: BotDiedEvent,
  game_tick: GameTick,
});

export const join_game = spacetimedb.reducer(
  { name: t.string(), color: t.string() },
  (ctx: any, { name, color }: { name: string; color: string }) => {
    const sender = ctx.sender;
    
    const existingPlayer = ctx.db.player.identity.find(sender);
    if (existingPlayer) {
      return;
    }

    const pos = getRandomPosition(ctx);
    const dir = ctx.random() * Math.PI * 2; // Random angle in radians

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
    });

    for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
      // Calculate offset using angle (opposite direction)
      const offsetX = -Math.cos(dir) * i * SEGMENT_SPACING;
      const offsetY = -Math.sin(dir) * i * SEGMENT_SPACING;
      ctx.db.snake_segment.insert({
        id: 0n,
        owner_identity: sender,
        segment_index: i,
        x: pos.x + offsetX,
        y: pos.y + offsetY,
        width: 18.0,
      });
    }

    ctx.db.player_joined_event.insert({
      identity: sender,
      name,
      color,
      x: pos.x,
      y: pos.y,
    });
  }
);

export const change_direction = spacetimedb.reducer(
  { direction: t.f32() },
  (ctx: any, { direction }: { direction: number }) => {
    const sender = ctx.sender;
    const player = ctx.db.player.identity.find(sender);

    if (!player || !player.alive) {
      return;
    }

    player.pending_direction = direction;
    ctx.db.player.identity.update({ ...player, pending_direction: direction });
  }
);

export const leave_game = spacetimedb.reducer(
  (ctx: any) => {
    const sender = ctx.sender;
    const player = ctx.db.player.identity.find(sender);
    
    if (player) {
      deleteSegmentsByOwner(ctx, sender);
      ctx.db.player.identity.delete(sender);
    }
  }
);

// Spawn a bot snake
function spawnBot(ctx: any) {
  const pos = getRandomPosition(ctx);
  const dir = ctx.random() * Math.PI * 2; // Random angle in radians
  const name = BOT_NAMES[Math.floor(ctx.random() * BOT_NAMES.length)];
  const color = getRandomColor(ctx);

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
  });

  for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
    // Calculate offset using angle (opposite direction)
    const offsetX = -Math.cos(dir) * i * SEGMENT_SPACING;
    const offsetY = -Math.sin(dir) * i * SEGMENT_SPACING;
    ctx.db.bot_segment.insert({
      id: 0n,
      bot_id: bot.id,
      segment_index: i,
      x: pos.x + offsetX,
      y: pos.y + offsetY,
      width: 14.0,
    });
  }

  return bot;
}

tickReducer = spacetimedb.reducer(
  { timer: GameTick.rowType },
  (ctx: any, _args: any) => {
    const foods = [...ctx.db.food.iter()];
    const players = [...ctx.db.player.iter()].filter((p: any) => p.alive);
    const bots = [...ctx.db.bot.iter()].filter((b: any) => b.alive);
    
    // Move players
    for (const player of players) {
      const newDir = player.pending_direction;

      // Calculate movement using angle in radians
      const dx = Math.cos(newDir) * MOVE_SPEED;
      const dy = Math.sin(newDir) * MOVE_SPEED;

      let newX = player.x + dx;
      let newY = player.y + dy;

      if (newX < 0) newX += MAP_SIZE;
      if (newX >= MAP_SIZE) newX -= MAP_SIZE;
      if (newY < 0) newY += MAP_SIZE;
      if (newY >= MAP_SIZE) newY -= MAP_SIZE;

      const segments = getSegmentsByOwner(ctx, player.identity);
      const headSegment = segments.find((s: any) => s.segment_index === 0);

      // Check food collision BEFORE moving segments
      // Collision radius grows with head size to match visual representation
      // Head width grows by 0.08 per food eaten, base width is 18
      const headWidth = headSegment ? Number(headSegment.width) : 18;
      const headCollisionRadius = headWidth * 0.6; // Scale with head width to match visual size
      let ateFood = false;
      let foodIndex = -1;
      for (let i = 0; i < foods.length; i++) {
        const food = foods[i];
        const dist = Math.sqrt(
          Math.pow(food.x - newX, 2) + Math.pow(food.y - newY, 2)
        );
        if (dist < headCollisionRadius) {
          foodIndex = i;
          player.score += 10;
          player.length += 1;
          ateFood = true;
          break;
        }
      }

      // Track new segment positions for collision detection
      // Each segment moves to where the previous one was
      const newSegmentPositions: { index: number; x: number; y: number }[] = [];

      let prevX = newX;
      let prevY = newY;

      for (const segment of segments) {
        const tempX = segment.x;
        const tempY = segment.y;
        const newSegX = prevX;
        const newSegY = prevY;

        newSegmentPositions.push({ index: segment.segment_index, x: newSegX, y: newSegY });

        ctx.db.snake_segment.id.update({
          ...segment,
          x: newSegX,
          y: newSegY,
        });
        prevX = tempX;
        prevY = tempY;
      }

      // Handle growth after movement
      if (ateFood && foodIndex >= 0) {
        const food = foods[foodIndex];
        ctx.db.food.id.delete(food.id);

        // Get the UPDATED head segment (not the old one from segments array)
        const updatedSegments = getSegmentsByOwner(ctx, player.identity);
        const headSegment = updatedSegments.find((s: any) => s.segment_index === 0);
        if (headSegment) {
          ctx.db.snake_segment.id.update({
            ...headSegment,
            width: headSegment.width + 0.08,
          });
        }

        const lastSegment = updatedSegments[updatedSegments.length - 1];

        if (lastSegment) {
          // Insert new segment at the position the tail just vacated
          // prevX/prevY now hold the last segment's old position
          ctx.db.snake_segment.insert({
            id: 0n,
            owner_identity: player.identity,
            segment_index: Number(lastSegment.segment_index) + 1,
            x: prevX,
            y: prevY,
            width: 18.0,
          });
        }
      }

      // Check collision with other players
      for (const other of players) {
        if (other.identity === player.identity) continue;
        const otherSegments = getSegmentsByOwner(ctx, other.identity);
        const otherHead = otherSegments.find((s: any) => s.segment_index === 0);
        
        for (const segment of otherSegments) {
          const dist = Math.sqrt(
            Math.pow(segment.x - newX, 2) + Math.pow(segment.y - newY, 2)
          );
          if (dist < 15) {
            // Check if this is a head-on-head collision
            if (segment.segment_index === 0 && otherHead && dist < 20) {
              // Head-on collision: bigger snake wins (compare lengths)
              if (player.length > other.length) {
                // This player is bigger, kill the other
                continue; // Skip killing this player, we'll kill the other below
              } else if (player.length < other.length) {
                // Other player is bigger, this player dies
                player.alive = false;
                player.score = 0;
                
                ctx.db.player_died_event.insert({
                  identity: player.identity,
                  killer_name: other.name,
                });
                
                ctx.db.player.identity.update({
                  ...player,
                  alive: false,
                  score: 0,
                });
                
                const playerSegments = getSegmentsByOwner(ctx, player.identity);
                let segIndex = 0;
                for (const seg of playerSegments) {
                  if (segIndex % 3 === 0) {
                    ctx.db.food.insert({
                      id: 0n,
                      x: seg.x,
                      y: seg.y,
                      color: '#FF6B6B',
                    });
                  }
                  ctx.db.snake_segment.id.delete(seg.id);
                  segIndex++;
                }
                break;
              } else {
                // Equal length: both die
                player.alive = false;
                player.score = 0;
                
                ctx.db.player_died_event.insert({
                  identity: player.identity,
                  killer_name: other.name,
                });
                
                ctx.db.player.identity.update({
                  ...player,
                  alive: false,
                  score: 0,
                });
                
                const playerSegments = getSegmentsByOwner(ctx, player.identity);
                let segIndex = 0;
                for (const seg of playerSegments) {
                  if (segIndex % 3 === 0) {
                    ctx.db.food.insert({
                      id: 0n,
                      x: seg.x,
                      y: seg.y,
                      color: '#FF6B6B',
                    });
                  }
                  ctx.db.snake_segment.id.delete(seg.id);
                  segIndex++;
                }
                break;
              }
            } else {
              // Not a head-on collision, normal collision rules apply
              player.alive = false;
              player.score = 0;

              ctx.db.player_died_event.insert({
                identity: player.identity,
                killer_name: other.name,
              });

              ctx.db.player.identity.update({
                ...player,
                alive: false,
                score: 0,
              });

              const playerSegments = getSegmentsByOwner(ctx, player.identity);
              let segIndex = 0;
              for (const seg of playerSegments) {
                if (segIndex % 3 === 0) {
                  ctx.db.food.insert({
                    id: 0n,
                    x: seg.x,
                    y: seg.y,
                    color: '#FF6B6B',
                  });
                }
                ctx.db.snake_segment.id.delete(seg.id);
                segIndex++;
              }
              break;
            }
          }
        }
        if (!player.alive) break;
      }

      // Check collision with bots
      if (player.alive) {
        for (const bot of bots) {
          const botSegments = getBotSegments(ctx, bot.id);
          for (const segment of botSegments) {
            const dist = Math.sqrt(
              Math.pow(segment.x - newX, 2) + Math.pow(segment.y - newY, 2)
            );
            if (dist < 15) {
              player.alive = false;
              player.score = 0;
              
              ctx.db.player_died_event.insert({
                identity: player.identity,
                killer_name: bot.name,
              });
              
              ctx.db.player.identity.update({
                ...player,
                alive: false,
                score: 0,
              });
              
              const playerSegments = getSegmentsByOwner(ctx, player.identity);
              let segIndex = 0;
              for (const seg of playerSegments) {
                if (segIndex % 3 === 0) {
                  ctx.db.food.insert({
                    id: 0n,
                    x: seg.x,
                    y: seg.y,
                    color: '#FF6B6B',
                  });
                }
                ctx.db.snake_segment.id.delete(seg.id);
                segIndex++;
              }
              break;
            }
          }
          if (!player.alive) break;
        }
      }

      // Check self-collision (crash into own body) using NEW segment positions
      if (player.alive) {
        // Skip the first few segments (head and neck) to avoid false positives
        // Start checking from segment 3 onwards
        for (let i = 3; i < newSegmentPositions.length; i++) {
          const segment = newSegmentPositions[i];
          const dist = Math.sqrt(
            Math.pow(segment.x - newX, 2) + Math.pow(segment.y - newY, 2)
          );
          if (dist < 10) { // Reduced radius for more accurate collision
            player.alive = false;
            player.score = 0;

            ctx.db.player_died_event.insert({
              identity: player.identity,
              killer_name: 'yourself',
            });

            ctx.db.player.identity.update({
              ...player,
              alive: false,
              score: 0,
            });

            const playerSegments = getSegmentsByOwner(ctx, player.identity);
            let segIndex = 0;
            for (const seg of playerSegments) {
              if (segIndex % 3 === 0) {
                ctx.db.food.insert({
                  id: 0n,
                  x: seg.x,
                  y: seg.y,
                  color: '#FF6B6B',
                });
              }
              ctx.db.snake_segment.id.delete(seg.id);
              segIndex++;
            }
            break;
          }
        }
      }

      if (player.alive) {
        ctx.db.player.identity.update({
          ...player,
          x: newX,
          y: newY,
          direction: newDir,
        });
      }
    }

    // Move bots with AI
    for (const bot of bots) {
      // Choose direction using AI
      const newDir = chooseBotDirection(ctx, bot, foods, players, bots);
      bot.pending_direction = newDir;

      // Calculate movement using angle in radians
      const dx = Math.cos(newDir) * MOVE_SPEED;
      const dy = Math.sin(newDir) * MOVE_SPEED;

      let newX = bot.x + dx;
      let newY = bot.y + dy;

      if (newX < 0) newX += MAP_SIZE;
      if (newX >= MAP_SIZE) newX -= MAP_SIZE;
      if (newY < 0) newY += MAP_SIZE;
      if (newY >= MAP_SIZE) newY -= MAP_SIZE;

      const segments = getBotSegments(ctx, bot.id);

      // Check food collision BEFORE moving segments
      // Use larger collision radius to account for bigger head (base width 18 + head size increase)
      const headCollisionRadius = 22;
      let ateFood = false;
      let foodIndex = -1;
      for (let i = 0; i < foods.length; i++) {
        const food = foods[i];
        const dist = Math.sqrt(
          Math.pow(food.x - newX, 2) + Math.pow(food.y - newY, 2)
        );
        if (dist < headCollisionRadius) {
          foodIndex = i;
          bot.score += 10;
          bot.length += 1;
          ateFood = true;
          break;
        }
      }

      // Track new segment positions for collision detection
      const newSegmentPositions: { index: number; x: number; y: number }[] = [];

      let prevX = newX;
      let prevY = newY;

      for (const segment of segments) {
        const tempX = segment.x;
        const tempY = segment.y;
        const newSegX = prevX;
        const newSegY = prevY;

        newSegmentPositions.push({ index: segment.segment_index, x: newSegX, y: newSegY });

        ctx.db.bot_segment.id.update({
          ...segment,
          x: newSegX,
          y: newSegY,
        });
        prevX = tempX;
        prevY = tempY;
      }

      // Handle growth after movement
      if (ateFood && foodIndex >= 0) {
        const food = foods[foodIndex];
        ctx.db.food.id.delete(food.id);

        // Get the UPDATED segments (not the old ones)
        const updatedSegments = getBotSegments(ctx, bot.id);
        const headSegment = updatedSegments.find((s: any) => s.segment_index === 0);
        if (headSegment) {
          ctx.db.bot_segment.id.update({
            ...headSegment,
            width: headSegment.width + 0.08,
          });
        }

        const lastSegment = updatedSegments[updatedSegments.length - 1];

        if (lastSegment) {
          // Insert new segment at the position the tail just vacated
          // prevX/prevY now hold the last segment's old position
          ctx.db.bot_segment.insert({
            id: 0n,
            bot_id: bot.id,
            segment_index: Number(lastSegment.segment_index) + 1,
            x: prevX,
            y: prevY,
            width: 18.0,
          });
        }
      }

      // Check collision with players
      let killedBy = null;
      for (const player of players) {
        const playerSegments = getSegmentsByOwner(ctx, player.identity);
        for (const segment of playerSegments) {
          const dist = Math.sqrt(
            Math.pow(segment.x - newX, 2) + Math.pow(segment.y - newY, 2)
          );
          if (dist < 15) {
            bot.alive = false;
            bot.score = 0;
            killedBy = player.name;
            break;
          }
        }
        if (!bot.alive) break;
      }

      // Check collision with other bots
      if (bot.alive) {
        for (const otherBot of bots) {
          if (otherBot.id === bot.id) continue;
          const otherSegments = getBotSegments(ctx, otherBot.id);
          for (const segment of otherSegments) {
            const dist = Math.sqrt(
              Math.pow(segment.x - newX, 2) + Math.pow(segment.y - newY, 2)
            );
            if (dist < 15) {
              bot.alive = false;
              bot.score = 0;
              killedBy = otherBot.name;
              break;
            }
          }
          if (!bot.alive) break;
        }
      }

      // Check self-collision (bots crashing into their own body) using NEW segment positions
      if (bot.alive) {
        // Skip the first few segments (head and neck) to avoid false positives
        for (let i = 3; i < newSegmentPositions.length; i++) {
          const segment = newSegmentPositions[i];
          const dist = Math.sqrt(
            Math.pow(segment.x - newX, 2) + Math.pow(segment.y - newY, 2)
          );
          if (dist < 10) { // Reduced radius for more accurate collision
            bot.alive = false;
            bot.score = 0;
            killedBy = 'itself';
            break;
          }
        }
      }

      if (!bot.alive) {
        ctx.db.bot_died_event.insert({
          bot_id: bot.id,
          killer_name: killedBy || 'Unknown',
        });
        
        ctx.db.bot.id.update({
          ...bot,
          alive: false,
          score: 0,
        });
        
        // Convert dead bot's segments to food (every 3rd segment)
        let segIndex = 0;
        for (const seg of segments) {
          if (segIndex % 3 === 0) {
            ctx.db.food.insert({
              id: 0n,
              x: seg.x,
              y: seg.y,
              color: '#FF6B6B',
            });
          }
          ctx.db.bot_segment.id.delete(seg.id);
          segIndex++;
        }
      } else {
        ctx.db.bot.id.update({
          ...bot,
          x: newX,
          y: newY,
          direction: newDir,
        });
      }
    }

    // Spawn food
    const foodCount = Number(ctx.db.food.count());
    if (foodCount < MAX_FOOD) {
      const clusterSize = Math.min(3 + Math.floor(ctx.random() * 6), MAX_FOOD - foodCount);
      const positions = getClusterFoodPositions(ctx, clusterSize);
      for (const pos of positions) {
        ctx.db.food.insert({
          id: 0n,
          x: pos.x,
          y: pos.y,
          color: getRandomColor(ctx),
        });
      }
    }
    
    // Clean up dead players
    const allPlayers = [...ctx.db.player.iter()];
    for (const player of allPlayers) {
      if (!player.alive) {
        const segments = getSegmentsByOwner(ctx, player.identity);
        for (const seg of segments) {
          ctx.db.snake_segment.id.delete(seg.id);
        }
        ctx.db.player.identity.delete(player.identity);
      }
    }

    // Clean up dead bots
    const allBots = [...ctx.db.bot.iter()];
    for (const bot of allBots) {
      if (!bot.alive) {
        deleteBotSegments(ctx, bot.id);
        ctx.db.bot.id.delete(bot.id);
      }
    }

    // Spawn new bots if needed to maintain minimum snake count
    const totalSnakes = [...ctx.db.player.iter()].filter((p: any) => p.alive).length + 
                        [...ctx.db.bot.iter()].filter((b: any) => b.alive).length;
    
    if (totalSnakes < MIN_SNAKES) {
      const botsToSpawn = MIN_SNAKES - totalSnakes;
      for (let i = 0; i < botsToSpawn; i++) {
        spawnBot(ctx);
      }
    }
  }
);

export const tick = tickReducer;

export const on_connect = spacetimedb.clientConnected((ctx: any) => {
  const ticks = [...ctx.db.game_tick.iter()];
  if (ticks.length === 0) {
    ctx.db.game_tick.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.interval(TICK_INTERVAL_US),
    });
  }
});

export const on_disconnect = spacetimedb.clientDisconnected((ctx: any) => {
  const sender = ctx.sender;

  const player = ctx.db.player.identity.find(sender);
  if (player) {
    const segments = getSegmentsByOwner(ctx, sender);
    let segIndex = 0;
    for (const seg of segments) {
      if (segIndex % 3 === 0) {
        ctx.db.food.insert({
          id: 0n,
          x: seg.x,
          y: seg.y,
          color: '#FF6B6B',
        });
      }
      ctx.db.snake_segment.id.delete(seg.id);
      segIndex++;
    }

    ctx.db.player.identity.delete(sender);
  }

  // Check if this was the last player
  const players = [...ctx.db.player.iter()];
  if (players.length === 0) {
    // Delete all bots since last player disconnected
    for (const b of ctx.db.bot.iter()) {
      // Delete bot's segments first
      const botSegments = getBotSegments(ctx, b.id);
      for (const seg of botSegments) {
        ctx.db.bot_segment.id.delete(seg.id);
      }
      ctx.db.bot.id.delete(b.id);
    }
    // Clear ALL data from the database
    // Clear all players (should already be empty, but for safety)
    for (const p of ctx.db.player.iter()) {
      ctx.db.player.identity.delete(p.identity);
    }

    // Clear all bots
    for (const b of ctx.db.bot.iter()) {
      ctx.db.bot.id.delete(b.id);
    }

    // Clear all bot segments
    for (const seg of ctx.db.bot_segment.iter()) {
      ctx.db.bot_segment.id.delete(seg.id);
    }

    // Clear all player segments
    for (const seg of ctx.db.snake_segment.iter()) {
      ctx.db.snake_segment.id.delete(seg.id);
    }

    // Clear all food
    for (const f of ctx.db.food.iter()) {
      ctx.db.food.id.delete(f.id);
    }

    // Clear all events
    for (const e of ctx.db.player_position_event.iter()) {
      ctx.db.player_position_event.id.delete(e.id);
    }
    for (const e of ctx.db.player_died_event.iter()) {
      ctx.db.player_died_event.id.delete(e.id);
    }
    for (const e of ctx.db.player_joined_event.iter()) {
      ctx.db.player_joined_event.id.delete(e.id);
    }
    for (const e of ctx.db.bot_died_event.iter()) {
      ctx.db.bot_died_event.id.delete(e.id);
    }

    // Stop the tick
    const ticks = [...ctx.db.game_tick.iter()];
    for (const t of ticks) {
      ctx.db.game_tick.scheduled_id.delete(t.scheduled_id);
    }

    // Reinitialize with initial food and MIN_SNAKES bots
    // Spawn initial food
    for (let i = 0; i < MAX_FOOD; i++) {
      const pos = getRandomPosition(ctx);
      ctx.db.food.insert({
        id: 0n,
        x: pos.x,
        y: pos.y,
        color: getRandomColor(ctx),
      });
    }

    // Spawn initial bots
    for (let i = 0; i < MIN_SNAKES; i++) {
      spawnBot(ctx);
    }
  }
});

export const init = spacetimedb.init((ctx: any) => {
  // Spawn initial food
  for (let i = 0; i < MAX_FOOD; i++) {
    const pos = getRandomPosition(ctx);
    ctx.db.food.insert({
      id: 0n,
      x: pos.x,
      y: pos.y,
      color: getRandomColor(ctx),
    });
  }
  
  // Spawn initial bots to reach minimum snake count
  for (let i = 0; i < MIN_SNAKES; i++) {
    spawnBot(ctx);
  }
  
  const ticks = [...ctx.db.game_tick.iter()];
  if (ticks.length === 0) {
    ctx.db.game_tick.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.interval(TICK_INTERVAL_US),
    });
  }
});

export default spacetimedb;
