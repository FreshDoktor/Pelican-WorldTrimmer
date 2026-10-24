import json, sys, os, re
src, out = sys.argv[1], sys.argv[2]
def vkey(d):
    m = re.match(r'java_(\d+)(?:_(\d+))?', d); return (int(m.group(1)), int(m.group(2) or 0))
dirs = sorted([d for d in os.listdir(src) if d.startswith('java_')], key=vkey)
colors, tints = {}, {}
for d in dirs:
    for f in sorted(x for x in os.listdir(os.path.join(src, d)) if x.startswith('colors_')):
        data = json.load(open(os.path.join(src, d, f), encoding='utf-8'))
        for name, v in data.get('colors', {}).items():
            if isinstance(v, str): c, p = v, 0
            elif 'color' in v: c, p = v['color'], v.get('properties', 0)
            else:
                dv = v['default']
                c, p = (dv, 0) if isinstance(dv, str) else (dv['color'], dv.get('properties', 0))
            colors[name.removeprefix('minecraft:')] = int(c, 16) if p == 0 else [int(c, 16), p]
        for name, v in data.get('tints', {}).items():
            tints[name.removeprefix('minecraft:')] = [int(x, 16) for x in v]
props = json.load(open(os.path.join(src, 'color_properties.json'), encoding='utf-8'))
static = {k.removeprefix('minecraft:'): int(v, 16) for k, v in {**props['static_tint'], **props['static_color']}.items()}
with open(out, 'w', encoding='utf-8', newline='\n') as fh:
    fh.write('// Generated from the color mappings of MCA Selector (https://github.com/Querz/mcaselector),\n')
    fh.write('// Copyright (c) 2018 - 2026 Querz, MIT License. Regenerate with tools/gen_colors.py.\n')
    fh.write('// Block name (without "minecraft:") -> rgb, or [rgb, flags]. Biome -> [grass, foliage, water, dry foliage].\n')
    fh.write('const BLOCK_COLORS = ' + json.dumps(colors, separators=(',', ':')) + ';\n')
    fh.write('const BIOME_TINTS = ' + json.dumps(tints, separators=(',', ':')) + ';\n')
    fh.write('const STATIC_TINTS = ' + json.dumps(static, separators=(',', ':')) + ';\n')
print(len(colors), len(tints), os.path.getsize(out))
