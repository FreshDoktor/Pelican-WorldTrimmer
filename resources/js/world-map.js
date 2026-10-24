// The world map of the World Trimmer page. Runs inside @script of the page, so $wire is the page and
// WORKER_SOURCE the code of the region worker.
//
// Region files are downloaded by the browser straight from the daemon, one after the other, and handed
// to a few workers. What comes back is kept (a small picture and the values of each chunk), the file
// itself is dropped. Full size pictures are only kept for the regions looked at last.
//
// Nothing big lives in Alpine's reactive state, the map keeps it in plain objects.

const REGION_BLOCKS = 512;
const THUMB_SIZE = 64;
const MAX_FULL_PICTURES = 160;
const FULL_PICTURE_FROM = 160; // screen pixels per region from which the full picture is shown
const PARALLEL_DOWNLOADS = 3;
const MIN_SCALE = 1 / 64; // screen pixels per block
const MAX_SCALE = 16;
const TICKS_PER_MINUTE = 20 * 60;

// Chunk states, as sent by the worker.
const MISSING = 0;
const RENDERED = 1;

class WorldMap {
    constructor(canvas, options) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.options = options; // { dimension, nether, getLinks(names), onChange(), onHover(info) }
        this.regions = new Map(); // "x,z" -> region
        this.selection = new Map(); // "x,z" -> Uint8Array(1024)
        this.queue = [];
        this.active = 0;
        this.fullPictures = []; // regions holding a full size picture, least recently drawn first
        this.centerX = 0;
        this.centerZ = 0;
        this.scale = 0.25;
        this.mode = 'map';
        this.drag = null;
        this.hoverChunk = null;
        this.destroyed = false;
        this.dirty = true;
        this.nextJob = 1;
        this.jobs = new Map();

        const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
        this.workers = Array.from({ length: count }, () => {
            const worker = new Worker(workerUrl);
            worker.onmessage = (event) => this.onWorkerMessage(event.data);
            return worker;
        });
        URL.revokeObjectURL(workerUrl);
        this.nextWorker = 0;

        this.bindInput();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas.parentElement);
        this.resize();
        this.frame = requestAnimationFrame(() => this.loop());
    }

    destroy() {
        this.destroyed = true;
        cancelAnimationFrame(this.frame);
        this.resizeObserver.disconnect();
        this.workers.forEach((worker) => worker.terminate());
        this.regions.forEach((region) => this.dropPictures(region));
        this.regions.clear();
    }

    // ------------------------------------------------------------------ regions

    setRegions(list) {
        for (const file of list) {
            this.regions.set(file.x + ',' + file.z, {
                ...file,
                key: file.x + ',' + file.z,
                status: file.size === 0 ? 'loaded' : 'idle', // idle, queued, loading, loaded, failed
                picture: null,
                thumb: null,
                stats: file.size === 0 ? emptyStats() : null,
                overlays: {},
            });
        }

        this.fitAll();
        this.changed();
    }

    removeRegion(region) {
        this.dropPictures(region);
        this.regions.delete(region.key);
        this.selection.delete(region.key);
        this.changed();
    }

    /** Download a region again, after its chunks changed. */
    reload(region) {
        this.dropPictures(region);
        region.stats = null;
        region.overlays = {};
        region.status = 'idle';
        this.changed();
    }

    dropPictures(region) {
        region.picture?.close?.();
        region.thumb?.close?.();
        region.picture = null;
        region.thumb = null;
        this.fullPictures = this.fullPictures.filter((other) => other !== region);
    }

    get loadedCount() {
        let count = 0;
        this.regions.forEach((region) => { count += region.stats ? 1 : 0; });
        return count;
    }

    get pendingCount() {
        return this.queue.length + this.active;
    }

    /** Queue every region, for filters that need the values of the whole world. */
    loadAll() {
        const regions = [...this.regions.values()].filter((region) => !region.stats && region.status !== 'queued' && region.status !== 'loading');
        regions.sort((a, b) => this.distance(a) - this.distance(b));
        regions.forEach((region) => { region.status = 'queued'; this.queue.push(region); });
        this.pump();
    }

    distance(region) {
        const x = region.x * REGION_BLOCKS + REGION_BLOCKS / 2 - this.centerX;
        const z = region.z * REGION_BLOCKS + REGION_BLOCKS / 2 - this.centerZ;
        return x * x + z * z;
    }

    /** Queue the visible regions that still miss what the current zoom needs, nearest first. */
    requestVisible() {
        const needsFull = REGION_BLOCKS * this.scale > FULL_PICTURE_FROM;
        const wanted = [];

        this.forVisibleRegions((region) => {
            if (region.status === 'queued' || region.status === 'loading' || region.status === 'failed') {
                return;
            }

            if (!region.stats || (needsFull && !region.picture)) {
                wanted.push(region);
            }
        });

        wanted.sort((a, b) => this.distance(a) - this.distance(b));

        // Visible regions go first, ahead of those queued by loadAll().
        for (const region of wanted.reverse()) {
            region.status = 'queued';
            this.queue.unshift(region);
        }

        if (wanted.length) {
            this.pump();
        }
    }

    async pump() {
        while (this.active < PARALLEL_DOWNLOADS && this.queue.length && !this.destroyed) {
            const batch = this.queue.splice(0, this.options.batchSize);
            this.active += batch.length;
            batch.forEach((region) => { region.status = 'loading'; });

            this.loadBatch(batch).finally(() => {
                this.active -= batch.length;
                this.changed();
                this.pump();
            });
        }
    }

    async loadBatch(batch) {
        let links;

        try {
            links = await this.options.getLinks(batch.map((region) => region.name));
        } catch (error) {
            batch.forEach((region) => { region.status = 'failed'; });
            return;
        }

        // One download after the other within a batch, so only a few region files are in memory at once.
        for (const region of batch) {
            if (this.destroyed) {
                return;
            }

            try {
                const response = await fetch(links[region.name]);

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }

                const buffer = await response.arrayBuffer();
                const result = await this.render(buffer);
                await this.store(region, result);
            } catch (error) {
                console.warn('[world-trimmer] ' + region.name, error);
                region.status = 'failed';
            }
        }
    }

    render(buffer) {
        return new Promise((resolve, reject) => {
            const id = this.nextJob++;
            this.jobs.set(id, { resolve, reject });
            const worker = this.workers[this.nextWorker++ % this.workers.length];
            worker.postMessage({ id, buffer, nether: this.options.nether }, [buffer]);
        });
    }

    onWorkerMessage(message) {
        const job = this.jobs.get(message.id);
        this.jobs.delete(message.id);

        if (message.error) {
            job?.reject(new Error(message.error));
        } else {
            job?.resolve(message);
        }
    }

    async store(region, result) {
        if (this.destroyed || this.regions.get(region.key) !== region) {
            return;
        }

        this.dropPictures(region);
        region.thumb = await createImageBitmap(new ImageData(result.thumb, THUMB_SIZE, THUMB_SIZE));
        region.picture = await createImageBitmap(new ImageData(result.rgba, REGION_BLOCKS, REGION_BLOCKS));
        region.stats = {
            state: result.state,
            inhabited: result.inhabited,
            lastUpdate: result.lastUpdate,
            timestamps: result.timestamps,
            full: result.full,
            dataVersion: result.dataVersion,
        };
        region.overlays = {};
        region.status = 'loaded';

        this.fullPictures.push(region);

        // Keep only the full pictures of the regions looked at last, the thumbnails stay.
        while (this.fullPictures.length > MAX_FULL_PICTURES) {
            const oldest = this.fullPictures.shift();
            oldest.picture?.close?.();
            oldest.picture = null;
        }

        this.changed();
    }

    // ------------------------------------------------------------------ selection

    selectionOf(regionKey, create) {
        let selected = this.selection.get(regionKey);

        if (!selected && create) {
            selected = new Uint8Array(1024);
            this.selection.set(regionKey, selected);
        }

        return selected;
    }

    setChunk(chunkX, chunkZ, value) {
        const regionKey = (chunkX >> 5) + ',' + (chunkZ >> 5);

        if (!this.regions.has(regionKey)) {
            return;
        }

        const selected = this.selectionOf(regionKey, value);

        if (selected) {
            selected[(chunkX & 31) | ((chunkZ & 31) << 5)] = value ? 1 : 0;
            this.regions.get(regionKey).overlays.selection = null;
        }
    }

    isSelected(chunkX, chunkZ) {
        const selected = this.selection.get((chunkX >> 5) + ',' + (chunkZ >> 5));
        return !!selected && selected[(chunkX & 31) | ((chunkZ & 31) << 5)] === 1;
    }

    selectArea(fromX, fromZ, toX, toZ, value) {
        const [minX, maxX] = [Math.min(fromX, toX), Math.max(fromX, toX)];
        const [minZ, maxZ] = [Math.min(fromZ, toZ), Math.max(fromZ, toZ)];

        for (let z = minZ; z <= maxZ; z++) {
            for (let x = minX; x <= maxX; x++) {
                this.setChunk(x, z, value);
            }
        }

        this.selectionChanged();
    }

    toggleRegion(regionX, regionZ) {
        const region = this.regions.get(regionX + ',' + regionZ);

        if (!region) {
            return;
        }

        const selected = this.selectionOf(region.key, true);
        const value = selected.some((bit) => bit === 0) ? 1 : 0;
        selected.fill(value);
        region.overlays.selection = null;
        this.selectionChanged();
    }

    clearSelection() {
        this.selection.clear();
        this.regions.forEach((region) => { region.overlays.selection = null; });
        this.selectionChanged();
    }

    /** Select what isn't, and the other way round. Regions not loaded yet are taken as a whole. */
    invertSelection() {
        this.regions.forEach((region) => {
            const selected = this.selectionOf(region.key, true);

            for (let i = 0; i < 1024; i++) {
                selected[i] = selected[i] ? 0 : 1;
            }

            region.overlays.selection = null;
        });

        this.selectionChanged();
    }

    /**
     * Select the generated chunks of the loaded regions that were played in for less than the given
     * minutes, leaving out a circle around a point (e.g. the spawn).
     */
    selectByInhabitedTime(minutes, keepX, keepZ, keepRadius) {
        const limit = minutes * TICKS_PER_MINUTE;
        let count = 0;

        this.regions.forEach((region) => {
            if (!region.stats) {
                return;
            }

            for (let i = 0; i < 1024; i++) {
                if (region.stats.state[i] !== RENDERED || region.stats.inhabited[i] < 0 || region.stats.inhabited[i] >= limit) {
                    continue;
                }

                const chunkX = region.x * 32 + (i & 31);
                const chunkZ = region.z * 32 + (i >> 5);

                if (keepRadius > 0 && chunkDistance(chunkX, chunkZ, keepX, keepZ) <= keepRadius) {
                    continue;
                }

                this.selectionOf(region.key, true)[i] = 1;
                count++;
            }

            region.overlays.selection = null;
        });

        this.selectionChanged();

        return count;
    }

    /** Selected chunks by region; chunks known to be missing aren't counted. */
    selectionSummary() {
        let chunks = 0;
        const regions = [];

        this.selection.forEach((selected, key) => {
            const region = this.regions.get(key);

            if (!region) {
                return;
            }

            let count = 0;

            for (let i = 0; i < 1024; i++) {
                if (selected[i] && (!region.stats || region.stats.state[i] !== MISSING)) {
                    count++;
                }
            }

            // Only a region selected as a whole is removed as a whole, chunks generated since it was
            // loaded stay otherwise. The panel deletes the file anyway once no chunk is left in it.
            const all = selected.every((bit) => bit === 1);

            if (count > 0) {
                chunks += count;
                regions.push({ region, all, indices: all ? null : [...selected.keys()].filter((i) => selected[i]) });
            }
        });

        return { chunks, regions };
    }

    selectionChanged() {
        this.changed();
        this.options.onSelection?.();
    }

    // ------------------------------------------------------------------ view

    resize() {
        const parent = this.canvas.parentElement;
        const ratio = window.devicePixelRatio || 1;
        this.width = parent.clientWidth;
        this.height = parent.clientHeight;
        this.canvas.width = Math.round(this.width * ratio);
        this.canvas.height = Math.round(this.height * ratio);
        this.canvas.style.width = this.width + 'px';
        this.canvas.style.height = this.height + 'px';
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.changed();
    }

    fitAll() {
        if (!this.regions.size) {
            return;
        }

        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

        this.regions.forEach((region) => {
            minX = Math.min(minX, region.x);
            minZ = Math.min(minZ, region.z);
            maxX = Math.max(maxX, region.x + 1);
            maxZ = Math.max(maxZ, region.z + 1);
        });

        this.centerX = (minX + maxX) / 2 * REGION_BLOCKS;
        this.centerZ = (minZ + maxZ) / 2 * REGION_BLOCKS;
        const fit = Math.min(this.width / ((maxX - minX) * REGION_BLOCKS), this.height / ((maxZ - minZ) * REGION_BLOCKS)) * 0.9;
        this.scale = clamp(fit || 0.25, MIN_SCALE, 1);
        this.changed();
    }

    zoomAt(factor, screenX, screenZ) {
        const [blockX, blockZ] = this.toBlock(screenX, screenZ);
        this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
        this.centerX = blockX - (screenX - this.width / 2) / this.scale;
        this.centerZ = blockZ - (screenZ - this.height / 2) / this.scale;
        this.changed();
    }

    toBlock(screenX, screenZ) {
        return [
            (screenX - this.width / 2) / this.scale + this.centerX,
            (screenZ - this.height / 2) / this.scale + this.centerZ,
        ];
    }

    toScreen(blockX, blockZ) {
        return [
            (blockX - this.centerX) * this.scale + this.width / 2,
            (blockZ - this.centerZ) * this.scale + this.height / 2,
        ];
    }

    forVisibleRegions(callback) {
        const [left, top] = this.toBlock(0, 0);
        const [right, bottom] = this.toBlock(this.width, this.height);
        const minX = Math.floor(left / REGION_BLOCKS), maxX = Math.floor(right / REGION_BLOCKS);
        const minZ = Math.floor(top / REGION_BLOCKS), maxZ = Math.floor(bottom / REGION_BLOCKS);

        if ((maxX - minX + 1) * (maxZ - minZ + 1) > this.regions.size) {
            this.regions.forEach((region) => {
                if (region.x >= minX && region.x <= maxX && region.z >= minZ && region.z <= maxZ) {
                    callback(region);
                }
            });
            return;
        }

        for (let z = minZ; z <= maxZ; z++) {
            for (let x = minX; x <= maxX; x++) {
                const region = this.regions.get(x + ',' + z);

                if (region) {
                    callback(region);
                }
            }
        }
    }

    changed() {
        this.dirty = true;
    }

    loop() {
        if (this.destroyed) {
            return;
        }

        if (this.dirty) {
            this.dirty = false;
            this.draw();
            this.requestVisible();
            this.options.onChange?.();
        }

        this.frame = requestAnimationFrame(() => this.loop());
    }

    draw() {
        const context = this.context;
        const style = getComputedStyle(this.canvas);
        const size = REGION_BLOCKS * this.scale;

        context.clearRect(0, 0, this.width, this.height);
        context.fillStyle = style.getPropertyValue('--wt-background') || '#18181b';
        context.fillRect(0, 0, this.width, this.height);
        context.imageSmoothingEnabled = this.scale < 1;

        this.forVisibleRegions((region) => {
            const [x, z] = this.toScreen(region.x * REGION_BLOCKS, region.z * REGION_BLOCKS);

            if (region.picture && size > THUMB_SIZE) {
                context.drawImage(region.picture, x, z, size, size);

                // Most recently drawn last, so it is evicted last.
                const index = this.fullPictures.indexOf(region);
                if (index >= 0 && index < this.fullPictures.length - 1) {
                    this.fullPictures.splice(index, 1);
                    this.fullPictures.push(region);
                }
            } else if (region.thumb) {
                context.drawImage(region.thumb, x, z, size, size);
            } else {
                context.fillStyle = region.status === 'failed' ? 'rgba(220, 38, 38, 0.35)' : 'rgba(127, 127, 127, 0.25)';
                context.fillRect(x, z, size, size);
            }

            if (this.mode !== 'map' && region.stats) {
                this.drawOverlay(region, this.mode, x, z, size);
            }

            if (this.selection.has(region.key)) {
                this.drawOverlay(region, 'selection', x, z, size);
            }
        });

        this.drawGrid();
        this.drawHover();
        this.drawDragArea();
    }

    /** A 32x32 picture with one pixel per chunk, stretched over the region. */
    drawOverlay(region, kind, x, z, size) {
        let overlay = region.overlays[kind];

        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.width = 32;
            overlay.height = 32;
            const overlayContext = overlay.getContext('2d');
            const image = overlayContext.createImageData(32, 32);
            const selected = this.selection.get(region.key);

            for (let i = 0; i < 1024; i++) {
                const color = kind === 'selection'
                    ? (selected && selected[i] ? [239, 68, 68, 150] : null)
                    : chunkColor(kind, region.stats, i);

                if (color) {
                    image.data.set(color, i * 4);
                }
            }

            overlayContext.putImageData(image, 0, 0);
            region.overlays[kind] = overlay;
        }

        const smoothing = this.context.imageSmoothingEnabled;
        this.context.imageSmoothingEnabled = false;
        this.context.drawImage(overlay, x, z, size, size);
        this.context.imageSmoothingEnabled = smoothing;
    }

    drawGrid() {
        const context = this.context;
        const chunkSize = 16 * this.scale;
        const regionSize = REGION_BLOCKS * this.scale;
        const [left, top] = this.toBlock(0, 0);

        const lines = (step, color) => {
            context.strokeStyle = color;
            context.lineWidth = 1;
            context.beginPath();

            for (let x = Math.floor(left / step) * step; x <= left + this.width / this.scale; x += step) {
                const screen = Math.round(this.toScreen(x, 0)[0]) + 0.5;
                context.moveTo(screen, 0);
                context.lineTo(screen, this.height);
            }

            for (let z = Math.floor(top / step) * step; z <= top + this.height / this.scale; z += step) {
                const screen = Math.round(this.toScreen(0, z)[1]) + 0.5;
                context.moveTo(0, screen);
                context.lineTo(this.width, screen);
            }

            context.stroke();
        };

        if (chunkSize >= 12) {
            lines(16, 'rgba(0, 0, 0, 0.18)');
        }

        if (regionSize >= 24) {
            lines(REGION_BLOCKS, 'rgba(0, 0, 0, 0.45)');
        }
    }

    drawHover() {
        if (!this.hoverChunk || this.drag) {
            return;
        }

        const [chunkX, chunkZ] = this.hoverChunk;
        const wholeRegion = this.selectsRegions();
        const step = wholeRegion ? REGION_BLOCKS : 16;
        const blockX = wholeRegion ? (chunkX >> 5) * REGION_BLOCKS : chunkX * 16;
        const blockZ = wholeRegion ? (chunkZ >> 5) * REGION_BLOCKS : chunkZ * 16;
        const [x, z] = this.toScreen(blockX, blockZ);

        this.context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        this.context.lineWidth = 2;
        this.context.strokeRect(x, z, step * this.scale, step * this.scale);
    }

    drawDragArea() {
        if (!this.drag || this.drag.kind !== 'area' || !this.drag.moved) {
            return;
        }

        const [fromX, fromZ] = this.drag.fromChunk;
        const [toX, toZ] = this.drag.toChunk;
        const [x1, z1] = this.toScreen(Math.min(fromX, toX) * 16, Math.min(fromZ, toZ) * 16);
        const [x2, z2] = this.toScreen((Math.max(fromX, toX) + 1) * 16, (Math.max(fromZ, toZ) + 1) * 16);

        this.context.fillStyle = this.drag.value ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.2)';
        this.context.fillRect(x1, z1, x2 - x1, z2 - z1);
        this.context.strokeStyle = this.drag.value ? 'rgb(239, 68, 68)' : 'rgb(255, 255, 255)';
        this.context.lineWidth = 1.5;
        this.context.strokeRect(x1, z1, x2 - x1, z2 - z1);
    }

    /** Zoomed out this far, a click selects a whole region instead of a chunk. */
    selectsRegions() {
        return 16 * this.scale < 4;
    }

    // ------------------------------------------------------------------ input

    chunkAt(event) {
        const rect = this.canvas.getBoundingClientRect();
        const [blockX, blockZ] = this.toBlock(event.clientX - rect.left, event.clientY - rect.top);
        return { blockX: Math.floor(blockX), blockZ: Math.floor(blockZ), chunk: [Math.floor(blockX / 16), Math.floor(blockZ / 16)] };
    }

    bindInput() {
        const canvas = this.canvas;

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            this.zoomAt(Math.pow(1.0015, -event.deltaY), event.clientX - rect.left, event.clientY - rect.top);
        }, { passive: false });

        canvas.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
                return;
            }

            canvas.setPointerCapture(event.pointerId);
            const { chunk } = this.chunkAt(event);
            const area = event.shiftKey || event.ctrlKey || event.metaKey || event.altKey;

            this.drag = {
                kind: area ? 'area' : 'pan',
                value: !(event.ctrlKey || event.metaKey || event.altKey),
                startX: event.clientX,
                startZ: event.clientY,
                centerX: this.centerX,
                centerZ: this.centerZ,
                fromChunk: chunk,
                toChunk: chunk,
                moved: false,
            };
        });

        canvas.addEventListener('pointermove', (event) => {
            const position = this.chunkAt(event);
            this.hoverChunk = position.chunk;
            this.options.onHover?.(this.describe(position));
            this.changed();

            if (!this.drag) {
                return;
            }

            const dx = event.clientX - this.drag.startX;
            const dz = event.clientY - this.drag.startZ;
            this.drag.moved ||= Math.abs(dx) + Math.abs(dz) > 4;

            if (this.drag.kind === 'pan' && this.drag.moved) {
                this.centerX = this.drag.centerX - dx / this.scale;
                this.centerZ = this.drag.centerZ - dz / this.scale;
            } else if (this.drag.kind === 'area') {
                this.drag.toChunk = position.chunk;
            }
        });

        canvas.addEventListener('pointerup', (event) => {
            const drag = this.drag;
            this.drag = null;

            if (!drag) {
                return;
            }

            if (drag.kind === 'area' && drag.moved) {
                this.selectArea(drag.fromChunk[0], drag.fromChunk[1], drag.toChunk[0], drag.toChunk[1], drag.value);
            } else if (!drag.moved) {
                const [chunkX, chunkZ] = drag.fromChunk;

                if (this.selectsRegions()) {
                    this.toggleRegion(chunkX >> 5, chunkZ >> 5);
                } else {
                    this.setChunk(chunkX, chunkZ, !this.isSelected(chunkX, chunkZ));
                    this.selectionChanged();
                }
            }

            this.changed();
        });

        canvas.addEventListener('pointerleave', () => {
            this.hoverChunk = null;
            this.options.onHover?.(null);
            this.changed();
        });
    }

    /** What lies under the pointer, for the info line below the map. */
    describe({ blockX, blockZ, chunk }) {
        const [chunkX, chunkZ] = chunk;
        const region = this.regions.get((chunkX >> 5) + ',' + (chunkZ >> 5));
        const index = (chunkX & 31) | ((chunkZ & 31) << 5);
        const stats = region?.stats;

        return {
            block: blockX + ', ' + blockZ,
            chunk: chunkX + ', ' + chunkZ,
            region: region ? region.name : null,
            state: !region ? 'none' : !stats ? 'loading' : ['missing', 'generated', 'unreadable'][stats.state[index]],
            full: stats ? stats.full[index] === 1 : null,
            inhabited: stats && stats.inhabited[index] >= 0 ? stats.inhabited[index] : null,
            saved: stats && stats.timestamps[index] ? stats.timestamps[index] * 1000 : null,
            selected: this.isSelected(chunkX, chunkZ),
        };
    }
}

function emptyStats() {
    return {
        state: new Uint8Array(1024),
        inhabited: new Float32Array(1024).fill(-1),
        lastUpdate: new Float32Array(1024).fill(-1),
        timestamps: new Uint32Array(1024),
        full: new Uint8Array(1024),
        dataVersion: 0,
    };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/** Distance in blocks from the center of a chunk to a point. */
function chunkDistance(chunkX, chunkZ, blockX, blockZ) {
    const x = chunkX * 16 + 8 - blockX;
    const z = chunkZ * 16 + 8 - blockZ;
    return Math.sqrt(x * x + z * z);
}

// Heat map colors from little (blue) to much (red).
const HEAT = [[59, 130, 246], [16, 185, 129], [234, 179, 8], [249, 115, 22], [220, 38, 38]];

function heat(fraction) {
    const position = clamp(fraction, 0, 1) * (HEAT.length - 1);
    const index = Math.min(Math.floor(position), HEAT.length - 2);
    const t = position - index;
    const [a, b] = [HEAT[index], HEAT[index + 1]];

    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 170];
}

/** Color of a chunk in the heat maps, null for none. */
function chunkColor(kind, stats, index) {
    if (stats.state[index] === MISSING) {
        return null;
    }

    if (kind === 'inhabited') {
        const ticks = stats.inhabited[index];

        if (ticks < 0) {
            return [127, 127, 127, 140];
        }

        // Logarithmic: under a minute is cold, ten hours and more is hot.
        return heat(Math.log10(1 + ticks / TICKS_PER_MINUTE) / Math.log10(1 + 600));
    }

    if (kind === 'saved') {
        const seconds = stats.timestamps[index];

        if (!seconds) {
            return [127, 127, 127, 140];
        }

        // Saved within the last day is hot, a year ago and longer is cold.
        const days = Math.max(0, (Date.now() / 1000 - seconds) / 86400);
        return heat(1 - Math.log10(1 + days) / Math.log10(1 + 365));
    }

    return null;
}

function formatDuration(ticks) {
    const minutes = ticks / TICKS_PER_MINUTE;

    if (minutes < 1) {
        return Math.round(ticks / 20) + ' s';
    }

    if (minutes < 120) {
        return Math.round(minutes) + ' min';
    }

    return (minutes / 60).toFixed(1) + ' h';
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function translate(text, values = {}) {
    return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(':' + key, value), text ?? '');
}

function notify(title, body, status) {
    if (window.FilamentNotification) {
        new window.FilamentNotification().title(title).body(body ?? '')[status]().send();
    }
}

Alpine.data('worldTrimmer', (config) => {
    let map = null;
    const S = config.strings;

    return {
        S,
        state: 'loading', // loading, ready, empty, error
        dimensions: [],
        dimension: null,
        offline: false,
        canTrim: false,
        mode: 'map',
        regionCount: 0,
        loadedCount: 0,
        pendingCount: 0,
        selectedChunks: 0,
        selectedRegions: 0,
        hover: null,
        filterMinutes: 5,
        keepX: 0,
        keepZ: 0,
        keepRadius: 0,
        confirming: false,
        backupConfirmed: false,
        trimming: false,
        trimDone: 0,
        trimTotal: 0,

        async init() {
            try {
                const world = await $wire.loadWorld();
                this.dimensions = world.dimensions;
                this.offline = world.offline;
                this.canTrim = world.canTrim;

                if (!this.dimensions.length) {
                    this.state = 'empty';
                    return;
                }

                await this.openDimension(this.dimensions[0].id);
            } catch (error) {
                console.error('[world-trimmer]', error);
                this.state = 'error';
            }
        },

        destroy() {
            map?.destroy();
            map = null;
        },

        dimensionLabel(dimension) {
            return S.dimensions[dimension.id] ?? dimension.label;
        },

        async openDimension(id) {
            map?.destroy();
            map = null;
            this.dimension = id;
            this.state = 'loading';
            this.hover = null;

            const regions = await $wire.listRegions(id);
            this.state = 'ready';
            await this.$nextTick();

            map = new WorldMap(this.$refs.canvas, {
                dimension: id,
                nether: id === 'minecraft:the_nether',
                batchSize: config.downloadBatchSize,
                getLinks: (names) => $wire.getDownloadLinks(id, names),
                onChange: () => this.sync(),
                onSelection: () => this.syncSelection(),
                onHover: (info) => { this.hover = info; },
            });
            map.mode = this.mode;
            map.setRegions(regions);
            this.regionCount = regions.length;
            this.syncSelection();
        },

        setMode(mode) {
            this.mode = mode;

            if (map) {
                map.mode = mode;
                map.changed();
            }
        },

        sync() {
            if (!map) {
                return;
            }

            this.loadedCount = map.loadedCount;
            this.pendingCount = map.pendingCount;
            this.regionCount = map.regions.size;
        },

        syncSelection() {
            if (!map) {
                return;
            }

            const summary = map.selectionSummary();
            this.selectedChunks = summary.chunks;
            this.selectedRegions = summary.regions.length;
        },

        loadAll() {
            map?.loadAll();
        },

        fit() {
            map?.fitAll();
        },

        clearSelection() {
            map?.clearSelection();
        },

        invertSelection() {
            map?.invertSelection();
        },

        applyFilter() {
            if (!map) {
                return;
            }

            const count = map.selectByInhabitedTime(Number(this.filterMinutes) || 0, Number(this.keepX) || 0, Number(this.keepZ) || 0, Number(this.keepRadius) || 0);
            notify(translate(S.filter_applied, { count }), this.loadedCount < this.regionCount ? S.filter_partial : null, 'info');
        },

        hoverText() {
            const hover = this.hover;

            if (!hover) {
                return S.help;
            }

            const parts = [S.hover.block + ' ' + hover.block, S.hover.chunk + ' ' + hover.chunk];

            if (hover.region) {
                parts.push(hover.region);
                parts.push(S.states[hover.state] ?? hover.state);

                if (hover.state === 'generated' && hover.full === false) {
                    parts.push(S.hover.partial);
                }

                if (hover.inhabited !== null) {
                    parts.push(S.hover.inhabited + ' ' + formatDuration(hover.inhabited));
                }

                if (hover.saved) {
                    parts.push(S.hover.saved + ' ' + new Date(hover.saved).toLocaleString());
                }
            }

            return parts.join(' · ');
        },

        async askTrim() {
            this.offline = await $wire.isOffline();
            this.backupConfirmed = false;
            this.confirming = true;
        },

        async trim() {
            if (!map || this.trimming) {
                return;
            }

            this.confirming = false;
            this.offline = await $wire.isOffline();

            if (!this.offline) {
                notify(S.server_running, null, 'danger');
                return;
            }

            const summary = map.selectionSummary();
            this.trimming = true;
            this.trimDone = 0;
            this.trimTotal = summary.regions.length;
            let removed = 0;
            let freed = 0;

            for (const { region, all, indices } of summary.regions) {
                const result = await $wire.trimRegion(this.dimension, region.name, all ? null : indices);

                if (!result.ok) {
                    notify(S.trim_failed, result.error, 'danger');
                    break;
                }

                removed += result.removed;
                freed += result.freed;
                map.selection.delete(region.key);

                if (result.deleted) {
                    map.removeRegion(region);
                } else {
                    map.reload(region);
                }

                this.trimDone++;
            }

            this.trimming = false;
            this.syncSelection();
            map.changed();

            if (removed > 0) {
                notify(translate(S.trim_done, { count: removed, size: formatBytes(freed) }), null, 'success');
            }
        },
    };
});
