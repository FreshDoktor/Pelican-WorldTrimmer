<?php

namespace FreshDoktor\MinecraftWorldTrimmer\Services;

use App\Enums\ContainerStatus;
use App\Enums\NodeJwtScope;
use App\Models\Server;
use App\Models\User;
use App\Repositories\Daemon\DaemonFileRepository;
use App\Repositories\Daemon\DaemonServerRepository;
use App\Services\Nodes\NodeJWTService;
use Carbon\CarbonImmutable;
use Exception;
use FreshDoktor\MinecraftWorldTrimmer\Exceptions\WorldTrimmerException;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\Cache;
use Psr\Http\Message\ResponseInterface;

/**
 * The worlds of a server, read and changed through the daemon.
 *
 * The map is drawn by the browser, which downloads the region files straight from the daemon with
 * signed links, so they never pass the panel. Only removing chunks goes through the panel, one region
 * file at a time.
 *
 * @phpstan-type Dimension array{id: string, label: string, path: string}
 * @phpstan-type Region array{name: string, x: int, z: int, size: int, modified: string}
 * @phpstan-type TrimResult array{removed: int, deleted: bool, freed: int}
 */
class WorldService
{
    public const DEFAULT_LEVEL_NAME = 'world';

    // The folders of a dimension that hold region files, all three use the same chunk layout.
    public const REGION_FOLDERS = ['region', 'entities', 'poi'];

    public const REGION_PATTERN = '/^r\.(-?\d{1,7})\.(-?\d{1,7})\.mca$/';

    // Suffixes of the copies a region file is replaced with, so it is never only half written.
    protected const NEW_SUFFIX = '.trimmer-new';

    protected const OLD_SUFFIX = '.trimmer-old';

    // Seconds to wait for the daemon while it sends or receives a whole region file.
    protected const TRANSFER_TIMEOUT = 120;

    // Minutes a download link handed to the browser stays valid.
    protected const DOWNLOAD_LINK_MINUTES = 15;

    // Seconds removing chunks from a single region may hold the lock of its server.
    protected const TRIM_LOCK_SECONDS = 300;

    // The vanilla dimensions, each one in its own folder of the world, or (Spigot, Paper) of its own world.
    protected const VANILLA_DIMENSIONS = [
        'minecraft:overworld' => ['', null],
        'minecraft:the_nether' => ['DIM-1', '_nether'],
        'minecraft:the_end' => ['DIM1', '_the_end'],
    ];

    public static function isEnabledForServer(Server $server): bool
    {
        $server->loadMissing('egg');

        $features = $server->egg->features ?? [];
        $tags = $server->egg->tags ?? [];

        if (in_array('world_trimmer', $features)) {
            return true;
        }

        // Proxies have no worlds, Bedrock stores its worlds in another format.
        return in_array('minecraft', $tags) && !in_array('proxy', $tags) && !in_array('bedrock', $tags);
    }

    /**
     * Whether Minecraft is stopped, so it can't write the region files while they are changed.
     * Asks the daemon right away, the status the panel keeps may be a few seconds old.
     */
    public function isOffline(Server $server): bool
    {
        $state = app(DaemonServerRepository::class)->setServer($server)->getDetails(5)['state'] ?? null;

        return $state === ContainerStatus::Offline->value;
    }

    /**
     * Every dimension of the world that has a region folder.
     *
     * @return array<string, Dimension> by id
     */
    public function getDimensions(Server $server): array
    {
        $level = $this->getLevelName($server);
        $dimensions = [];

        foreach (self::VANILLA_DIMENSIONS as $id => [$folder, $worldSuffix]) {
            $candidates = [trim("$level/$folder", '/')];

            if ($worldSuffix !== null) {
                $candidates[] = "$level$worldSuffix/$folder";
            }

            foreach ($candidates as $path) {
                if ($this->hasRegionFolder($server, $path)) {
                    $dimensions[$id] = ['id' => $id, 'label' => $id, 'path' => $path];

                    break;
                }
            }
        }

        // Dimensions of datapacks and mods, and since 26.1 also the vanilla ones: <level>/dimensions/<namespace>/<name>.
        foreach ($this->listFolders($server, "$level/dimensions") as $namespace) {
            foreach ($this->listFolders($server, "$level/dimensions/$namespace") as $name) {
                $path = "$level/dimensions/$namespace/$name";

                if (!isset($dimensions["$namespace:$name"]) && $this->hasRegionFolder($server, $path)) {
                    $dimensions["$namespace:$name"] = ['id' => "$namespace:$name", 'label' => "$namespace:$name", 'path' => $path];
                }
            }
        }

        return $dimensions;
    }

    /**
     * The region files of a dimension, read from the directory listing alone.
     *
     * @return array<int, Region>
     */
    public function getRegions(Server $server, string $dimensionPath): array
    {
        try {
            $files = app(DaemonFileRepository::class)->setServer($server)->getDirectory("$dimensionPath/region");
        } catch (RequestException $exception) {
            if ($exception->response->status() === 404) {
                return [];
            }

            throw $exception;
        }

        $regions = [];

        foreach ($files as $file) {
            if (!($file['file'] ?? false) || !preg_match(self::REGION_PATTERN, $file['name'] ?? '', $matches)) {
                continue;
            }

            $regions[] = [
                'name' => $file['name'],
                'x' => (int) $matches[1],
                'z' => (int) $matches[2],
                'size' => (int) ($file['size'] ?? 0),
                'modified' => (string) ($file['modified'] ?? ''),
            ];
        }

        return $regions;
    }

    /**
     * Links the browser downloads region files with, straight from the daemon. Each one works once.
     *
     * @param  array<string>  $names
     * @return array<string, string> link by file name
     */
    public function getDownloadLinks(Server $server, User $user, string $dimensionPath, array $names): array
    {
        $service = app(NodeJWTService::class);
        $links = [];

        foreach ($names as $name) {
            if (!is_string($name) || !preg_match(self::REGION_PATTERN, $name)) {
                continue;
            }

            $token = $service
                ->setExpiresAt(CarbonImmutable::now()->addMinutes(self::DOWNLOAD_LINK_MINUTES))
                ->setScopes(NodeJwtScope::FileDownload)
                ->setUser($user)
                ->setClaims([
                    'file_path' => "$dimensionPath/region/$name",
                    'server_uuid' => $server->uuid,
                ])
                ->handle($server->node, $user->id.$server->uuid);

            $links[$name] = $server->node->getConnectionAddress().'/download/file?token='.$token->toString();
        }

        return $links;
    }

    /**
     * Remove chunks of one region from its region, entities and poi file. A file that is left
     * without chunks is deleted. Minecraft generates removed chunks again once they are visited.
     *
     * @param  array<int>|null  $indices  chunks by index (x + z * 32), null for all of them
     * @return TrimResult
     *
     * @throws WorldTrimmerException
     */
    public function trimRegion(Server $server, string $dimensionPath, string $name, ?array $indices): array
    {
        if (!preg_match(self::REGION_PATTERN, $name, $matches)) {
            throw new WorldTrimmerException(trans('minecraft-world-trimmer::strings.errors.invalid_region'));
        }

        $indices = $indices === null ? range(0, RegionFile::CHUNKS - 1) : array_values(array_unique(array_filter(
            array_map('intval', $indices),
            fn (int $index) => $index >= 0 && $index < RegionFile::CHUNKS,
        )));

        $result = ['removed' => 0, 'deleted' => false, 'freed' => 0];

        if (empty($indices)) {
            return $result;
        }

        try {
            return Cache::lock("minecraft-world-trimmer:server:$server->id", self::TRIM_LOCK_SECONDS)->block(10, function () use ($server, $dimensionPath, $name, $indices, $matches, $result) {
                if (!$this->isOffline($server)) {
                    throw new WorldTrimmerException(trans('minecraft-world-trimmer::strings.errors.server_running'));
                }

                foreach (self::REGION_FOLDERS as $folder) {
                    $trimmed = $this->trimRegionFile($server, "$dimensionPath/$folder", $name, (int) $matches[1], (int) $matches[2], $indices);

                    // The chunks themselves are counted in the region folder, entities and poi hold extra data of the same chunks.
                    if ($folder === 'region') {
                        $result['removed'] = $trimmed['removed'];
                        $result['deleted'] = $trimmed['deleted'];
                    }

                    $result['freed'] += $trimmed['freed'];
                }

                return $result;
            });
        } catch (LockTimeoutException) {
            throw new WorldTrimmerException(trans('minecraft-world-trimmer::strings.errors.busy'));
        }
    }

    /**
     * @param  array<int>  $indices
     * @return TrimResult
     *
     * @throws WorldTrimmerException
     */
    protected function trimRegionFile(Server $server, string $directory, string $name, int $regionX, int $regionZ, array $indices): array
    {
        $result = ['removed' => 0, 'deleted' => false, 'freed' => 0];
        $repository = app(DaemonFileRepository::class)->setServer($server);

        $data = $this->readFile($server, "$directory/$name");

        if ($data === null) {
            return $result;
        }

        $region = new RegionFile($data);
        $present = array_values(array_filter($indices, fn (int $index) => $region->hasChunk($index)));

        if (empty($present)) {
            return $result;
        }

        // Oversized chunks live in their own file next to the region file.
        $external = array_map(function (int $index) use ($regionX, $regionZ) {
            $chunkX = $regionX * 32 + ($index & 31);
            $chunkZ = $regionZ * 32 + ($index >> 5);

            return "c.$chunkX.$chunkZ.mcc";
        }, $region->externalChunks($present));

        $result['removed'] = count($present);

        if (count($present) === $region->countChunks()) {
            $repository->deleteFiles($directory, [$name]);

            $result['deleted'] = true;
            $result['freed'] = strlen($data);
        } else {
            $trimmed = $region->withoutChunks($present);
            $result['freed'] = strlen($data) - strlen($trimmed);

            $this->replaceFile($server, $directory, $name, $trimmed);
        }

        if (!empty($external)) {
            $this->deleteQuietly($server, $directory, $external);
        }

        return $result;
    }

    /**
     * Swap a file for new content without a moment in which it is half written: the content goes to
     * a copy first, which then takes the place of the file.
     *
     * @throws WorldTrimmerException
     */
    protected function replaceFile(Server $server, string $directory, string $name, string $content): void
    {
        $repository = app(DaemonFileRepository::class)->setServer($server);
        $new = $name.self::NEW_SUFFIX;
        $old = $name.self::OLD_SUFFIX;

        $repository->getHttpClient()
            ->timeout(max((int) config('panel.guzzle.timeout'), self::TRANSFER_TIMEOUT))
            ->withQueryParameters(['file' => "$directory/$new"])
            ->withBody($content, 'application/octet-stream')
            ->post("/api/servers/{$server->uuid}/files/write");

        // The daemon doesn't overwrite on renames, so a copy left behind by an earlier attempt has to go first.
        $this->deleteQuietly($server, $directory, [$old]);

        $repository->renameFiles($directory, [['from' => $name, 'to' => $old]]);

        try {
            $repository->renameFiles($directory, [['from' => $new, 'to' => $name]]);
        } catch (Exception $exception) {
            // Put the original back, a missing region file would make Minecraft generate it anew.
            $repository->renameFiles($directory, [['from' => $old, 'to' => $name]]);

            throw $exception;
        }

        $this->deleteQuietly($server, $directory, [$old]);
    }

    /**
     * Content of a file, null if it doesn't exist.
     *
     * @throws WorldTrimmerException
     */
    protected function readFile(Server $server, string $path): ?string
    {
        $maxBytes = (int) config('minecraft-world-trimmer.max_region_size_mb', 64) * 1024 * 1024;

        try {
            return app(DaemonFileRepository::class)->setServer($server)->getHttpClient()
                ->timeout(max((int) config('panel.guzzle.timeout'), self::TRANSFER_TIMEOUT))
                // Refuse large files before their content arrives, the whole file is held in memory.
                ->withOptions(['on_headers' => function (ResponseInterface $response) use ($maxBytes) {
                    if ((int) $response->getHeaderLine('Content-Length') > $maxBytes) {
                        throw new WorldTrimmerException(trans('minecraft-world-trimmer::strings.errors.region_too_large', ['size' => $maxBytes / 1024 / 1024]));
                    }
                }])
                ->get("/api/servers/{$server->uuid}/files/contents", ['file' => $path])
                ->body();
        } catch (RequestException $exception) {
            if ($exception->response->status() === 404) {
                return null;
            }

            throw $exception;
        } catch (Exception $exception) {
            // Guzzle wraps exceptions thrown while reading the headers.
            $previous = $exception->getPrevious();

            throw $previous instanceof WorldTrimmerException ? $previous : $exception;
        }
    }

    /**
     * Delete files, whether they exist or not.
     *
     * @param  array<string>  $names
     */
    protected function deleteQuietly(Server $server, string $directory, array $names): void
    {
        $repository = app(DaemonFileRepository::class)->setServer($server);

        foreach ($names as $name) {
            try {
                $repository->deleteFiles($directory, [$name]);
            } catch (RequestException) {
                // Not there.
            }
        }
    }

    /**
     * Name of the world folder, as configured by `level-name` in server.properties.
     */
    public function getLevelName(Server $server): string
    {
        try {
            $properties = app(DaemonFileRepository::class)->setServer($server)->getContent('server.properties');
        } catch (Exception) {
            // Not started yet, the server will create the default world.
            return self::DEFAULT_LEVEL_NAME;
        }

        foreach (preg_split('/\R/', $properties) ?: [] as $line) {
            if (!preg_match('/^\s*level-name\s*[=:]\s*(.*?)\s*$/', $line, $matches)) {
                continue;
            }

            // Java properties escape special characters with a backslash.
            $name = trim(preg_replace('/\\\\(.)/', '$1', $matches[1]) ?? '', '/');

            $parts = explode('/', $name);

            if ($name === '' || in_array('..', $parts, true) || in_array('.', $parts, true) || str_contains($name, "\0")) {
                return self::DEFAULT_LEVEL_NAME;
            }

            return $name;
        }

        return self::DEFAULT_LEVEL_NAME;
    }

    protected function hasRegionFolder(Server $server, string $path): bool
    {
        return in_array('region', $this->listFolders($server, $path), true);
    }

    /**
     * Names of the folders in a folder, none if it doesn't exist.
     *
     * @return array<string>
     */
    protected function listFolders(Server $server, string $path): array
    {
        try {
            $files = app(DaemonFileRepository::class)->setServer($server)->getDirectory($path === '' ? '/' : $path);
        } catch (Exception) {
            return [];
        }

        return array_values(array_map(
            fn (array $file) => $file['name'],
            array_filter($files, fn ($file) => is_array($file) && ($file['directory'] ?? false) && is_string($file['name'] ?? null)),
        ));
    }
}
