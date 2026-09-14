"""Generate AgentRoam platform icons from the canonical SVG (Pillow, CairoSVG)."""
from pathlib import Path
from io import BytesIO
import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
assets = ROOT / 'packages/desktop/assets'
source = (assets / 'app-icon.svg').read_bytes()
master = Image.open(BytesIO(cairosvg.svg2png(bytestring=source))).convert('RGBA')
master.save(assets / 'app-icon.png')
# macOS artwork has transparent breathing room inside the square icon canvas.
mac = Image.new('RGBA', (1024, 1024))
mac.alpha_composite(master.resize((864, 864), Image.Resampling.LANCZOS), (80, 80))
mac.save(assets / 'app-icon.icns', format='ICNS')
master.save(assets / 'app-icon.ico', sizes=[(s, s) for s in [16, 24, 32, 48, 64, 128, 256]])
for folder in ['packages/desktop/renderer/public', 'packages/server/public']:
    p = ROOT / folder
    p.mkdir(parents=True, exist_ok=True)
    (p / 'agentroam-icon.svg').write_bytes(source)
    master.resize((180, 180), Image.Resampling.LANCZOS).save(p / 'apple-touch-icon.png')
    master.save(p / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
# iOS requires a fully opaque 1024px icon; OS supplies the corner mask.
solid = Image.new('RGBA', master.size, '#142d38')
solid.alpha_composite(master)
solid.convert('RGB').save(ROOT / 'packages/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
for density, size in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
    p = ROOT / 'packages/mobile/android/app/src/main/res' / ('mipmap-' + density)
    for name in ['ic_launcher.png', 'ic_launcher_round.png']:
        master.resize((size,size),Image.Resampling.LANCZOS).save(p / name)
    # Adaptive foreground uses Android's central 66/108 safe zone.
    n = round(size * 108 / 48)
    foreground = Image.new('RGBA', (n,n))
    symbol = source.decode().replace('  <rect width="280" height="280" rx="65" fill="#142d38"/>','')
    art = Image.open(BytesIO(cairosvg.svg2png(bytestring=symbol.encode(),output_width=n,output_height=n))).convert('RGBA')
    foreground.alpha_composite(art)
    foreground.save(p / 'ic_launcher_foreground.png')
for pattern in ['packages/mobile/android/app/src/main/res/drawable*/splash.png', 'packages/mobile/ios/App/App/Assets.xcassets/Splash.imageset/*.png']:
    for p in ROOT.glob(pattern):
        with Image.open(p) as old:
            width, height = old.size
        background = Image.new('RGBA', (width, height), '#142d38')
        size = max(32, round(min(width, height) * 0.28))
        background.alpha_composite(master.resize((size, size), Image.Resampling.LANCZOS), ((width-size)//2, (height-size)//2))
        background.convert('RGB').save(p)
print('Generated desktop, web and mobile brand icons')
