"""Pack the walkthrough's step images for the VSIX.

    python3 apps/extension/harness/walkthrough/pack.py <shotsDir> apps/extension/media/walkthrough

ONLY=merge,stage packs just those steps (as shots.ts renders just them).

Each <step>-<theme>.png that shots.ts rendered is reduced to a 256-colour
palette (UI renders have few colours; the text stays crisp) and, when oxipng
is installed, recompressed losslessly. A walkthrough image ships in every
VSIX, so it is about a third of the size a raw render is.

Needs Pillow (python3 -m pip install pillow).
"""

import os
import shutil
import subprocess
import sys

from PIL import Image

STEPS = ["graph", "blame", "stage", "history", "merge", "connect"]
THEMES = ["dark", "light", "hc-dark", "hc-light"]


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    only = [x for x in os.environ.get("ONLY", "").split(",") if x]
    total = 0
    for step in STEPS:
        if only and step not in only:
            continue
        for theme in THEMES:
            name = f"{step}-{theme}.png"
            im = Image.open(os.path.join(src, name)).convert("RGB")
            q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
            out = os.path.join(dst, name)
            q.save(out, optimize=True)
            if shutil.which("oxipng"):
                subprocess.run(["oxipng", "-o", "3", "--strip", "safe", "-q", out], check=True)
            size = os.path.getsize(out)
            total += size
            print(f"{name}: {im.size[0]}x{im.size[1]}, {size // 1024} KB")
    print(f"total {total // 1024} KB")


if __name__ == "__main__":
    main()
