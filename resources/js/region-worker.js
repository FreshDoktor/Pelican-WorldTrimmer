// Web worker of the world map: turns one region file into a picture of it seen from above, plus the
// values of each of its chunks the map filters by. Runs after block-colors.js, which it is joined with.
//
// Message in:  { id, buffer: ArrayBuffer (the .mca file), nether: bool }
// Message out: { id, rgba, thumb, state, inhabited, lastUpdate, timestamps, full, dataVersion } or { id, error }
//
// The region file is dropped as soon as it is read, only the picture and the values are sent back.

'use strict';

const SECTOR = 4096;
const SIZE = 512; // blocks along one side of a region
const THUMB = 64;

// Flags of BLOCK_COLORS entries, as defined by MCA Selector.
const TRANSPARENT = 1;
const GRASS_TINT = 2;
const FOLIAGE_TINT = 4;
const WATER = 8;
const STATIC_TINT = 32;
const STATIC_COLOR = 64;
const DRY_FOLIAGE_TINT = 128;

// Chunk states sent back.
const MISSING = 0;
const RENDERED = 1;
const UNREADABLE = 2;

const UNKNOWN_COLOR = 0x8a8a8a; // blocks without a known color, e.g. of mods
const UNREADABLE_COLOR = 0x4a4a4a;
const NO_HEIGHT = -32768;

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void']);
const DEFAULT_TINTS = BIOME_TINTS.plains || [0x91bd59, 0x77ab2f, 0x3f76e4, 0xa37546];

// Block ids before 1.13, mapped to the names their colors are known by.
const LEGACY_BLOCKS = {
    1: 'stone', 2: 'grass_block', 3: 'dirt', 4: 'cobblestone', 5: 'oak_planks', 7: 'bedrock', 8: 'water', 9: 'water',
    10: 'lava', 11: 'lava', 12: 'sand', 13: 'gravel', 14: 'gold_ore', 15: 'iron_ore', 16: 'coal_ore', 17: 'oak_log',
    18: 'oak_leaves', 20: 'glass', 24: 'sandstone', 31: 'short_grass', 32: 'dead_bush', 35: 'white_wool', 37: 'dandelion',
    38: 'poppy', 43: 'smooth_stone', 44: 'smooth_stone_slab', 45: 'bricks', 48: 'mossy_cobblestone', 49: 'obsidian',
    53: 'oak_stairs', 67: 'cobblestone_stairs', 78: 'snow', 79: 'ice', 80: 'snow_block', 81: 'cactus', 82: 'clay',
    83: 'sugar_cane', 85: 'oak_fence', 86: 'pumpkin', 87: 'netherrack', 88: 'soul_sand', 89: 'glowstone',
    98: 'stone_bricks', 99: 'brown_mushroom_block', 100: 'red_mushroom_block', 106: 'vine', 110: 'mycelium',
    111: 'lily_pad', 112: 'nether_bricks', 121: 'end_stone', 155: 'quartz_block', 159: 'white_terracotta',
    161: 'acacia_leaves', 162: 'acacia_log', 172: 'terracotta', 174: 'packed_ice', 175: 'sunflower',
};

// Top level entries of a chunk the map never needs, skipped while reading.
const SKIPPED_KEYS = new Set([
    'block_entities', 'TileEntities', 'Entities', 'entities', 'structures', 'Structures', 'block_ticks', 'fluid_ticks',
    'TileTicks', 'LiquidTicks', 'PostProcessing', 'Lights', 'LiquidsToBeTicked', 'ToBeTicked', 'CarvingMasks',
    'blending_data', 'BlockLight', 'SkyLight', 'ChunkBukkitValues', 'ForgeCaps', 'neoforge:attachments',
]);

// Blocks of mods are colored like the vanilla block their name suggests, e.g. fir_leaves like oak_leaves.
const MODDED_HINTS = [
    ['leaves', 'oak_leaves'], ['log', 'oak_log'], ['stem', 'oak_log'], ['wood', 'oak_wood'], ['planks', 'oak_planks'],
    ['grass_block', 'grass_block'], ['grass', 'short_grass'], ['fern', 'fern'], ['sand', 'sand'], ['gravel', 'gravel'],
    ['ore', 'stone'], ['stone', 'stone'], ['rock', 'stone'], ['dirt', 'dirt'], ['soil', 'dirt'], ['mud', 'mud'],
    ['clay', 'clay'], ['snow', 'snow_block'], ['ice', 'ice'], ['water', 'water'], ['mushroom', 'brown_mushroom'],
    ['rose', 'poppy'], ['flower', 'poppy'], ['bush', 'sweet_berry_bush'], ['chest', 'chest'], ['barrel', 'barrel'],
];

function moddedColor(name) {
    const path = name.slice(name.indexOf(':') + 1);

    if (BLOCK_COLORS[path] !== undefined) {
        return BLOCK_COLORS[path];
    }

    const hint = MODDED_HINTS.find(([part]) => path.includes(part));

    return hint ? BLOCK_COLORS[hint[1]] : undefined;
}

const blockCache = new Map();

/** Color and flags of a block by its full name, e.g. minecraft:stone. */
function blockInfo(name) {
    let info = blockCache.get(name);

    if (info) {
        return info;
    }

    const short = name.startsWith('minecraft:') ? name.slice(10) : name;
    const entry = name.includes(':') && !name.startsWith('minecraft:') ? moddedColor(short) : BLOCK_COLORS[short];

    if (AIR_BLOCKS.has(short)) {
        info = { name: short, color: 0, flags: TRANSPARENT };
    } else if (entry === undefined) {
        info = { name: short, color: UNKNOWN_COLOR, flags: 0 };
    } else if (Array.isArray(entry)) {
        info = { name: short, color: entry[0], flags: entry[1] };
    } else {
        info = { name: short, color: entry, flags: 0 };
    }

    blockCache.set(name, info);

    return info;
}

function multiply(color, tint) {
    const r = (((color >> 16) & 255) * ((tint >> 16) & 255)) >> 8;
    const g = (((color >> 8) & 255) * ((tint >> 8) & 255)) >> 8;
    const b = ((color & 255) * (tint & 255)) >> 8;

    return (r << 16) | (g << 8) | b;
}

function blend(color, other, ratio) {
    const inverse = 1 - ratio;
    const r = ((color >> 16) & 255) * ratio + ((other >> 16) & 255) * inverse;
    const g = ((color >> 8) & 255) * ratio + ((other >> 8) & 255) * inverse;
    const b = (color & 255) * ratio + (other & 255) * inverse;

    return (r << 16) | (g << 8) | b;
}

/** Color of a block in a biome, grass, leaves and water take the color of their biome. */
function blockColor(info, biome) {
    const flags = info.flags;

    if (flags & STATIC_COLOR) {
        return STATIC_TINTS[info.name] ?? info.color;
    }

    if (flags & STATIC_TINT) {
        return multiply(info.color, STATIC_TINTS[info.name] ?? 0xffffff);
    }

    if (!(flags & (GRASS_TINT | FOLIAGE_TINT | WATER | DRY_FOLIAGE_TINT))) {
        return info.color;
    }

    const name = biome && biome.startsWith('minecraft:') ? biome.slice(10) : biome;
    const tints = (name && BIOME_TINTS[name]) || DEFAULT_TINTS;

    if (flags & GRASS_TINT) {
        return multiply(info.color, tints[0]);
    }

    if (flags & FOLIAGE_TINT) {
        return multiply(info.color, tints[1]);
    }

    if (flags & WATER) {
        return multiply(info.color, tints[2]);
    }

    return multiply(info.color, tints[3] ?? tints[1]);
}

// ---------------------------------------------------------------------------------------------
// NBT

const textDecoder = new TextDecoder();

/**
 * Reads uncompressed NBT. Numbers become numbers (longs too, precise enough for what the map needs),
 * arrays stay views into the data: { view, offset, length } for int and long arrays.
 */
class NbtReader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = 0;
    }

    root() {
        const type = this.view.getUint8(this.pos++);

        if (type !== 10) {
            throw new Error('Chunk data is not a compound');
        }

        this.pos += 2 + this.view.getUint16(this.pos); // its name

        return this.payload(10, true);
    }

    string() {
        const length = this.view.getUint16(this.pos);
        const start = this.pos + 2;
        this.pos = start + length;

        return textDecoder.decode(this.bytes.subarray(start, start + length));
    }

    long() {
        const high = this.view.getInt32(this.pos);
        const low = this.view.getUint32(this.pos + 4);
        this.pos += 8;

        return high * 4294967296 + low;
    }

    payload(type, topLevel = false) {
        const view = this.view;

        switch (type) {
            case 1: return view.getInt8(this.pos++);
            case 2: { const value = view.getInt16(this.pos); this.pos += 2; return value; }
            case 3: { const value = view.getInt32(this.pos); this.pos += 4; return value; }
            case 4: return this.long();
            case 5: { const value = view.getFloat32(this.pos); this.pos += 4; return value; }
            case 6: { const value = view.getFloat64(this.pos); this.pos += 8; return value; }
            case 7: {
                const length = view.getInt32(this.pos);
                const start = this.pos + 4;
                this.pos = start + length;

                return this.bytes.subarray(start, start + length);
            }
            case 8: return this.string();
            case 9: {
                const itemType = view.getUint8(this.pos);
                const length = view.getInt32(this.pos + 1);
                this.pos += 5;
                const list = new Array(Math.max(length, 0));

                for (let i = 0; i < length; i++) {
                    list[i] = this.payload(itemType);
                }

                return list;
            }
            case 10: {
                const compound = {};

                for (;;) {
                    const itemType = view.getUint8(this.pos++);

                    if (itemType === 0) {
                        return compound;
                    }

                    const name = this.string();

                    if (topLevel && SKIPPED_KEYS.has(name)) {
                        this.skipPayload(itemType);
                    } else {
                        // The old format nests everything in "Level", which counts as top level too.
                        compound[name] = this.payload(itemType, topLevel && name === 'Level');
                    }
                }
            }
            case 11:
            case 12: {
                const length = view.getInt32(this.pos);
                const offset = this.pos + 4;
                this.pos = offset + length * (type === 11 ? 4 : 8);

                return { view, offset, length };
            }
            default:
                throw new Error('Unknown NBT tag ' + type);
        }
    }

    skipPayload(type) {
        const view = this.view;

        switch (type) {
            case 1: this.pos += 1; return;
            case 2: this.pos += 2; return;
            case 3: case 5: this.pos += 4; return;
            case 4: case 6: this.pos += 8; return;
            case 7: this.pos += 4 + view.getInt32(this.pos); return;
            case 8: this.pos += 2 + view.getUint16(this.pos); return;
            case 9: {
                const itemType = view.getUint8(this.pos);
                const length = view.getInt32(this.pos + 1);
                this.pos += 5;
                const fixed = [0, 1, 2, 4, 8, 4, 8][itemType];

                if (fixed !== undefined && itemType !== 0) {
                    this.pos += fixed * length;
                } else {
                    for (let i = 0; i < length; i++) {
                        this.skipPayload(itemType);
                    }
                }

                return;
            }
            case 10:
                for (;;) {
                    const itemType = view.getUint8(this.pos++);

                    if (itemType === 0) {
                        return;
                    }

                    this.pos += 2 + view.getUint16(this.pos);
                    this.skipPayload(itemType);
                }
            case 11: this.pos += 4 + view.getInt32(this.pos) * 4; return;
            case 12: this.pos += 4 + view.getInt32(this.pos) * 8; return;
            default:
                throw new Error('Unknown NBT tag ' + type);
        }
    }
}

/** `bits` bits starting at bit `shift` of long number `index` of a long array (shift + bits <= 64). */
function bitsOf(longs, index, shift, bits) {
    const base = longs.offset + index * 8;
    const high = longs.view.getUint32(base);
    const low = longs.view.getUint32(base + 4);
    const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;

    if (shift >= 32) {
        return (high >>> (shift - 32)) & mask;
    }

    if (shift + bits <= 32) {
        return (low >>> shift) & mask;
    }

    return ((low >>> shift) | (high << (32 - shift))) & mask;
}

/**
 * Unpack `count` values of `bits` bits. Since 1.16 a value never spans two longs, before it did.
 * Returns null if the array is too short for them.
 */
function unpack(longs, count, bits, spanning) {
    const values = new Uint16Array(count);

    if (spanning) {
        if (longs.length * 64 < count * bits) {
            return null;
        }

        for (let i = 0; i < count; i++) {
            const bit = i * bits;
            const index = bit >>> 6;
            const shift = bit & 63;

            if (shift + bits <= 64) {
                values[i] = bitsOf(longs, index, shift, bits);
            } else {
                const lowBits = 64 - shift;
                values[i] = bitsOf(longs, index, shift, lowBits) | (bitsOf(longs, index + 1, 0, bits - lowBits) << lowBits);
            }
        }

        return values;
    }

    const perLong = Math.floor(64 / bits);

    if (longs.length < Math.ceil(count / perLong)) {
        return null;
    }

    for (let i = 0; i < count; i++) {
        const index = Math.floor(i / perLong);
        values[i] = bitsOf(longs, index, (i - index * perLong) * bits, bits);
    }

    return values;
}

function bitsFor(paletteSize, minimum) {
    let bits = 0;

    while ((1 << bits) < paletteSize) {
        bits++;
    }

    return Math.max(bits, minimum);
}

// ---------------------------------------------------------------------------------------------
// Chunks

/**
 * A section (16 blocks high) of a chunk, its blocks unpacked on first use.
 */
class Section {
    constructor(y, palette, data, biomePalette, biomeData, spanning) {
        this.y = y;
        this.palette = palette; // block infos
        this.data = data; // long array or null
        this.biomePalette = biomePalette; // biome names or null
        this.biomeData = biomeData;
        this.spanning = spanning;
        this.blocks = undefined;
        this.biomes = undefined;
        this.empty = palette.length === 0 || palette.every((info) => info.flags & TRANSPARENT);
    }

    blockAt(x, y, z) {
        if (this.palette.length === 1) {
            return this.palette[0];
        }

        if (this.blocks === undefined) {
            this.blocks = this.data ? unpack(this.data, 4096, bitsFor(this.palette.length, 4), this.spanning) : null;
        }

        const info = this.blocks ? this.palette[this.blocks[(y << 8) | (z << 4) | x]] : undefined;

        return info ?? this.palette[0];
    }

    biomeAt(x, y, z) {
        const palette = this.biomePalette;

        if (!palette || palette.length === 0) {
            return null;
        }

        if (palette.length === 1) {
            return palette[0];
        }

        if (this.biomes === undefined) {
            this.biomes = this.biomeData ? unpack(this.biomeData, 64, bitsFor(palette.length, 1), false) : null;
        }

        return this.biomes ? palette[this.biomes[((y >> 2) << 4) | ((z >> 2) << 2) | (x >> 2)]] ?? palette[0] : palette[0];
    }
}

/** Legacy (before 1.13) section: one byte per block id. */
class LegacySection {
    constructor(y, blocks) {
        this.y = y;
        this.raw = blocks;
        this.empty = blocks.every((id) => id === 0);
    }

    blockAt(x, y, z) {
        const id = this.raw[(y << 8) | (z << 4) | x] ?? 0;

        return id === 0 ? blockInfo('minecraft:air') : blockInfo('minecraft:' + (LEGACY_BLOCKS[id] ?? 'unknown_legacy_' + id));
    }

    biomeAt() {
        return null;
    }
}

/**
 * Name of a palette entry. Up to 1.21 a block is { Name, Properties } and a biome a string. Since 26.1
 * lists may mix types: a block is { id, properties }, or just its name, which NBT stores as a
 * compound holding the name under an empty key.
 */
function entryName(entry) {
    if (typeof entry === 'string') {
        return entry;
    }

    return entry?.Name ?? entry?.id ?? entry?.[''] ?? null;
}

function paletteInfos(palette) {
    return (palette || []).map((entry) => blockInfo(entryName(entry) ?? 'minecraft:air'));
}

/** The sections of a chunk from the highest down, plus its values, in every format since 1.9. */
function readChunk(nbt) {
    const dataVersion = nbt.DataVersion ?? 0;
    const level = nbt.sections ? nbt : nbt.Level ?? nbt;
    const spanning = dataVersion < 2527; // 20w17a (1.16) stopped values from spanning two longs
    const sections = [];

    for (const raw of level.sections ?? level.Sections ?? []) {
        const y = raw.Y ?? 0;

        if (raw.block_states) {
            sections.push(new Section(y, paletteInfos(raw.block_states.palette), raw.block_states.data ?? null,
                raw.biomes?.palette?.map(entryName) ?? null, raw.biomes?.data ?? null, false));
        } else if (raw.Palette) {
            sections.push(new Section(y, paletteInfos(raw.Palette), raw.BlockStates ?? null, null, null, spanning));
        } else if (raw.Blocks instanceof Uint8Array && raw.Blocks.length >= 4096) {
            sections.push(new LegacySection(y, raw.Blocks));
        }
    }

    sections.sort((a, b) => b.y - a.y);

    const status = String(level.Status ?? '');

    return {
        dataVersion,
        sections,
        inhabited: typeof level.InhabitedTime === 'number' ? level.InhabitedTime : -1,
        lastUpdate: typeof level.LastUpdate === 'number' ? level.LastUpdate : -1,
        full: status.includes('full') || status === 'postprocessed' || level.TerrainPopulated === 1,
    };
}

/**
 * Color and height of the top of a column, null if it holds nothing but air. In the nether the
 * bedrock roof and the rock under it are looked through, down to the first open space.
 */
function columnTop(sections, x, z, nether) {
    let phase = nether ? 0 : 2; // 0: above the roof, 1: in the roof, 2: looking for the top
    let waterTop = null;
    let waterColor = 0;
    let depth = 0;

    for (const section of sections) {
        if (section.empty) {
            if (phase === 1) {
                phase = 2;
            }

            if (waterTop !== null) {
                break;
            }

            continue;
        }

        for (let y = 15; y >= 0; y--) {
            const info = section.blockAt(x, y, z);
            const air = (info.flags & TRANSPARENT) !== 0;

            if (phase === 0) {
                if (!air) {
                    phase = 1;
                }

                continue;
            }

            if (phase === 1) {
                if (air) {
                    phase = 2;
                }

                continue;
            }

            if (air) {
                continue;
            }

            const height = section.y * 16 + y;

            if (info.flags & WATER) {
                if (waterTop === null) {
                    waterTop = height;
                    waterColor = blockColor(info, section.biomeAt(x, y, z));
                }

                if (++depth > 24) {
                    return { color: waterColor, height: waterTop, water: true };
                }

                continue;
            }

            const color = blockColor(info, section.biomeAt(x, y, z));

            if (waterTop !== null) {
                // Deeper water lets less of the ground show through.
                return { color: blend(waterColor, color, Math.min(0.45 + depth * 0.03, 0.9)), height: waterTop, water: true };
            }

            return { color, height, water: false };
        }
    }

    if (waterTop !== null) {
        return { color: waterColor, height: waterTop, water: true };
    }

    // Nothing below the nether roof (or a nether without one), show the roof instead.
    return nether ? columnTop(sections, x, z, false) : null;
}

// ---------------------------------------------------------------------------------------------
// Decompression

async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));

    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** LZ4 as written by Minecraft since 24w04a: blocks of lz4-java's LZ4BlockOutputStream. */
function lz4Blocks(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts = [];
    let total = 0;
    let pos = 0;

    while (pos + 21 <= bytes.length) {
        const method = bytes[pos + 8] & 0xf0;
        const compressed = view.getInt32(pos + 9, true);
        const decompressed = view.getInt32(pos + 13, true);
        pos += 21;

        if (decompressed === 0) {
            break;
        }

        const input = bytes.subarray(pos, pos + compressed);
        pos += compressed;
        const output = method === 0x10 ? input.slice() : lz4Block(input, decompressed);
        parts.push(output);
        total += output.length;
    }

    const result = new Uint8Array(total);
    let offset = 0;

    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

function lz4Block(input, size) {
    const output = new Uint8Array(size);
    let i = 0;
    let o = 0;

    while (i < input.length) {
        const token = input[i++];
        let literals = token >> 4;

        if (literals === 15) {
            let extra;
            do { extra = input[i++]; literals += extra; } while (extra === 255);
        }

        output.set(input.subarray(i, i + literals), o);
        i += literals;
        o += literals;

        if (i >= input.length) {
            break;
        }

        const offset = input[i] | (input[i + 1] << 8);
        i += 2;
        let length = token & 15;

        if (length === 15) {
            let extra;
            do { extra = input[i++]; length += extra; } while (extra === 255);
        }

        length += 4;

        for (let from = o - offset; length > 0; length--) {
            output[o++] = output[from++];
        }
    }

    return output;
}

async function decompress(type, data) {
    switch (type) {
        case 1: return inflate(data, 'gzip');
        case 2: return inflate(data, 'deflate');
        case 3: return data;
        case 4: return lz4Blocks(data);
        default: throw new Error('Unknown compression ' + type);
    }
}

// ---------------------------------------------------------------------------------------------
// Regions

async function renderRegion(buffer, nether) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const pixels = new Uint32Array(SIZE * SIZE); // 0xRRGGBB | 1 << 24 for drawn pixels
    const heights = new Int16Array(SIZE * SIZE).fill(NO_HEIGHT);
    const water = new Uint8Array(SIZE * SIZE);

    const state = new Uint8Array(1024);
    const inhabited = new Float32Array(1024).fill(-1);
    const lastUpdate = new Float32Array(1024).fill(-1);
    const timestamps = new Uint32Array(1024);
    const full = new Uint8Array(1024);
    let dataVersion = 0;

    const markUnreadable = (index) => {
        state[index] = UNREADABLE;
        const baseX = (index & 31) * 16;
        const baseZ = (index >> 5) * 16;

        for (let z = 0; z < 16; z++) {
            pixels.fill(UNREADABLE_COLOR | (1 << 24), (baseZ + z) * SIZE + baseX, (baseZ + z) * SIZE + baseX + 16);
        }
    };

    const jobs = [];

    for (let index = 0; index < 1024 && bytes.length >= 2 * SECTOR; index++) {
        const location = view.getUint32(index * 4);
        const offset = (location >>> 8) * SECTOR;

        if ((location >>> 8) < 2 || (location & 255) === 0) {
            continue;
        }

        timestamps[index] = view.getUint32(SECTOR + index * 4);

        if (offset + 5 > bytes.length) {
            markUnreadable(index);
            continue;
        }

        const length = view.getUint32(offset);
        const type = bytes[offset + 4];

        if (type & 0x80 || length < 1 || offset + 4 + length > bytes.length) {
            // Stored in an external .mcc file, or cut off.
            markUnreadable(index);
            continue;
        }

        jobs.push(decompress(type, bytes.subarray(offset + 5, offset + 4 + length)).then((data) => {
            const chunk = readChunk(new NbtReader(data).root());
            dataVersion = Math.max(dataVersion, chunk.dataVersion);
            state[index] = RENDERED;
            inhabited[index] = chunk.inhabited;
            lastUpdate[index] = chunk.lastUpdate;
            full[index] = chunk.full ? 1 : 0;

            const baseX = (index & 31) * 16;
            const baseZ = (index >> 5) * 16;

            for (let z = 0; z < 16; z++) {
                for (let x = 0; x < 16; x++) {
                    const top = columnTop(chunk.sections, x, z, nether);

                    if (top) {
                        const pixel = (baseZ + z) * SIZE + baseX + x;
                        pixels[pixel] = top.color | (1 << 24);
                        heights[pixel] = top.height;
                        water[pixel] = top.water ? 1 : 0;
                    }
                }
            }
        }).catch(() => markUnreadable(index)));
    }

    await Promise.all(jobs);

    return { rgba: shade(pixels, heights, water), state, inhabited, lastUpdate, timestamps, full, dataVersion };
}

/** Light slopes facing north-west, darken the others, like a map in game. */
function shade(pixels, heights, water) {
    const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);

    for (let z = 0; z < SIZE; z++) {
        for (let x = 0; x < SIZE; x++) {
            const i = z * SIZE + x;
            const pixel = pixels[i];

            if (!(pixel >>> 24)) {
                continue;
            }

            let amount = 0;
            const height = heights[i];

            if (height !== NO_HEIGHT && !water[i]) {
                const north = z > 0 && heights[i - SIZE] !== NO_HEIGHT ? heights[i - SIZE] : height;
                const west = x > 0 && heights[i - 1] !== NO_HEIGHT ? heights[i - 1] : height;
                amount = Math.max(-8, Math.min(8, (height - north) + (height - west))) * 6;
            }

            const o = i * 4;
            rgba[o] = ((pixel >> 16) & 255) + amount;
            rgba[o + 1] = ((pixel >> 8) & 255) + amount;
            rgba[o + 2] = (pixel & 255) + amount;
            rgba[o + 3] = 255;
        }
    }

    return rgba;
}

/** A small copy of the picture for zoomed out views. */
function thumbnail(rgba) {
    const step = SIZE / THUMB;
    const thumb = new Uint8ClampedArray(THUMB * THUMB * 4);

    for (let ty = 0; ty < THUMB; ty++) {
        for (let tx = 0; tx < THUMB; tx++) {
            let r = 0, g = 0, b = 0, a = 0;

            for (let y = 0; y < step; y++) {
                for (let x = 0; x < step; x++) {
                    const o = ((ty * step + y) * SIZE + tx * step + x) * 4;
                    const alpha = rgba[o + 3];
                    r += rgba[o] * alpha;
                    g += rgba[o + 1] * alpha;
                    b += rgba[o + 2] * alpha;
                    a += alpha;
                }
            }

            const o = (ty * THUMB + tx) * 4;

            if (a > 0) {
                thumb[o] = r / a;
                thumb[o + 1] = g / a;
                thumb[o + 2] = b / a;
                thumb[o + 3] = a / (step * step);
            }
        }
    }

    return thumb;
}

self.onmessage = async (event) => {
    const { id, buffer, nether } = event.data;

    try {
        const result = await renderRegion(buffer, nether);
        const thumb = thumbnail(result.rgba);

        self.postMessage({ id, ...result, thumb }, [
            result.rgba.buffer, thumb.buffer, result.state.buffer, result.inhabited.buffer,
            result.lastUpdate.buffer, result.timestamps.buffer, result.full.buffer,
        ]);
    } catch (error) {
        self.postMessage({ id, error: String(error && error.message || error) });
    }
};
