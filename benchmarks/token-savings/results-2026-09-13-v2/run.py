#!/usr/bin/env python3
"""Offline production-code A/B projection benchmark; NOT subscription accounting."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PATHS = {
    "memory": Path("src/core/agent/runtime/execution_memory.zig"),
    "api": Path("src/provider/api_protocol.zig"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zig", required=True)
    parser.add_argument("--baseline-memory", type=Path, required=True)
    parser.add_argument("--baseline-api", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    baselines = {"memory": args.baseline_memory, "api": args.baseline_api}
    hashes = {}
    rows = {}
    with tempfile.TemporaryDirectory(prefix="handwork-token-savings-") as temporary:
        root = Path(temporary)
        shutil.copytree(ROOT / "src", root / "src")
        shutil.copy2(HERE / "probe.zig", root / "src/token_savings_probe.zig")
        (root / "options.zig").write_text('pub const app_version = "benchmark";\npub const git_commit = "unknown";\npub const update_channel = "dev";\npub const wasm_surface = enum { none, core, term }.none;\n')
        for variant in ("baseline", "optimized"):
            hashes[variant] = {}
            for key, path in PATHS.items():
                source = baselines[key] if variant == "baseline" else ROOT / path
                data = source.read_bytes()
                hashes[variant][str(path)] = hashlib.sha256(data).hexdigest()
                (root / path).write_bytes(data)
                snapshot = args.output / variant / path
                snapshot.parent.mkdir(parents=True, exist_ok=True)
                snapshot.write_bytes(data)
            command = [args.zig, "test", "-lc", "--dep", "build_options",
                       f"-Mroot={root / 'src/token_savings_probe.zig'}",
                       f"-Mbuild_options={root / 'options.zig'}",
                       "--test-filter", "token savings production projection benchmark"]
            result = subprocess.run(command, cwd=root, capture_output=True, text=True)
            (args.output / f"{variant}.log").write_text(result.stdout + result.stderr)
            if result.returncode:
                raise RuntimeError(f"{variant} failed ({result.returncode}); see {args.output / (variant + '.log')}")
            parsed = re.findall(r"SAVINGS,([^,\n]+),(\d+),(\d+),(\d+)", result.stdout + result.stderr)
            assert len(parsed) == 42, f"Expected 42 measurements, got {len(parsed)}"
            for name, size, count, tokens in parsed:
                row = rows.setdefault((name, int(size)), {"case": name, "raw_bytes": int(size)})
                row[variant] = {"model_bytes": int(count), "estimated_text_tokens": int(tokens)}
    for row in rows.values():
        old, new = row["baseline"], row["optimized"]
        row["byte_reduction_percent"] = round(100 * (1 - new["model_bytes"] / old["model_bytes"]), 2)
        row["estimated_text_token_reduction_percent"] = round(100 * (1 - new["estimated_text_tokens"] / old["estimated_text_tokens"]), 2)
    report = {"scope": "Synthetic isolated production projections, not end-to-end tasks or provider/quota measurements",
              "token_method": "Handwork StreamingEstimator on serialized text; not provider tokenization, excludes image token cost",
              "model_generations": 0, "provider_output_tokens": None, "subscription_savings_percent": None,
              "zig_version": subprocess.check_output([args.zig, "version"], text=True).strip(),
              "source_sha256": hashes, "cases": list(rows.values())}
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    shutil.copy2(HERE / "probe.zig", args.output / "probe.zig")
    shutil.copy2(__file__, args.output / "run.py")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
