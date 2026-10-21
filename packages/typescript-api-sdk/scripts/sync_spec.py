#!/usr/bin/env python3
"""Validate production OpenAPI in a temporary file before replacing the vendored copy."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen

import yaml
from fix_spec import PATCHES, SpecLoader, dump_spec

ROOT = Path(__file__).resolve().parent.parent
PRODUCTION_URL = "https://api.runpod.io/v2/openapi.json"


def normalize(text):
    spec = yaml.load(text, Loader=SpecLoader)
    if not isinstance(spec, dict) or not str(spec.get("openapi", "")).startswith("3.") or not isinstance(spec.get("paths"), dict) or not spec["paths"]:
        raise ValueError("Expected a nonempty OpenAPI 3 document")
    for _, patch in PATCHES:
        patch(spec)
    return spec


def sync(url, destination, check=False):
    # Read-only, public production endpoint. No API key is sent.
    with urlopen(Request(url, headers={"User-Agent": "runpod-typescript-sdk-spec-sync", "Accept": "application/json, application/yaml"}), timeout=30) as response:
        latest = normalize(response.read().decode("utf-8"))
    if check:
        current = normalize(destination.read_text(encoding="utf-8"))
        if latest != current:
            raise ValueError("Production OpenAPI differs; run pnpm spec:pull, regenerate, and review the diff")
        print("Vendored spec matches normalized production OpenAPI.")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Same filesystem for atomic replacement; failed download/patch/generation leaves the old file intact.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", dir=destination.parent, delete=False, encoding="utf-8") as temp:
        temporary = Path(temp.name)
        temp.write(dump_spec(latest))
    try:
        # Validate generation without touching tracked output.
        env = {**os.environ, "PYTHON": sys.executable}
        subprocess.run(["node", str(ROOT / "scripts/validate_spec.mjs"), str(temporary)], check=True, env=env)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Updated {destination}; run pnpm generate and review both diffs.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=PRODUCTION_URL)
    parser.add_argument("--spec", type=Path, default=ROOT / "spec/openapi.yaml")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        sync(args.url, args.spec, args.check)
    except Exception as error:
        print(f"Spec sync failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
