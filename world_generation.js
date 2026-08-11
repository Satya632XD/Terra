/* =========================================================================
   world_generation.js
   -------------------------------------------------------------------------
   Seeded, chunk-based, biome-rich world generator for the voxel game in
   index.html. This file owns: world seed, noise, chunks, biomes, terrain,
   mountains, caves, ores, rivers, oceans, vegetation, structures, chunk
   loading/unloading and world streaming around the player.

   index.html keeps owning: player, input, mining, placement, inventory,
   crafting, UI, rendering (mesh building), physics, day/night, game loop.

   Compatibility contract with index.html (unchanged signatures):
     getBlock(x, y, z)          -> blockType string | undefined
     setBlock(x, y, z, type)    -> void
     removeBlock(x, y, z)       -> void

   New API surface index.html's game loop / renderer hook into:
     WorldGen.init(seed?)
     WorldGen.setPlayerPosition(x, z)
     WorldGen.update()                    // call once per frame (streaming)
     WorldGen.consumeDirtyChunks()        // -> [{chunkX, chunkZ}, ...] and clears the list
     WorldGen.chunkKeyForBlock(x, z)      -> "cx,cz"
     WorldGen.CHUNK_SIZE

   Everything here is deterministic: same seed + same coordinates always
   produce the same terrain, caves, ores, rivers, oceans, vegetation and
   structures, regardless of chunk load/unload order.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ======================================================================
     CONFIG
     ====================================================================== */
  const CONFIG = {
    CHUNK_SIZE: 16,          // chunk width/depth in blocks
    WORLD_MIN_Y: -24,        // lowest generated Y (deep caves / bedrock)
    WORLD_MAX_Y: 48,         // highest generated Y (mountain peaks)
    SEA_LEVEL: 2,            // matches the old fixed-world water surface (y=1.65 render, blocks at y<=2)

    // Streaming radii, measured in chunks (Chebyshev distance from player chunk).
    GENERATE_RADIUS: 4,      // chunks generated & kept as block data
    RENDER_RADIUS: 3,        // chunks that get meshes built (<= GENERATE_RADIUS)
    UNLOAD_RADIUS: 6,        // chunks farther than this get fully unloaded

    // Perf: cap how many NEW chunks we generate in a single update() call so
    // a burst of movement (teleport/respawn) can't freeze the frame. Runtime
    // streaming stays capped, but init() uses the full render radius below so
    // the first visible frame is not an empty black scene while chunks trickle in.
    MAX_CHUNK_GENS_PER_TICK: 2,

    // Ore depth bands (Y level). Configurable rather than hard-coded deep
    // in the generator logic.
    ORE_BANDS: {
      coal:    { min: -4,  max: 16, chance: 0.010 },
      iron:    { min: -10, max: 4,  chance: 0.007 },
      gold:    { min: -18, max: -4, chance: 0.004 },
      diamond: { min: -24, max: -12, chance: 0.002 },
    },
  };

  /* ======================================================================
     WORLD SEED + SEEDED RANDOM
     WORLD SEED -> deterministic random/noise functions -> same coords
     always produce the same terrain.
     ====================================================================== */
  let WORLD_SEED = 1337;

  // xmur3 string hash -> 32-bit seed. Lets a user pass any string/number.
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  // sfc32 PRNG - fast, deterministic, good enough statistical quality for terrain.
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  // A single deterministic hash for arbitrary integer coordinates + a salt.
  // This is the workhorse used to seed per-cell randomness (ore veins,
  // tree placement, structure placement, cave detail) without needing a
  // persistent PRNG object per call site.
  function hash3(x, y, z, salt) {
    let h = WORLD_SEED ^ salt;
    h = Math.imul(h ^ x, 0x27d4eb2f);
    h = Math.imul(h ^ y, 0x165667b1);
    h = Math.imul(h ^ z, 0x9e3779b9);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296; // [0, 1)
  }

  function hash2(x, z, salt) {
    return hash3(x, 0, z, salt);
  }

  function setSeed(seed) {
    if (typeof seed === 'number') {
      WORLD_SEED = seed >>> 0;
    } else {
      const seedFn = xmur3(String(seed));
      WORLD_SEED = seedFn();
    }
  }

  /* ======================================================================
     NOISE ENGINE
     Value noise with smoothstep interpolation, layered into fBm (fractal
     Brownian motion) for natural multi-scale terrain. No external deps.
     ====================================================================== */
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Deterministic pseudo-random gradient value at an integer lattice point.
  function latticeValue2D(ix, iz, salt) {
    return hash2(ix, iz, salt) * 2 - 1; // [-1, 1]
  }

  function valueNoise2D(x, z, salt) {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const x1 = x0 + 1, z1 = z0 + 1;
    const tx = smoothstep(x - x0);
    const tz = smoothstep(z - z0);

    const v00 = latticeValue2D(x0, z0, salt);
    const v10 = latticeValue2D(x1, z0, salt);
    const v01 = latticeValue2D(x0, z1, salt);
    const v11 = latticeValue2D(x1, z1, salt);

    const ix0 = lerp(v00, v10, tx);
    const ix1 = lerp(v01, v11, tx);
    return lerp(ix0, ix1, tz); // [-1, 1]
  }

  function latticeValue3D(ix, iy, iz, salt) {
    return hash3(ix, iy, iz, salt) * 2 - 1;
  }

  function valueNoise3D(x, y, z, salt) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
    const tx = smoothstep(x - x0);
    const ty = smoothstep(y - y0);
    const tz = smoothstep(z - z0);

    const v000 = latticeValue3D(x0, y0, z0, salt);
    const v100 = latticeValue3D(x1, y0, z0, salt);
    const v010 = latticeValue3D(x0, y1, z0, salt);
    const v110 = latticeValue3D(x1, y1, z0, salt);
    const v001 = latticeValue3D(x0, y0, z1, salt);
    const v101 = latticeValue3D(x1, y0, z1, salt);
    const v011 = latticeValue3D(x0, y1, z1, salt);
    const v111 = latticeValue3D(x1, y1, z1, salt);

    const ix00 = lerp(v000, v100, tx);
    const ix10 = lerp(v010, v110, tx);
    const ix01 = lerp(v001, v101, tx);
    const ix11 = lerp(v011, v111, tx);
    const iy0 = lerp(ix00, ix10, ty);
    const iy1 = lerp(ix01, ix11, ty);
    return lerp(iy0, iy1, tz); // [-1, 1]
  }

  // Fractal Brownian motion: layers of noise at decreasing amplitude /
  // increasing frequency ("large + medium + small scale noise -> natural terrain").
  function fbm2D(x, z, opts) {
    const octaves = opts.octaves || 4;
    const baseFreq = opts.frequency || 0.01;
    const lacunarity = opts.lacunarity || 2.0;
    const gain = opts.gain || 0.5;
    const salt = opts.salt || 0;

    let amplitude = 1;
    let frequency = baseFreq;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += valueNoise2D(x * frequency, z * frequency, salt + o * 101) * amplitude;
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm; // [-1, 1]
  }

  function fbm3D(x, y, z, opts) {
    const octaves = opts.octaves || 3;
    const baseFreq = opts.frequency || 0.05;
    const lacunarity = opts.lacunarity || 2.0;
    const gain = opts.gain || 0.5;
    const salt = opts.salt || 0;

    let amplitude = 1;
    let frequency = baseFreq;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += valueNoise3D(x * frequency, y * frequency, z * frequency, salt + o * 131) * amplitude;
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  }

  // "Ridge" noise (1 - |noise|) used for mountain ridgelines - creates sharp
  // peaks/valleys instead of smooth rolling hills.
  function ridgeNoise2D(x, z, opts) {
    const n = fbm2D(x, z, opts);
    return 1 - Math.abs(n);
  }

  /* ======================================================================
     MULTI-LAYER TERRAIN GENERATION
     Continentalness -> Elevation -> Temperature+Moisture -> Biome Selection
     -> Terrain Shape -> Surface/Underground -> Caves+Ores -> Vegetation+Structures
     ====================================================================== */

  // Continentalness: large-scale noise deciding deep ocean / ocean / coast /
  // inland / large landmass / mountainous interior. Very low frequency so
  // landmasses are large and coherent, not speckled.
  function continentalness(x, z) {
    return fbm2D(x, z, { frequency: 0.0018, octaves: 4, salt: 1000 }); // [-1, 1]
  }

  function temperature(x, z) {
    return fbm2D(x, z, { frequency: 0.0027, octaves: 3, salt: 2000 }); // [-1, 1]
  }

  function moisture(x, z) {
    return fbm2D(x, z, { frequency: 0.0031, octaves: 3, salt: 3000 }); // [-1, 1]
  }

  // Mountain "ridge" mask - only meaningfully active where continentalness
  // says we're in a mountainous interior, so ranges form geographically
  // rather than popping up mid-ocean.
  function mountainMask(x, z) {
    return ridgeNoise2D(x, z, { frequency: 0.006, octaves: 5, salt: 4000, gain: 0.55 }); // [0, 1]
  }

  // River carve value: rivers follow the zero-crossing of a dedicated noise
  // field, so they form continuous winding paths rather than random strips.
  function riverField(x, z) {
    return fbm2D(x, z, { frequency: 0.004, octaves: 2, salt: 5000 });
  }

  const CONTINENT = {
    DEEP_OCEAN: -0.55,
    OCEAN: -0.25,
    COAST: -0.16,
    INLAND: 0.35,
    // above INLAND => mountainous interior
  };

  function continentZone(c) {
    if (c < CONTINENT.DEEP_OCEAN) return 'deep_ocean';
    if (c < CONTINENT.OCEAN) return 'ocean';
    if (c < CONTINENT.COAST) return 'coast';
    if (c < CONTINENT.INLAND) return 'inland';
    return 'mountain_interior';
  }

  /* ======================================================================
     BIOME SYSTEM
     Each biome defines its own generation parameters rather than just a
     surface-block swap.
     ====================================================================== */
  const BIOMES = {
    OCEAN:        { id: 'ocean', baseHeight: -6, roughness: 0.3, surface: 'sand', sub: 'sand', underground: 'stone',
                     treeDensity: 0, treeType: null, vegDensity: 0, snow: false },
    RIVER:        { id: 'river', baseHeight: 1, roughness: 0.2, surface: 'sand', sub: 'sand', underground: 'stone',
                     treeDensity: 0, treeType: null, vegDensity: 0.02, snow: false },
    BEACH:        { id: 'beach', baseHeight: 2, roughness: 0.15, surface: 'sand', sub: 'sand', underground: 'stone',
                     treeDensity: 0, treeType: null, vegDensity: 0.01, snow: false },
    PLAINS:       { id: 'plains', baseHeight: 3, roughness: 0.6, surface: 'grass', sub: 'dirt', underground: 'stone',
                     treeDensity: 0.004, treeType: 'oak', vegDensity: 0.10, snow: false },
    FOREST:       { id: 'forest', baseHeight: 4, roughness: 1.0, surface: 'grass', sub: 'dirt', underground: 'stone',
                     treeDensity: 0.035, treeType: 'oak', vegDensity: 0.14, snow: false },
    DENSE_FOREST: { id: 'dense_forest', baseHeight: 4, roughness: 1.2, surface: 'grass', sub: 'dirt', underground: 'stone',
                     treeDensity: 0.07, treeType: 'oak', vegDensity: 0.22, snow: false },
    DESERT:       { id: 'desert', baseHeight: 3, roughness: 0.8, surface: 'sand', sub: 'sand', underground: 'stone',
                     treeDensity: 0.006, treeType: 'cactus', vegDensity: 0.02, snow: false },
    SAVANNA:      { id: 'savanna', baseHeight: 3, roughness: 0.7, surface: 'grass', sub: 'dirt', underground: 'stone',
                     treeDensity: 0.008, treeType: 'oak', vegDensity: 0.06, snow: false },
    TAIGA:        { id: 'taiga', baseHeight: 5, roughness: 1.4, surface: 'grass', sub: 'dirt', underground: 'stone',
                     treeDensity: 0.04, treeType: 'spruce', vegDensity: 0.08, snow: false },
    SNOWY_PLAINS: { id: 'snowy_plains', baseHeight: 3, roughness: 0.6, surface: 'snow', sub: 'dirt', underground: 'stone',
                     treeDensity: 0.003, treeType: 'spruce', vegDensity: 0.02, snow: true },
    MOUNTAINS:    { id: 'mountains', baseHeight: 14, roughness: 2.2, surface: 'stone', sub: 'stone', underground: 'stone',
                     treeDensity: 0.006, treeType: 'spruce', vegDensity: 0.01, snow: false },
    SNOW_MOUNTAINS:{ id: 'snow_mountains', baseHeight: 18, roughness: 2.6, surface: 'snow', sub: 'stone', underground: 'stone',
                     treeDensity: 0.003, treeType: 'spruce', vegDensity: 0.005, snow: true },
    SWAMP:        { id: 'swamp', baseHeight: 2, roughness: 0.4, surface: 'dirt', sub: 'dirt', underground: 'stone',
                     treeDensity: 0.02, treeType: 'oak', vegDensity: 0.20, snow: false },
  };

  // Biome selection from continentalness + temperature + moisture + the
  // mountain mask. Ocean/coast/river handled by continentalness & rivers
  // first (geography), then temp/moisture pick a land biome.
  function selectBiome(x, z) {
    const c = continentalness(x, z);
    const zone = continentZone(c);

    if (zone === 'deep_ocean' || zone === 'ocean') return BIOMES.OCEAN;

    const river = riverField(x, z);
    const isRiver = Math.abs(river) < 0.02 && zone !== 'coast';
    if (isRiver) return BIOMES.RIVER;

    if (zone === 'coast') return BIOMES.BEACH;

    const t = temperature(x, z);
    const m = moisture(x, z);
    const mtn = mountainMask(x, z);

    if (zone === 'mountain_interior' && mtn > 0.55) {
      return t < -0.15 ? BIOMES.SNOW_MOUNTAINS : BIOMES.MOUNTAINS;
    }

    // Land biome from temperature/moisture (classic Whittaker-style grid).
    if (t < -0.35) return m > 0.1 ? BIOMES.TAIGA : BIOMES.SNOWY_PLAINS;
    if (t < 0.05) return m > 0.35 ? BIOMES.DENSE_FOREST : (m > 0.0 ? BIOMES.FOREST : BIOMES.PLAINS);
    if (t < 0.4) {
      if (m > 0.45) return BIOMES.SWAMP;
      if (m > 0.05) return BIOMES.FOREST;
      return BIOMES.PLAINS;
    }
    // hot
    if (m > 0.35) return BIOMES.SWAMP;
    if (m > 0.0) return BIOMES.SAVANNA;
    return BIOMES.DESERT;
  }

  /* ======================================================================
     ELEVATION / TERRAIN SHAPE
     Combine large + medium + small scale noise, plus mountain ridges, into
     a single terrain height. Snow line handled as a Y-based transition in
     column generation, not here.
     ====================================================================== */
  function terrainHeight(x, z, biome) {
    const c = continentalness(x, z);

    // Large-scale base shape, medium hills, small detail.
    const large = fbm2D(x, z, { frequency: 0.006, octaves: 3, salt: 10 });
    const medium = fbm2D(x, z, { frequency: 0.02, octaves: 3, salt: 20 });
    const small = fbm2D(x, z, { frequency: 0.08, octaves: 2, salt: 30 });

    let height = biome.baseHeight
      + large * 6 * biome.roughness
      + medium * 2.5 * biome.roughness
      + small * 1.0 * biome.roughness;

    // Mountain ridge contribution - only where continentalness supports it,
    // scaled by the ridge mask so ranges taper naturally into foothills.
    const mtn = mountainMask(x, z);
    if (continentZone(c) === 'mountain_interior') {
      const ridgeDetail = fbm2D(x, z, { frequency: 0.03, octaves: 3, salt: 40 });
      height += Math.pow(mtn, 2) * 26 + ridgeDetail * mtn * 4;
    }

    // Ocean floor slopes down smoothly from coast to deep ocean rather than
    // a hard step, so coastlines feel natural.
    if (biome.id === 'ocean') {
      const depthT = Math.min(1, Math.max(0, (CONTINENT.OCEAN - c) / 0.6));
      height = biome.baseHeight - depthT * 10;
    }

    // Rivers carve a shallow channel toward sea level with a deeper center.
    if (biome.id === 'river') {
      const river = riverField(x, z);
      const centerT = 1 - Math.min(1, Math.abs(river) / 0.02);
      height = lerp(height, CONFIG.SEA_LEVEL - 2, centerT);
    }

    return Math.round(height);
  }

  /* ======================================================================
     3D CAVE GENERATION
     3D noise carves natural tunnel networks + chambers, deterministic from
     seed + coordinates so caves survive chunk unload/reload unchanged.
     ====================================================================== */
  function isCave(x, y, z) {
    if (y > 14) return false; // caves only meaningfully appear well underground
    // Two 3D fields combined: one for winding tunnels, one for larger
    // chambers. A block is "cave" (air) where both indicate open space,
    // producing branching networks rather than uniform noise holes.
    const tunnels = fbm3D(x, y * 1.5, z, { frequency: 0.045, octaves: 3, salt: 6000 });
    const chambers = fbm3D(x, y * 0.8, z, { frequency: 0.09, octaves: 2, salt: 7000 });

    const tunnelOpen = Math.abs(tunnels) < 0.045;              // thin iso-surface -> tunnel walls
    const chamberOpen = chambers > 0.42;                        // blobs -> larger rooms

    // Taper caves out near the surface so they don't punch through into
    // daylight everywhere.
    const depthFactor = Math.min(1, Math.max(0, (10 - y) / 24));
    return (tunnelOpen || chamberOpen) && Math.random() >= 0 && depthFactor > 0.15 && (tunnelOpen ? true : chamberOpen);
  }

  // Underground lakes: pockets of water in deep chambers, deterministic.
  function isUndergroundLake(x, y, z) {
    if (y > -2 || y < -18) return false;
    const n = fbm3D(x, y, z, { frequency: 0.06, octaves: 2, salt: 8000 });
    return n > 0.5;
  }

  /* ======================================================================
     DEPTH-BASED ORE GENERATION (veins, not lone blocks)
     ====================================================================== */
  // Deterministic vein shapes: a small set of relative-offset patterns
  // matching the "veins vary in size/shape/density/depth/orientation" spec.
  const VEIN_SHAPES = [
    [[0, 0, 0]],
    [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    [[0, 0, 0], [0, 1, 0], [1, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]],
    [[0, 0, 0], [1, 0, 1], [0, 1, 1], [-1, 0, 0]],
  ];

  function oreAt(x, y, z, blockAboveWasStone) {
    if (!blockAboveWasStone) return null; // ore only replaces stone
    for (const oreName in CONFIG.ORE_BANDS) {
      const band = CONFIG.ORE_BANDS[oreName];
      if (y < band.min || y > band.max) continue;

      // Pick a vein "origin" on a coarse 3D grid cell; every block checks
      // whether it falls within that cell's vein shape. This keeps veins
      // spatially clustered instead of scattering single blocks.
      const cellSize = 4;
      const cx = Math.floor(x / cellSize) * cellSize;
      const cy = Math.floor(y / cellSize) * cellSize;
      const cz = Math.floor(z / cellSize) * cellSize;

      const roll = hash3(cx, cy, cz, 9000 + oreName.length * 17 + oreName.charCodeAt(0));
      if (roll >= band.chance * cellSize * cellSize * cellSize) continue;

      const shapeIdx = Math.floor(hash3(cx, cy, cz, 9500) * VEIN_SHAPES.length);
      const shape = VEIN_SHAPES[shapeIdx];
      const originOffsetX = Math.floor(hash3(cx, cy, cz, 9600) * cellSize);
      const originOffsetY = Math.floor(hash3(cx, cy, cz, 9700) * cellSize);
      const originOffsetZ = Math.floor(hash3(cx, cy, cz, 9800) * cellSize);
      const ox = cx + originOffsetX, oy = cy + originOffsetY, oz = cz + originOffsetZ;

      for (const off of shape) {
        if (ox + off[0] === x && oy + off[1] === y && oz + off[2] === z) {
          return oreName;
        }
      }
    }
    return null;
  }

  const ORE_BLOCK_NAMES = {
    coal: 'iron_ore',       // no distinct coal block in the existing palette; reuse iron_ore look
    iron: 'iron_ore',
    gold: 'iron_ore',       // existing game has no gold_ore block type - see integration notes
    diamond: 'diamond_ore',
  };

  /* ======================================================================
     CHUNK DATA SYSTEM
     Chunk { chunkX, chunkZ, blocks (Map), biome data, height data,
     generated features, state }
     ====================================================================== */
  const ChunkState = {
    UNGENERATED: 'ungenerated',
    GENERATING: 'generating',
    GENERATED: 'generated',
    LOADED: 'loaded',
    UNLOADED: 'unloaded',
  };

  function chunkKey(cx, cz) { return cx + ',' + cz; }

  function worldToChunk(x, z) {
    return [Math.floor(x / CONFIG.CHUNK_SIZE), Math.floor(z / CONFIG.CHUNK_SIZE)];
  }

  class Chunk {
    constructor(chunkX, chunkZ) {
      this.chunkX = chunkX;
      this.chunkZ = chunkZ;
      this.state = ChunkState.UNGENERATED;
      this.heightMap = null;     // Int16Array[CHUNK_SIZE*CHUNK_SIZE]
      this.biomeMap = null;      // biome id string per column
      this.blockCount = 0;
    }
  }

  const chunks = new Map();          // key -> Chunk

  // ShardedBlockMap: drop-in replacement for the flat `Map<"x,y,z", blockType>`
  // previously used as `worldMap`. Backed by Map<chunkKey, Map<"x,y,z", blockType>>
  // so an entire chunk's blocks can be discarded with a single outer .delete()
  // instead of thousands of individual flat-map .delete() calls (the proven
  // cause of the 900-1800ms unloadChunk() GC/Mark-Compact spikes).
  //
  // Exposes the same surface index.html and this file actually use:
  // .get(key), .set(key,val), .delete(key), .has(key), .clear(), .size.
  // The full "x,y,z" string key is preserved as-is (both as the argument and
  // as the inner map's key), so getBlockKey()'s output format is unchanged
  // and no other code needs to know sharding exists.
  function createShardedBlockMap(CHUNK_SIZE) {
    const shards = new Map(); // chunkKey -> Map<"x,y,z", blockType>
    let liveSize = 0;

    function chunkKeyForCoords(x, z) {
      const cx = Math.floor(x / CHUNK_SIZE);
      const cz = Math.floor(z / CHUNK_SIZE);
      return cx + ',' + cz;
    }

    // Parses "x,y,z" back into numbers to compute the shard. Runs on every
    // get/set/delete, so kept allocation-light (no regex, no split()).
    function parseKeyToCoords(key) {
      const first = key.indexOf(',');
      const second = key.indexOf(',', first + 1);
      const x = Number(key.slice(0, first));
      const z = Number(key.slice(second + 1));
      return [x, z];
    }

    return {
      get(key) {
        const [x, z] = parseKeyToCoords(key);
        const shard = shards.get(chunkKeyForCoords(x, z));
        return shard ? shard.get(key) : undefined;
      },
      set(key, value) {
        const [x, z] = parseKeyToCoords(key);
        const ck = chunkKeyForCoords(x, z);
        let shard = shards.get(ck);
        if (!shard) {
          shard = new Map();
          shards.set(ck, shard);
        }
        if (!shard.has(key)) liveSize++;
        shard.set(key, value);
        return this;
      },
      delete(key) {
        const [x, z] = parseKeyToCoords(key);
        const ck = chunkKeyForCoords(x, z);
        const shard = shards.get(ck);
        if (!shard) return false;
        const had = shard.delete(key);
        if (had) {
          liveSize--;
          if (shard.size === 0) shards.delete(ck); // drop empty shard entirely
        }
        return had;
      },
      has(key) {
        const [x, z] = parseKeyToCoords(key);
        const shard = shards.get(chunkKeyForCoords(x, z));
        return shard ? shard.has(key) : false;
      },
      clear() {
        shards.clear();
        liveSize = 0;
      },
      get size() {
        return liveSize;
      },
      // Sharding-aware fast path: drop an ENTIRE chunk's blocks in O(1),
      // used by unloadChunk() instead of looping getBlockKey()+delete()
      // CHUNK_SIZE*CHUNK_SIZE*(heightRange) times.
      deleteChunk(chunkX, chunkZ) {
        const ck = chunkX + ',' + chunkZ;
        const shard = shards.get(ck);
        if (!shard) return 0;
        const count = shard.size;
        shards.delete(ck);
        liveSize -= count;
        return count;
      },
      // Diagnostics only (not part of the original Map API).
      _shardCount() { return shards.size; },
    };
  }

  const worldMap = global.worldMap || createShardedBlockMap(CONFIG.CHUNK_SIZE); // "x,y,z" -> blockType (shared with index.html), sharded per-chunk internally
  const dirtyChunks = new Set();     // chunk keys touched since last consume (for mesh rebuild)
  const unloadedChunks = new Set();  // chunk keys unloaded since last consume (for mesh teardown)

  function getBlockKey(x, y, z) {
    return Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z);
  }

  function markDirtyAtBlock(x, z) {
    const [cx, cz] = worldToChunk(x, z);
    dirtyChunks.add(chunkKey(cx, cz));
    // Also mark neighboring chunks dirty if the block sits on a chunk
    // border, since a face-culling mesh in the neighbor may need to change.
    const localX = ((Math.floor(x) % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    const localZ = ((Math.floor(z) % CONFIG.CHUNK_SIZE) + CONFIG.CHUNK_SIZE) % CONFIG.CHUNK_SIZE;
    if (localX === 0) dirtyChunks.add(chunkKey(cx - 1, cz));
    if (localX === CONFIG.CHUNK_SIZE - 1) dirtyChunks.add(chunkKey(cx + 1, cz));
    if (localZ === 0) dirtyChunks.add(chunkKey(cx, cz - 1));
    if (localZ === CONFIG.CHUNK_SIZE - 1) dirtyChunks.add(chunkKey(cx, cz + 1));
  }

  /* ---- getBlock/setBlock/removeBlock: compatible with index.html ---- */
  function getBlock(x, y, z) {
    return worldMap.get(getBlockKey(x, y, z));
  }
  function setBlock(x, y, z, type) {
    worldMap.set(getBlockKey(x, y, z), type);
    markDirtyAtBlock(x, z);
  }
  function removeBlock(x, y, z) {
    worldMap.delete(getBlockKey(x, y, z));
    markDirtyAtBlock(x, z);
  }

  /* ======================================================================
     TREE / VEGETATION GENERATOR
     ====================================================================== */
  function placeTree(x, groundY, z, treeType) {
    if (treeType === 'cactus') {
      const h = 2 + Math.floor(hash3(x, groundY, z, 20001) * 2);
      for (let y = groundY + 1; y <= groundY + h; y++) {
        if (!getBlock(x, y, z)) setBlock(x, y, z, 'log'); // no dedicated cactus block in palette
      }
      return;
    }

    const trunkHeight = treeType === 'spruce'
      ? 5 + Math.floor(hash3(x, groundY, z, 20002) * 2)
      : 4 + Math.floor(hash3(x, groundY, z, 20003) * 2);

    for (let dy = 1; dy <= trunkHeight; dy++) {
      setBlock(x, groundY + dy, z, 'log');
    }

    const canopyCenterY = groundY + trunkHeight;
    const canopyRadius = treeType === 'spruce' ? 1 : 2;
    for (let lx = x - canopyRadius; lx <= x + canopyRadius; lx++) {
      for (let ly = canopyCenterY - 1; ly <= canopyCenterY + 2; ly++) {
        for (let lz = z - canopyRadius; lz <= z + canopyRadius; lz++) {
          const dist = Math.abs(lx - x) + Math.abs(ly - canopyCenterY) + Math.abs(lz - z);
          const maxDist = treeType === 'spruce' ? (canopyCenterY + 2 - ly >= 0 ? 2 : 3) : 3;
          if (dist <= maxDist && !getBlock(lx, ly, lz)) {
            setBlock(lx, ly, lz, 'leaves');
          }
        }
      }
    }
  }

  function generateVegetationForColumn(x, z, groundY, biome) {
    if (biome.treeDensity > 0 && hash2(x, z, 30001) < biome.treeDensity) {
      placeTree(x, groundY, z, biome.treeType);
      return; // don't stack ground vegetation under a tree we just placed
    }
    if (biome.vegDensity > 0 && hash2(x, z, 30002) < biome.vegDensity) {
      // Ground vegetation reuses 'leaves' as a stand-in for grass/flowers -
      // the existing block palette has no dedicated foliage block. See
      // integration notes for adding a real flowers/tall-grass block type.
      if (!getBlock(x, groundY + 1, z)) setBlock(x, groundY + 1, z, 'leaves');
    }
  }

  /* ======================================================================
     STRUCTURE GENERATOR (biome-aware)
     Deterministic per-chunk placement so structures are identical on reload.
     ====================================================================== */
  function tryPlaceStructure(chunkX, chunkZ, biome) {
    // One structure roll per chunk, biome-gated, using a chunk-scoped hash
    // so placement is deterministic and independent of generation order.
    const roll = hash3(chunkX, 0, chunkZ, 40001);
    if (roll > 0.05) return; // ~5% of chunks in eligible biomes get a structure

    const baseX = chunkX * CONFIG.CHUNK_SIZE + 3 + Math.floor(hash3(chunkX, 1, chunkZ, 40002) * (CONFIG.CHUNK_SIZE - 6));
    const baseZ = chunkZ * CONFIG.CHUNK_SIZE + 3 + Math.floor(hash3(chunkX, 2, chunkZ, 40003) * (CONFIG.CHUNK_SIZE - 6));

    if (biome.id === 'plains') return placeHouse(baseX, baseZ, 'cobblestone');
    if (biome.id === 'desert') return placeHouse(baseX, baseZ, 'sand');
    if (biome.id === 'taiga') return placeHouse(baseX, baseZ, 'log');
    if (biome.id === 'swamp') return placeHouse(baseX, baseZ, 'log');
    if (biome.id === 'mountains') return placeHouse(baseX, baseZ, 'stone');
    // Ocean/river/beach/mountain-peak biomes: no structure this pass.
  }

  function placeHouse(hx, hz, wallMaterial) {
    const groundY = terrainHeight(hx, hz, selectBiome(hx, hz));
    if (getBiomeAt(hx, hz).id === 'ocean' || getBiomeAt(hx, hz).id === 'river') return; // avoid water

    for (let x = hx; x < hx + 6; x++) {
      for (let z = hz; z < hz + 5; z++) {
        for (let y = groundY + 1; y < groundY + 8; y++) {
          removeBlock(x, y, z);
        }
        setBlock(x, groundY, z, 'wood');
        const isWall = (x === hx || x === hx + 5 || z === hz || z === hz + 4);
        if (isWall) {
          for (let y = groundY + 1; y <= groundY + 4; y++) {
            setBlock(x, y, z, wallMaterial);
          }
        }
      }
    }
    removeBlock(hx + 2, groundY + 1, hz);
    removeBlock(hx + 2, groundY + 2, hz);
    for (let x = hx - 1; x <= hx + 6; x++) {
      for (let z = hz - 1; z <= hz + 5; z++) {
        setBlock(x, groundY + 5, z, 'wood');
      }
    }
  }

  /* ======================================================================
     Biome/height lookup with light caching (per-column, avoids recompute
     across cave/ore/vegetation passes for the same x,z).
     ====================================================================== */
  const columnCache = new Map(); // "x,z" -> { biome, height }
  function getColumnData(x, z) {
    const key = x + ',' + z;
    let entry = columnCache.get(key);
    if (entry) return entry;
    const biome = selectBiome(x, z);
    const height = terrainHeight(x, z, biome);
    entry = { biome, height };
    columnCache.set(key, entry);
    if (columnCache.size > 20000) columnCache.clear(); // simple bound, terrain is cheap to recompute
    return entry;
  }
  function getBiomeAt(x, z) { return getColumnData(x, z).biome; }
  function getHeightAt(x, z) { return getColumnData(x, z).height; }

  /* ======================================================================
     TERRAIN GENERATOR: generateChunk(chunkX, chunkZ, seed)
     Deterministic: same chunkX/chunkZ/seed always produce the same blocks.
     ====================================================================== */
  function generateChunk(chunkX, chunkZ) {
    const key = chunkKey(chunkX, chunkZ);
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(chunkX, chunkZ);
      chunks.set(key, chunk);
    }
    if (chunk.state === ChunkState.GENERATED || chunk.state === ChunkState.LOADED) {
      return chunk; // already generated - don't regenerate (idempotent load)
    }
    chunk.state = ChunkState.GENERATING;

    const baseX = chunkX * CONFIG.CHUNK_SIZE;
    const baseZ = chunkZ * CONFIG.CHUNK_SIZE;
    const size = CONFIG.CHUNK_SIZE;
    let structureBiome = null;

    for (let lx = 0; lx < size; lx++) {
      for (let lz = 0; lz < size; lz++) {
        const x = baseX + lx;
        const z = baseZ + lz;
        const { biome, height } = getColumnData(x, z);
        if (!structureBiome) structureBiome = biome;

        // Column fill from bedrock up to surface, carving caves as we go.
        for (let y = CONFIG.WORLD_MIN_Y; y <= height; y++) {
          if (y === CONFIG.WORLD_MIN_Y) {
            setBlockRaw(x, y, z, 'bedrock');
            continue;
          }

          if (isCave(x, y, z) && y < height - 1) {
            if (isUndergroundLake(x, y, z)) setBlockRaw(x, y, z, 'gravel'); // lake floor marker; water rendered by existing water system
            continue; // leave as air (cave)
          }

          let blockType;
          if (y === height) {
            blockType = biome.surface;
            // Snow line: high elevations in cold/mountain biomes transition
            // grass -> stone -> snow rather than a hard biome swap.
            if (!biome.snow && height > 22) blockType = 'stone';
            if (biome.snow || height > 30) blockType = 'snow';
          } else if (y > height - 4) {
            blockType = biome.sub;
          } else {
            blockType = biome.underground;
            const ore = oreAt(x, y, z, blockType === 'stone');
            if (ore) blockType = ORE_BLOCK_NAMES[ore];
          }
          setBlockRaw(x, y, z, blockType);
        }

        // Ocean/river fill: water blocks are represented implicitly by the
        // existing renderer's Water plane at CONFIG.SEA_LEVEL, matching how
        // index.html already renders its single water surface - see
        // integration notes regarding per-region water surfaces.
      }
    }

    // Vegetation pass (after terrain so tree placement sees final heights).
    for (let lx = 2; lx < size - 2; lx++) {
      for (let lz = 2; lz < size - 2; lz++) {
        const x = baseX + lx;
        const z = baseZ + lz;
        const { biome, height } = getColumnData(x, z);
        if (biome.id === 'ocean' || biome.id === 'river') continue;
        generateVegetationForColumn(x, z, height, biome);
      }
    }

    // Structure pass (deterministic, ~one roll per chunk).
    if (structureBiome) tryPlaceStructure(chunkX, chunkZ, structureBiome);

    chunk.state = ChunkState.GENERATED;
    dirtyChunks.add(key);
    return chunk;
  }

  // Internal write used during generation: sets a block without re-marking
  // dirty for every single block (the whole chunk is marked dirty once at
  // the end of generateChunk instead, which is far cheaper).
  function setBlockRaw(x, y, z, type) {
    worldMap.set(getBlockKey(x, y, z), type);
  }

  /* ======================================================================
     WORLD STREAMING
     Track player chunk, generate/load nearby chunks, unload distant ones,
     each frame (called from index.html's game loop via WorldGen.update()).
     ====================================================================== */
  let playerChunkX = 0;
  let playerChunkZ = 0;
  let lastStreamedChunkX = null;
  let lastStreamedChunkZ = null;

  function setPlayerPosition(x, z) {
    const [cx, cz] = worldToChunk(x, z);
    playerChunkX = cx;
    playerChunkZ = cz;
  }

  function unloadChunk(key, chunk) {
    // Remove this chunk's blocks from worldMap to free memory. Terrain is
    // deterministic, so it regenerates identically if the player returns.
    // worldMap is a ShardedBlockMap: drop the whole per-chunk shard in O(1)
    // instead of looping ~14k individual Map.delete() calls (this loop was
    // the proven cause of the 900-1800ms GC/Mark-Compact freeze spikes).
    if (typeof worldMap.deleteChunk === 'function') {
      worldMap.deleteChunk(chunk.chunkX, chunk.chunkZ);
    } else {
      // Fallback if worldMap was ever swapped for a plain Map externally.
      const baseX = chunk.chunkX * CONFIG.CHUNK_SIZE;
      const baseZ = chunk.chunkZ * CONFIG.CHUNK_SIZE;
      for (let lx = 0; lx < CONFIG.CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CONFIG.CHUNK_SIZE; lz++) {
          for (let y = CONFIG.WORLD_MIN_Y; y <= CONFIG.WORLD_MAX_Y; y++) {
            worldMap.delete(getBlockKey(baseX + lx, y, baseZ + lz));
          }
        }
      }
    }
    chunk.state = ChunkState.UNLOADED;
    chunks.delete(key);
    unloadedChunks.add(key);
  }

  function getMissingChunksWithinRadius(radius) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        if (dist > radius) continue;
        const cx = playerChunkX + dx;
        const cz = playerChunkZ + dz;
        const key = chunkKey(cx, cz);
        const existing = chunks.get(key);
        if (existing && (existing.state === ChunkState.GENERATED || existing.state === ChunkState.LOADED)) {
          existing.state = ChunkState.LOADED;
          continue;
        }
        candidates.push([dist, cx, cz]);
      }
    }
    candidates.sort((a, b) => a[0] - b[0]);
    return candidates;
  }

  function streamChunks(maxNewChunks, radius) {
    let generatedThisTick = 0;
    for (const [, cx, cz] of getMissingChunksWithinRadius(radius)) {
      if (generatedThisTick >= maxNewChunks) break;
      const key = chunkKey(cx, cz);
      generateChunk(cx, cz);
      const chunk = chunks.get(key);
      if (chunk) chunk.state = ChunkState.LOADED;
      generatedThisTick++;
    }
    return generatedThisTick;
  }

  function unloadDistantChunks() {
    // Unload chunks beyond UNLOAD_RADIUS.
    for (const [key, chunk] of chunks.entries()) {
      const dist = Math.max(Math.abs(chunk.chunkX - playerChunkX), Math.abs(chunk.chunkZ - playerChunkZ));
      if (dist > CONFIG.UNLOAD_RADIUS) {
        unloadChunk(key, chunk);
        dirtyChunks.delete(key);
      }
    }
  }

  function update() {
    // Re-scan when the player enters a new chunk, and also while there are
    // still missing chunks inside the generation radius. The old early return
    // stopped after the first capped batch, so Terra never registered the rest
    // of the world until the player crossed a chunk boundary.
    const sameChunk = playerChunkX === lastStreamedChunkX && playerChunkZ === lastStreamedChunkZ;
    if (sameChunk && getMissingChunksWithinRadius(CONFIG.GENERATE_RADIUS).length === 0) return;
    lastStreamedChunkX = playerChunkX;
    lastStreamedChunkZ = playerChunkZ;

    streamChunks(CONFIG.MAX_CHUNK_GENS_PER_TICK, CONFIG.GENERATE_RADIUS);
    unloadDistantChunks();
  }

  function streamInitialChunks() {
    // Build all chunks the renderer can see before the first frame. This keeps
    // the initial launch from presenting a black/empty world while preserving
    // the per-frame generation cap for normal movement.
    const needed = Math.pow(CONFIG.RENDER_RADIUS * 2 + 1, 2);
    streamChunks(needed, CONFIG.RENDER_RADIUS);
    unloadDistantChunks();
  }

  function consumeDirtyChunks() {
    const list = [];
    for (const key of dirtyChunks) {
      const parts = key.split(',');
      list.push({ chunkX: Number(parts[0]), chunkZ: Number(parts[1]) });
    }
    dirtyChunks.clear();
    return list;
  }

  function consumeUnloadedChunks() {
    const list = [];
    for (const key of unloadedChunks) {
      const parts = key.split(',');
      list.push({ chunkX: Number(parts[0]), chunkZ: Number(parts[1]) });
    }
    unloadedChunks.clear();
    return list;
  }

  function chunkKeyForBlock(x, z) {
    const [cx, cz] = worldToChunk(x, z);
    return chunkKey(cx, cz);
  }

  /* ======================================================================
     PUBLIC API
     ====================================================================== */
  function init(seed) {
    setSeed(seed !== undefined ? seed : Date.now());
    worldMap.clear();
    chunks.clear();
    dirtyChunks.clear();
    unloadedChunks.clear();
    columnCache.clear();
    lastStreamedChunkX = null;
    lastStreamedChunkZ = null;
    // Force-stream the initial area around the origin/player immediately.
    setPlayerPosition(0, 0);
    streamInitialChunks();
  }

  const WorldGen = {
    CONFIG,
    CHUNK_SIZE: CONFIG.CHUNK_SIZE,
    ChunkState,
    init,
    setSeed,
    setPlayerPosition,
    update,
    consumeDirtyChunks,
    consumeUnloadedChunks,
    chunkKeyForBlock,
    worldToChunk,
    generateChunk,
    getBiomeAt,
    getHeightAt,
    // Compatible with index.html's existing world.js contract:
    getBlock,
    setBlock,
    removeBlock,
    worldMap,
  };

  global.WorldGen = WorldGen;
  // Also expose worldMap/getBlock/setBlock/removeBlock as globals so they
  // are drop-in compatible with index.html's existing (non-namespaced)
  // calls to these four names.
  global.worldMap = worldMap;
  global.getBlock = getBlock;
  global.setBlock = setBlock;
  global.removeBlock = removeBlock;

})(typeof window !== 'undefined' ? window : globalThis);
