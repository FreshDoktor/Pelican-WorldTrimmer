<?php

namespace FreshDoktor\MinecraftWorldTrimmer\Filament\Server\Pages;

use App\Enums\SubuserPermission;
use App\Facades\Activity;
use App\Models\Server;
use App\Traits\Filament\BlockAccessInConflict;
use Exception;
use Filament\Facades\Filament;
use Filament\Pages\Page;
use FreshDoktor\MinecraftWorldTrimmer\Exceptions\WorldTrimmerException;
use FreshDoktor\MinecraftWorldTrimmer\Services\WorldService;
use Livewire\Attributes\Locked;
use Livewire\Attributes\Renderless;

/**
 * The map of a world. The browser draws it from the region files it downloads straight from the
 * daemon (see resources/js), this page only hands out the download links and removes chunks.
 *
 * Every method the map calls is renderless: the map lives in the browser, the page has nothing to
 * render again.
 */
class WorldTrimmer extends Page
{
    use BlockAccessInConflict {
        canAccess as canAccessWhenNotInConflict;
    }

    public const PLUGIN_ID = 'minecraft-world-trimmer';

    protected static string|\BackedEnum|null $navigationIcon = 'tabler-map-2';

    protected static ?string $slug = 'world-trimmer';

    protected static ?int $navigationSort = 31;

    protected string $view = 'minecraft-world-trimmer::pages.world-trimmer';

    /** @var array<string, string> folder of each dimension by id, looked up once and never taken from the browser */
    #[Locked]
    public array $dimensionPaths = [];

    public static function canAccess(): bool
    {
        $server = Filament::getTenant();

        return static::canAccessWhenNotInConflict()
            && $server instanceof Server
            && WorldService::isEnabledForServer($server)
            && user()?->can(SubuserPermission::FileReadContent, $server);
    }

    public static function getNavigationLabel(): string
    {
        return trans(self::PLUGIN_ID.'::strings.navigation_label');
    }

    public function getTitle(): string
    {
        return trans(self::PLUGIN_ID.'::strings.title');
    }

    protected function getServer(): Server
    {
        $server = Filament::getTenant();

        abort_unless($server instanceof Server, 404);

        return $server;
    }

    protected function service(): WorldService
    {
        return app(WorldService::class);
    }

    public function canTrim(): bool
    {
        $server = $this->getServer();

        return user()?->can(SubuserPermission::FileUpdate, $server) && user()?->can(SubuserPermission::FileDelete, $server);
    }

    /**
     * Dimensions of the world, whether the server is stopped and whether the user may remove chunks.
     *
     * @return array{dimensions: array<int, array{id: string, label: string}>, offline: bool, canTrim: bool}
     */
    #[Renderless]
    public function loadWorld(): array
    {
        $server = $this->getServer();
        $dimensions = $this->service()->getDimensions($server);

        $this->dimensionPaths = array_map(fn (array $dimension) => $dimension['path'], $dimensions);

        return [
            'dimensions' => array_values(array_map(fn (array $dimension) => ['id' => $dimension['id'], 'label' => $dimension['label']], $dimensions)),
            'offline' => $this->service()->isOffline($server),
            'canTrim' => $this->canTrim(),
        ];
    }

    #[Renderless]
    public function isOffline(): bool
    {
        return $this->service()->isOffline($this->getServer());
    }

    /**
     * @return array<int, array{name: string, x: int, z: int, size: int, modified: string}>
     */
    #[Renderless]
    public function listRegions(string $dimension): array
    {
        return $this->service()->getRegions($this->getServer(), $this->getDimensionPath($dimension));
    }

    /**
     * @param  array<string>  $names
     * @return array<string, string>
     */
    #[Renderless]
    public function getDownloadLinks(string $dimension, array $names): array
    {
        $server = $this->getServer();

        abort_unless(user()?->can(SubuserPermission::FileReadContent, $server), 403);

        $names = array_slice($names, 0, (int) config(self::PLUGIN_ID.'.download_batch_size', 16));

        return $this->service()->getDownloadLinks($server, user(), $this->getDimensionPath($dimension), $names);
    }

    /**
     * Remove chunks of one region, called by the map once per region of the selection.
     *
     * @param  array<int>|null  $chunks  chunk indices (x + z * 32), null for the whole region
     * @return array{ok: bool, removed?: int, deleted?: bool, freed?: int, error?: string}
     */
    #[Renderless]
    public function trimRegion(string $dimension, string $name, ?array $chunks): array
    {
        $server = $this->getServer();

        abort_unless($this->canTrim(), 403);

        try {
            $result = $this->service()->trimRegion($server, $this->getDimensionPath($dimension), $name, $chunks);
        } catch (WorldTrimmerException $exception) {
            return ['ok' => false, 'error' => $exception->getMessage()];
        } catch (Exception $exception) {
            report($exception);

            return ['ok' => false, 'error' => trans(self::PLUGIN_ID.'::strings.errors.unexpected')];
        }

        if ($result['removed'] > 0) {
            Activity::event($result['deleted'] ? 'server:world-trimmer.delete' : 'server:world-trimmer.trim')
                ->subject($server)
                ->property([
                    'file' => $this->getDimensionPath($dimension)."/region/$name",
                    'count' => $result['removed'],
                ])
                ->log();
        }

        return ['ok' => true, ...$result];
    }

    protected function getDimensionPath(string $dimension): string
    {
        $path = $this->dimensionPaths[$dimension] ?? null;

        abort_if($path === null, 404);

        return $path;
    }

    /**
     * Texts and settings of the map, handed to its script.
     *
     * @return array<string, mixed>
     */
    public function getMapConfig(): array
    {
        return [
            'serverUuid' => $this->getServer()->uuid,
            'downloadBatchSize' => (int) config(self::PLUGIN_ID.'.download_batch_size', 16),
            'strings' => trans(self::PLUGIN_ID.'::strings.map'),
        ];
    }

    public function getWorkerSource(): string
    {
        $js = dirname(__DIR__, 4).'/resources/js';

        return file_get_contents("$js/block-colors.js")."\n".file_get_contents("$js/region-worker.js");
    }

    public function getMapSource(): string
    {
        return file_get_contents(dirname(__DIR__, 4).'/resources/js/world-map.js') ?: '';
    }
}
