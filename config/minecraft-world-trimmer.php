<?php

return [
    // Largest region file (in MB) the panel loads into memory to remove chunks from it. Region files
    // whose chunks are all removed are deleted without loading them, whatever their size.
    'max_region_size_mb' => env('WORLD_TRIMMER_MAX_REGION_SIZE_MB', 64),

    // Download links handed to the browser per request; the browser fetches the region files itself.
    'download_batch_size' => 16,
];
