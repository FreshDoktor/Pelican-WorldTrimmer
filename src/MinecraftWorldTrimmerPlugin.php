<?php

namespace FreshDoktor\MinecraftWorldTrimmer;

use Filament\Contracts\Plugin;
use Filament\Panel;
use FreshDoktor\MinecraftWorldTrimmer\Filament\Server\Pages\WorldTrimmer;

class MinecraftWorldTrimmerPlugin implements Plugin
{
    public function getId(): string
    {
        return 'minecraft-world-trimmer';
    }

    public function register(Panel $panel): void
    {
        $panel->pages([WorldTrimmer::class]);
    }

    public function boot(Panel $panel): void {}
}
