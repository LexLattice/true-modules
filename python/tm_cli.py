#!/usr/bin/env python3
"""Python shim around the True Modules CLI."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
TM_ENTRYPOINT = REPO_ROOT / "tm.mjs"


@dataclass
class TmCliError(Exception):
    """Structured error raised when the tm CLI or wrapper fails."""

    code: str
    message: str
    data: Optional[Dict[str, Any]] = None
    exit_code: int = 1

    def __str__(self) -> str:  # pragma: no cover - human readable fallback
        return f"{self.code}: {self.message}"


def read_json_from_stdin() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive path
        raise TmCliError(
            "E_INPUT",
            "STDIN must contain valid JSON.",
            data={"error": str(exc)},
            exit_code=2,
        ) from exc
    if not isinstance(payload, dict):
        raise TmCliError(
            "E_INPUT",
            "STDIN payload must be a JSON object.",
            data={"type": type(payload).__name__},
            exit_code=2,
        )
    return payload


def normalize_json_input(name: str, value: Any, *, required: bool = True) -> Optional[Dict[str, Any]]:
    if value is None:
        if required:
            raise TmCliError("E_INPUT", f"{name} is required.", exit_code=2)
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise TmCliError(
                "E_INPUT",
                f"{name} must be valid JSON if provided as a string.",
                data={"error": str(exc)},
                exit_code=2,
            ) from exc
    if not isinstance(value, dict):
        raise TmCliError(
            "E_INPUT",
            f"{name} must be a JSON object.",
            data={"type": type(value).__name__},
            exit_code=2,
        )
    return value


def extract_cli_error(stderr: str) -> Optional[Dict[str, str]]:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    for line in reversed(lines):
        match = re.match(r"tm error:\s*([A-Z0-9_]+)\s*(.*)$", line, re.IGNORECASE)
        if match:
            code = match.group(1).upper()
            message = match.group(2).strip() or f"tm CLI failed with {code}"
            return {"code": code, "message": message}
    return None


def run_tm(cli_args: Iterable[str], *, node_bin: str) -> subprocess.CompletedProcess[str]:
    cmd = [node_bin, str(TM_ENTRYPOINT), *cli_args]
    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            cwd=str(REPO_ROOT),
        )
    except subprocess.CalledProcessError as exc:
        parsed = extract_cli_error(exc.stderr or "")
        code = parsed["code"] if parsed else "E_TM_CLI"
        message = parsed["message"] if parsed else f"tm CLI failed with exit code {exc.returncode}"
        data = {
            "exit_code": exc.returncode,
            "stdout": exc.stdout,
            "stderr": exc.stderr,
            "args": list(cli_args),
        }
        raise TmCliError(code, message, data=data, exit_code=exc.returncode or 1) from exc
    if completed.stdout:
        sys.stderr.write(completed.stdout)
        if not completed.stdout.endswith("\n"):
            sys.stderr.write("\n")
    if completed.stderr:
        sys.stderr.write(completed.stderr)
        if not completed.stderr.endswith("\n"):
            sys.stderr.write("\n")
    return completed


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))


def read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text())


def resolve_modules_root(
    payload: Dict[str, Any],
    *,
    cli_override: Optional[str],
) -> Path:
    candidate = (
        payload.get("modules_root")
        or cli_override
        or os.environ.get("TM_MCP_MODULES_ROOT")
        or os.environ.get("TM_MODULES_ROOT")
    )
    if not candidate:
        raise TmCliError(
            "E_MODULES_ROOT_REQUIRED",
            "modules_root not provided and TM_MCP_MODULES_ROOT/TM_MODULES_ROOT is not set.",
            exit_code=2,
        )
    path = Path(candidate)
    if not path.is_absolute():
        path = (REPO_ROOT / path).resolve()
    if not path.exists():
        raise TmCliError(
            "E_MODULES_ROOT",
            f"modules_root does not exist: {path}",
            data={"modules_root": str(path)},
            exit_code=2,
        )
    if not path.is_dir():
        raise TmCliError(
            "E_MODULES_ROOT",
            f"modules_root must be a directory: {path}",
            data={"modules_root": str(path)},
            exit_code=2,
        )
    return path


def parse_events(events_path: Path) -> List[Dict[str, Any]]:
    try:
        raw = events_path.read_text()
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise TmCliError(
            "E_EVENTS_READ",
            "Failed to read tm gates events output.",
            data={"file_path": str(events_path), "error": str(exc)},
        ) from exc
    events: List[Dict[str, Any]] = []
    for idx, line in enumerate(raw.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            events.append(json.loads(stripped))
        except json.JSONDecodeError as exc:
            raise TmCliError(
                "E_EVENTS_PARSE",
                "Failed to parse tm gates events.",
                data={
                    "file_path": str(events_path),
                    "line_number": idx,
                    "line": stripped,
                    "error": str(exc),
                },
            ) from exc
    return events


def handle_meta(payload: Dict[str, Any], *, node_bin: str) -> Dict[str, Any]:
    coverage = normalize_json_input("coverage", payload.get("coverage"))
    respect_requires = bool(payload.get("respect_requires"))
    with tempfile.TemporaryDirectory(prefix="tm-meta-") as tmp:
        tmp_path = Path(tmp)
        coverage_path = tmp_path / "coverage.json"
        compose_path = tmp_path / "compose.json"
        write_json(coverage_path, coverage)
        cli_args = [
            "meta",
            "--coverage",
            str(coverage_path),
            "--out",
            str(compose_path),
        ]
        if respect_requires:
            cli_args.append("--respect-requires")
        run_tm(cli_args, node_bin=node_bin)
        compose = read_json(compose_path)
    return {"compose": compose}


def handle_compose(payload: Dict[str, Any], *, cli_override: Optional[str], node_bin: str) -> Dict[str, Any]:
    compose = normalize_json_input("compose", payload.get("compose"))
    overrides = normalize_json_input("overrides", payload.get("overrides"), required=False)
    modules_root = resolve_modules_root(payload, cli_override=cli_override)
    with tempfile.TemporaryDirectory(prefix="tm-compose-") as tmp:
        tmp_path = Path(tmp)
        compose_path = tmp_path / "compose.json"
        write_json(compose_path, compose)
        overrides_path: Optional[Path] = None
        if overrides is not None:
            overrides_path = tmp_path / "overrides.json"
            write_json(overrides_path, overrides)
        winner_dir = tmp_path / "winner"
        cli_args: List[str] = [
            "compose",
            "--compose",
            str(compose_path),
            "--modules-root",
            str(modules_root),
            "--out",
            str(winner_dir),
        ]
        if overrides_path is not None:
            cli_args.extend(["--overrides", str(overrides_path)])
        run_tm(cli_args, node_bin=node_bin)
        report = read_json(winner_dir / "report.json")
    return {"report": report}


def handle_gates(payload: Dict[str, Any], *, cli_override: Optional[str], node_bin: str) -> Dict[str, Any]:
    compose = normalize_json_input("compose", payload.get("compose"))
    overrides = normalize_json_input("overrides", payload.get("overrides"), required=False)
    mode = str(payload.get("mode", "shipping")).strip() or "shipping"
    if mode not in {"conceptual", "shipping"}:
        raise TmCliError("E_INPUT", "mode must be either 'conceptual' or 'shipping'.", exit_code=2)
    strict_events = bool(payload.get("strict_events"))
    modules_root = resolve_modules_root(payload, cli_override=cli_override)
    with tempfile.TemporaryDirectory(prefix="tm-gates-") as tmp:
        tmp_path = Path(tmp)
        compose_path = tmp_path / "compose.json"
        events_path = tmp_path / "events.ndjson"
        write_json(compose_path, compose)
        overrides_path: Optional[Path] = None
        if overrides is not None:
            overrides_path = tmp_path / "overrides.json"
            write_json(overrides_path, overrides)
        cli_args: List[str] = [
            "gates",
            mode,
            "--compose",
            str(compose_path),
            "--modules-root",
            str(modules_root),
            "--emit-events",
            "--events-out",
            str(events_path),
        ]
        if overrides_path is not None:
            cli_args.extend(["--overrides", str(overrides_path)])
        if strict_events:
            cli_args.append("--strict-events")
        try:
            run_tm(cli_args, node_bin=node_bin)
        except TmCliError as err:
            events: List[Dict[str, Any]] = []
            events_error: Optional[TmCliError] = None
            try:
                events = parse_events(events_path)
            except TmCliError as parse_err:
                events_error = parse_err
            data = dict(err.data or {})
            data.update({"pass": False, "events": events})
            if events_error is not None:
                data["events_error"] = {
                    "code": events_error.code,
                    "message": events_error.message,
                    **(events_error.data or {}),
                }
            raise TmCliError(err.code, err.message, data=data, exit_code=err.exit_code) from err
        events = parse_events(events_path)
    return {"pass": True, "events": events}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Python wrapper for the tm CLI")
    parser.add_argument(
        "command",
        choices=("meta", "compose", "gates"),
        help="tm command to execute",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON responses.",
    )
    parser.add_argument(
        "--modules-root",
        dest="modules_root",
        help="Default modules_root if omitted from the JSON payload.",
    )
    parser.add_argument(
        "--node-bin",
        dest="node_bin",
        default=os.environ.get("TM_NODE_BIN", "node"),
        help="Node.js executable to use when invoking tm.mjs (default: node).",
    )
    return parser


def dispatch(command: str, payload: Dict[str, Any], *, modules_root: Optional[str], node_bin: str) -> Dict[str, Any]:
    if command == "meta":
        return handle_meta(payload, node_bin=node_bin)
    if command == "compose":
        return handle_compose(payload, cli_override=modules_root, node_bin=node_bin)
    if command == "gates":
        return handle_gates(payload, cli_override=modules_root, node_bin=node_bin)
    raise TmCliError("E_INPUT", f"Unsupported command: {command}.")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    payload = read_json_from_stdin()
    indent = 2 if args.pretty else None
    try:
        result = dispatch(
            args.command,
            payload,
            modules_root=args.modules_root,
            node_bin=args.node_bin,
        )
    except TmCliError as err:
        output = {"error": {"code": err.code, "message": err.message}}
        if err.data is not None:
            output["error"]["data"] = err.data
        json.dump(output, sys.stdout, indent=indent)
        sys.stdout.write("\n")
        sys.stdout.flush()
        return err.exit_code
    json.dump(result, sys.stdout, indent=indent)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
