#!/usr/bin/env python3
"""Download the Live2D runtime files and a free sample model for local use.

These files are not committed to this repo. Running this script means you
accept their licenses:
- Cubism Core: Live2D Proprietary Software License (Redistributable Code)
  https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- Sample models: Live2D Free Material License
  https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html
- pixi.js and pixi-live2d-display: MIT (pixi-live2d-display bundles the
  Cubism Framework under the Live2D Open Software License)
"""

import argparse
import json
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
TARGET = PROJECT / "gnome-extension" / "assets" / "live2d"
SAMPLES = "https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources"
RUNTIME = {
    "live2dcubismcore.min.js": "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js",
    "pixi.min.js": "https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js",
    "cubism4.min.js": "https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js",
}


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "zaiko-fetch-live2d"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data: bytes = response.read()
        return data


def fetch_model(name: str) -> None:
    folder = TARGET / name
    manifest = download(f"{SAMPLES}/{name}/{name}.model3.json")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.model3.json").write_bytes(manifest)
    refs = json.loads(manifest)["FileReferences"]
    files = [refs["Moc"], *refs.get("Textures", [])]
    files += [refs[key] for key in ("Physics", "Pose") if key in refs]
    files += [item["File"] for item in refs.get("Expressions", [])]
    files += [item["File"] for group in refs.get("Motions", {}).values() for item in group]
    for relative in files:
        destination = folder / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(download(f"{SAMPLES}/{name}/{relative}"))
        print(f"  {name}/{relative}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the Live2D runtime and a free sample model.")
    parser.add_argument("--model", default="Mao", help="sample model name (default: Mao)")
    args = parser.parse_args()
    TARGET.mkdir(parents=True, exist_ok=True)
    for name, url in RUNTIME.items():
        (TARGET / name).write_bytes(download(url))
        print(f"  {name}")
    fetch_model(args.model)
    print(f"Live2D files are in {TARGET}")


if __name__ == "__main__":
    main()
