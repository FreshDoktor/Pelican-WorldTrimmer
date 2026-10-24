<x-filament-panels::page>
    <div x-data="worldTrimmer(@js($this->getMapConfig()))" wire:ignore class="wt">
        <style>
            .wt { --wt-border: rgba(127, 127, 127, 0.25); --wt-muted: rgb(113, 113, 122); }
            .wt-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
            .wt-layout { display: flex; flex-direction: column; gap: 0.75rem; }
            .wt-body { display: grid; grid-template-columns: minmax(0, 1fr) 18rem; gap: 0.75rem; }
            @media (max-width: 1024px) { .wt-body { grid-template-columns: minmax(0, 1fr); } }
            .wt-map { position: relative; height: 70vh; min-height: 24rem; border-radius: 0.75rem; overflow: hidden; border: 1px solid var(--wt-border); }
            .wt-map canvas { display: block; touch-action: none; cursor: crosshair; --wt-background: #e4e4e7; }
            :is(.dark) .wt-map canvas { --wt-background: #18181b; }
            .wt-side { display: flex; flex-direction: column; gap: 0.75rem; }
            .wt-card { border: 1px solid var(--wt-border); border-radius: 0.75rem; padding: 0.875rem; display: flex; flex-direction: column; gap: 0.625rem; }
            .wt-card h3 { font-weight: 600; font-size: 0.875rem; }
            .wt-muted { color: var(--wt-muted); font-size: 0.8125rem; }
            .wt-status { font-size: 0.8125rem; color: var(--wt-muted); min-height: 1.25rem; font-variant-numeric: tabular-nums; }
            .wt-field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; }
            .wt-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; }
            .wt-segment { display: inline-flex; border: 1px solid var(--wt-border); border-radius: 0.5rem; overflow: hidden; }
            .wt-segment button { padding: 0.375rem 0.75rem; font-size: 0.8125rem; }
            .wt-segment button + button { border-left: 1px solid var(--wt-border); }
            .wt-segment button.wt-active { background: rgba(127, 127, 127, 0.2); font-weight: 600; }
            .wt-legend { height: 0.5rem; border-radius: 9999px; background: linear-gradient(to right, rgb(59, 130, 246), rgb(16, 185, 129), rgb(234, 179, 8), rgb(249, 115, 22), rgb(220, 38, 38)); }
            .wt-warning { border-color: rgba(234, 179, 8, 0.6); background: rgba(234, 179, 8, 0.08); }
            .wt-overlay { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.5); padding: 1rem; }
            .wt-dialog { max-width: 32rem; width: 100%; border-radius: 0.75rem; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.875rem; background: #fff; }
            :is(.dark) .wt-dialog { background: rgb(24, 24, 27); }
            .wt-dialog h2 { font-weight: 600; font-size: 1.125rem; }
            .wt-progress { height: 0.5rem; border-radius: 9999px; background: rgba(127, 127, 127, 0.25); overflow: hidden; }
            .wt-progress div { height: 100%; background: rgb(239, 68, 68); transition: width 0.2s; }
        </style>

        <div x-show="state === 'loading'" class="wt-row wt-muted">
            <x-filament::loading-indicator class="h-5 w-5" />
            <span x-text="S.loading"></span>
        </div>

        <div x-show="state === 'empty'" x-cloak class="wt-card wt-muted" x-text="S.no_world"></div>

        <div x-show="state === 'error'" x-cloak class="wt-card wt-warning" x-text="S.load_failed"></div>

        <div x-show="state === 'ready'" x-cloak class="wt-layout">
            <div class="wt-row">
                <x-filament::input.wrapper>
                    <x-filament::input.select x-on:change="openDimension($event.target.value)">
                        <template x-for="item in dimensions" :key="item.id">
                            <option :value="item.id" :selected="item.id === dimension" x-text="dimensionLabel(item)"></option>
                        </template>
                    </x-filament::input.select>
                </x-filament::input.wrapper>

                <div class="wt-segment">
                    <button type="button" :class="{ 'wt-active': mode === 'map' }" x-on:click="setMode('map')" x-text="S.modes.map"></button>
                    <button type="button" :class="{ 'wt-active': mode === 'inhabited' }" x-on:click="setMode('inhabited')" x-text="S.modes.inhabited"></button>
                    <button type="button" :class="{ 'wt-active': mode === 'saved' }" x-on:click="setMode('saved')" x-text="S.modes.saved"></button>
                </div>

                <x-filament::button color="gray" icon="tabler-zoom-reset" x-on:click="fit()">
                    <span x-text="S.fit"></span>
                </x-filament::button>

                <x-filament::button color="gray" icon="tabler-download" x-on:click="loadAll()" x-bind:disabled="loadedCount >= regionCount">
                    <span x-text="S.load_all"></span>
                </x-filament::button>

                <span class="wt-muted" x-text="S.regions_loaded.replace(':loaded', loadedCount).replace(':total', regionCount)"></span>
                <x-filament::loading-indicator x-show="pendingCount > 0" class="h-4 w-4" />
            </div>

            <div class="wt-body">
                <div class="wt-map">
                    <canvas x-ref="canvas"></canvas>
                </div>

                <aside class="wt-side">
                    <div class="wt-card wt-warning" x-show="!offline">
                        <span class="wt-muted" x-text="S.server_running_hint"></span>
                    </div>

                    <div class="wt-card">
                        <h3 x-text="S.selection_title"></h3>
                        <span class="wt-muted" x-text="S.selection.replace(':chunks', selectedChunks).replace(':regions', selectedRegions)"></span>
                        <div class="wt-row">
                            <x-filament::button size="sm" color="gray" x-on:click="clearSelection()" x-bind:disabled="selectedChunks === 0">
                                <span x-text="S.clear_selection"></span>
                            </x-filament::button>
                            <x-filament::button size="sm" color="gray" x-on:click="invertSelection()">
                                <span x-text="S.invert_selection"></span>
                            </x-filament::button>
                        </div>
                        <x-filament::button color="danger" icon="tabler-trash" x-show="canTrim" x-on:click="askTrim()" x-bind:disabled="selectedChunks === 0 || trimming">
                            <span x-text="S.delete_selection"></span>
                        </x-filament::button>
                        <span class="wt-muted" x-show="!canTrim" x-text="S.no_permission"></span>
                    </div>

                    <div class="wt-card">
                        <h3 x-text="S.filter_title"></h3>
                        <label class="wt-field">
                            <span x-text="S.filter_minutes"></span>
                            <x-filament::input.wrapper>
                                <x-filament::input type="number" min="0" step="1" x-model="filterMinutes" />
                            </x-filament::input.wrapper>
                        </label>
                        <span class="wt-muted" x-text="S.filter_keep"></span>
                        <div class="wt-fields">
                            <label class="wt-field">
                                <span>X</span>
                                <x-filament::input.wrapper>
                                    <x-filament::input type="number" step="1" x-model="keepX" />
                                </x-filament::input.wrapper>
                            </label>
                            <label class="wt-field">
                                <span>Z</span>
                                <x-filament::input.wrapper>
                                    <x-filament::input type="number" step="1" x-model="keepZ" />
                                </x-filament::input.wrapper>
                            </label>
                            <label class="wt-field">
                                <span x-text="S.filter_radius"></span>
                                <x-filament::input.wrapper>
                                    <x-filament::input type="number" min="0" step="16" x-model="keepRadius" />
                                </x-filament::input.wrapper>
                            </label>
                        </div>
                        <x-filament::button size="sm" x-on:click="applyFilter()">
                            <span x-text="S.filter_apply"></span>
                        </x-filament::button>
                        <span class="wt-muted" x-show="loadedCount < regionCount" x-text="S.filter_partial"></span>
                    </div>

                    <div class="wt-card" x-show="mode !== 'map'">
                        <h3 x-text="S.modes[mode]"></h3>
                        <div class="wt-legend"></div>
                        <div class="wt-row wt-muted" style="justify-content: space-between">
                            <span x-text="S.legend[mode]?.[0]"></span>
                            <span x-text="S.legend[mode]?.[1]"></span>
                        </div>
                    </div>
                </aside>
            </div>

            <div class="wt-status" x-text="hoverText()"></div>
        </div>

        <div class="wt-overlay" x-show="confirming" x-cloak x-on:keydown.escape.window="confirming = false">
            <div class="wt-dialog" x-on:click.outside="confirming = false">
                <h2 x-text="S.confirm_title"></h2>
                <p class="wt-muted" x-text="S.confirm_body.replace(':chunks', selectedChunks).replace(':regions', selectedRegions)"></p>
                <div class="wt-card wt-warning" x-show="!offline">
                    <span x-text="S.server_running"></span>
                </div>
                <label class="wt-row">
                    <input type="checkbox" x-model="backupConfirmed" />
                    <span x-text="S.confirm_backup"></span>
                </label>
                <div class="wt-row" style="justify-content: flex-end">
                    <x-filament::button color="gray" x-on:click="confirming = false">
                        <span x-text="S.cancel"></span>
                    </x-filament::button>
                    <x-filament::button color="danger" x-on:click="trim()" x-bind:disabled="!backupConfirmed || !offline">
                        <span x-text="S.confirm_button"></span>
                    </x-filament::button>
                </div>
            </div>
        </div>

        <div class="wt-overlay" x-show="trimming" x-cloak>
            <div class="wt-dialog">
                <h2 x-text="S.trimming_title"></h2>
                <div class="wt-progress"><div :style="{ width: (trimTotal ? trimDone / trimTotal * 100 : 0) + '%' }"></div></div>
                <span class="wt-muted" x-text="S.trimming.replace(':done', trimDone).replace(':total', trimTotal)"></span>
            </div>
        </div>
    </div>

    @script
    <script>
        const WORKER_SOURCE = @js($this->getWorkerSource());

        {!! $this->getMapSource() !!}
    </script>
    @endscript
</x-filament-panels::page>
