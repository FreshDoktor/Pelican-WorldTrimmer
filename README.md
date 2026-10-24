# Minecraft World Trimmer

A plugin for the [Pelican Panel](https://pelican.dev) that shows a map of a Minecraft world and removes the chunks nobody needs, similar to [MCA Selector](https://github.com/Querz/mcaselector), right in the panel.

## Features

- **World map**: Every dimension of the world seen from above, including the dimensions of datapacks and mods; blocks of mods get the color their name suggests (e.g. `*_leaves`, `*_log`) or gray
- **Heat maps**: Time played in each chunk (`InhabitedTime`) and when it was saved last
- **Select chunks**: Click, drag an area, whole regions, invert, or by time played with a radius around the spawn kept
- **Remove chunks**: From the region, entities and poi files at once; region files are packed afterwards, so the freed space is really freed, and deleted once they are empty
- **Light on the panel**: The browser downloads the region files straight from the node and draws the map itself, one region at a time; the panel only touches a region file when chunks are removed from it
- **Multilingual**: English and German

## Requirements

- Pelican Panel with plugin support
- A Java Edition server: the egg needs the `minecraft` tag (not `proxy` or `bedrock`), or `world_trimmer` in its features
- A current browser (Chrome/Edge 80+, Firefox 113+, Safari 16.4+)

## Installation

Clone the repository into the `plugins` folder of your panel. The folder has to be named like the plugin id:

```bash
cd /var/www/pelican/plugins
git clone https://github.com/FreshDoktor/Pelican-WorldTrimmer.git minecraft-world-trimmer
```

Then install and enable the plugin in the admin area of the panel under _Plugins_.

## Usage

Open _World Trimmer_ in the menu of a server. The map lists the region files at once and draws the regions in view first; _Load all regions_ reads the whole world, which the filter needs to include every chunk.

| Action | Effect |
| --- | --- |
| Drag | Move the map |
| Scroll | Zoom |
| Click | Select a chunk, or a whole region when zoomed out far |
| Shift + drag | Select an area |
| Ctrl + drag | Deselect an area |

**Removing chunks** needs the server to be stopped, Minecraft would overwrite the changes otherwise. Removed chunks are generated anew once a player comes close, with the generator of the current Minecraft version and mods. Make a backup first.

Each region is changed on its own: the panel loads the file from the node, writes the trimmed copy next to it and swaps it in, so a region file is never left half written. Region files larger than 64 MB are refused, raise the limit with `WORLD_TRIMMER_MAX_REGION_SIZE_MB` in the `.env` of the panel if needed.

The removals are listed in the activity log of the server.

### Permissions

| Permission | Allows |
| --- | --- |
| `file.read-content` | Seeing the map |
| `file.update` and `file.delete` | Removing chunks |

### Regions stay red

Red regions could not be downloaded. The browser fetches them from the node like the file manager's uploads do, so the node has to allow the panel's address (`remote` in the Wings config, or `allowed_origins`). The browser console names the cause.

## Supported worlds

Java Edition worlds from 1.9 on, including the folder layout of 26.1 and later (`<world>/dimensions/<namespace>/<name>`) and the separate nether and end worlds of Spigot and Paper. Chunks compressed with GZip, Zlib, LZ4 or not at all are read; chunks stored in external `.mcc` files are shown in dark gray but can be removed like any other.

## Credits

The block and biome colors come from [MCA Selector](https://github.com/Querz/mcaselector) by Querz (MIT License), see `resources/js/block-colors.js`. `tools/gen_colors.py` creates that file from the `mapping` folder of MCA Selector.
