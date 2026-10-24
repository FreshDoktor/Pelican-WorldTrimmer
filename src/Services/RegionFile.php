<?php

namespace FreshDoktor\MinecraftWorldTrimmer\Services;

use FreshDoktor\MinecraftWorldTrimmer\Exceptions\WorldTrimmerException;

/**
 * A region file of the Anvil format (r.<x>.<z>.mca), holding up to 32x32 chunks.
 *
 * The file starts with two tables of 1024 entries: the location of each chunk (offset and length in
 * sectors of 4 KiB) and the time it was last saved. The chunks follow in whole sectors, each one
 * starting with its length and the compression it uses. A chunk is index x + z * 32 of its region.
 *
 * Plain PHP, no panel classes, so it can be tested on its own.
 */
class RegionFile
{
    public const SECTOR_SIZE = 4096;

    public const CHUNKS = 1024;

    // A set bit in the compression byte means the chunk is too large for the region and is stored in c.<x>.<z>.mcc.
    protected const EXTERNAL_FLAG = 0x80;

    /** @var array<int, int> location entry of each chunk, 0 if missing */
    protected array $locations;

    /** @var array<int, int> */
    protected array $timestamps;

    /**
     * @throws WorldTrimmerException
     */
    public function __construct(protected string $data)
    {
        if ($data === '') {
            // Minecraft creates empty region files, they hold no chunks.
            $this->locations = array_fill(0, self::CHUNKS, 0);
            $this->timestamps = array_fill(0, self::CHUNKS, 0);

            return;
        }

        if (strlen($data) < 2 * self::SECTOR_SIZE) {
            throw new WorldTrimmerException('The region file is too short to be valid.');
        }

        $this->locations = array_values(unpack('N1024', $data, 0) ?: []);
        $this->timestamps = array_values(unpack('N1024', $data, self::SECTOR_SIZE) ?: []);
    }

    public static function chunkIndex(int $x, int $z): int
    {
        return ($x & 31) | (($z & 31) << 5);
    }

    public function hasChunk(int $index): bool
    {
        return $this->readableRange($index) !== null;
    }

    public function countChunks(): int
    {
        $count = 0;

        for ($index = 0; $index < self::CHUNKS; $index++) {
            if ($this->hasChunk($index)) {
                $count++;
            }
        }

        return $count;
    }

    /**
     * Chunks of the given ones that are stored in an external c.<x>.<z>.mcc file.
     *
     * @param  array<int>  $indices
     * @return array<int>
     */
    public function externalChunks(array $indices): array
    {
        return array_values(array_filter($indices, function (int $index) {
            $range = $this->readableRange($index);

            return $range !== null && (ord($this->data[$range[0] + 4] ?? "\0") & self::EXTERNAL_FLAG) !== 0;
        }));
    }

    /**
     * The file without the given chunks. The chunks that are kept are packed one after the other, so
     * the file shrinks by the sectors that were removed, also by those Minecraft left unused before.
     *
     * Chunks whose location points outside of the file are dropped, Minecraft can't read them either.
     *
     * @param  array<int>  $indices
     */
    public function withoutChunks(array $indices): string
    {
        $remove = array_fill_keys($indices, true);

        $locations = '';
        $timestamps = '';
        $body = '';
        $sector = 2;

        for ($index = 0; $index < self::CHUNKS; $index++) {
            $range = isset($remove[$index]) ? null : $this->readableRange($index);

            if ($range === null) {
                $locations .= pack('N', 0);
                $timestamps .= pack('N', 0);

                continue;
            }

            [$start, $sectors] = $range;

            $bytes = substr($this->data, $start, $sectors * self::SECTOR_SIZE);
            $body .= str_pad($bytes, $sectors * self::SECTOR_SIZE, "\0");

            $locations .= pack('N', ($sector << 8) | $sectors);
            $timestamps .= pack('N', $this->timestamps[$index]);
            $sector += $sectors;
        }

        return $locations.$timestamps.$body;
    }

    /**
     * Byte offset and sector count of a chunk, null if it is missing or lies outside of the file.
     *
     * @return array{int, int}|null
     */
    protected function readableRange(int $index): ?array
    {
        $location = $this->locations[$index] ?? 0;
        $offset = $location >> 8;
        $sectors = $location & 0xFF;

        if ($offset < 2 || $sectors === 0) {
            return null;
        }

        $start = $offset * self::SECTOR_SIZE;

        // The chunk at least has to fit its length and compression byte.
        if ($start + 5 > strlen($this->data)) {
            return null;
        }

        return [$start, $sectors];
    }
}
