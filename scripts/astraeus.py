#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["jsonschema>=4.23,<5"]
# ///
"""Read-only Pi Astraeus policy, source target, and result validation bridge.

No inference, auth, telemetry scraping, or independent session management.
"""
from __future__ import annotations

import argparse
import hashlib
import fnmatch
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

PLUGIN = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "schema_version": 1,
    "allowed_models": ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"],
    "require_review_globs": [],
    "assurance": "reported",
}


def parse_json(content):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(content, object_pairs_hook=unique)


def read_json(path):
    return parse_json(Path(path).read_bytes())


def run(args, *, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError(f"command failed ({result.returncode}): {args!r}\n{result.stderr.strip()}")
    return result.stdout


def policy(path=None):
    data = {} if path is None else tomllib.loads(Path(path).read_text())
    if "review_limit" in data:
        raise ValueError("review_limit has been retired; remove it from astraeus.toml (reviews have no fixed count limit)")
    unknown = data.keys() - DEFAULTS.keys()
    if unknown:
        raise ValueError(f"unknown policy keys: {sorted(unknown)}")
    result = DEFAULTS | data
    if type(result["schema_version"]) is not int or result["schema_version"] != 1:
        raise ValueError("schema_version must be 1")
    if result["assurance"] not in ("reported", "strict"):
        raise ValueError("assurance must be reported or strict")
    for key in ("allowed_models", "require_review_globs"):
        values = result[key]
        if not isinstance(values, list) or any(not isinstance(x, str) or not x.strip() for x in values):
            raise ValueError(f"{key} must be a list of nonempty strings")
        if len(set(values)) != len(values):
            raise ValueError(f"{key} contains duplicates")
    if not result["allowed_models"]:
        raise ValueError("allowed_models must not be empty")
    return result


def validate_receipt(receipt, assurance, option="--receipt"):
    if receipt:
        r = read_json(receipt)
        if not isinstance(r, dict) or set(r) != {"requested", "observed", "source"}:
            raise ValueError(f"{option} requires requested, observed, source")
        requested, observed = r["requested"], r["observed"]
        if not isinstance(requested, dict) or set(requested) != {"model", "effort"}:
            raise ValueError(f"{option} requested must contain model and effort")
        if not isinstance(observed, dict) or set(observed) != {"model", "effort", "sandbox"}:
            raise ValueError(f"{option} observed must contain model, effort, sandbox")
        if any(not isinstance(v, str) or not v.strip() for v in requested.values()):
            raise ValueError(f"{option} requested model/effort must be nonempty strings")
        if any(v is not None and (not isinstance(v, str) or not v.strip()) for v in observed.values()):
            raise ValueError(f"{option} observed fields must be nonempty strings or null")
        if not isinstance(r["source"], str) or not r["source"].strip():
            raise ValueError(f"{option} needs a host evidence source")
        for key in ("model", "effort"):
            if observed[key] is not None and observed[key] != requested[key]:
                raise ValueError(f"{option} host-observed {key} differs from request")
        if assurance == "strict" and (
            any(observed[k] is None for k in ("model", "effort"))
            or observed["sandbox"] != "read-only"
        ):
            raise ValueError(f"strict assurance needs observed model/effort and read-only sandbox in {option}")
    elif assurance == "strict":
        raise ValueError(f"strict assurance requires {option} with host evidence")


def load_result(path, kind, task_id, target_id, content=None):
    try:
        from jsonschema import Draft202012Validator, FormatChecker
    except ImportError as exc:
        raise ValueError("jsonschema is required; run this script with uv run or install jsonschema") from exc
    data = read_json(path) if content is None else parse_json(content)
    schema = read_json(PLUGIN / "schemas" / f"{kind}.json")
    Draft202012Validator.check_schema(schema)
    errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(data))
    if errors:
        raise ValueError("invalid contract: " + "; ".join(e.message for e in errors[:5]))
    if data["task_id"] != task_id or data["target_id"] != target_id:
        raise ValueError("task or target mismatch: result is not for the expected current work")
    if kind == "review":
        blocking = data["violations"] or data["bugs"]
        if data["verdict"] == "pass" and (
            data["status"] != "complete" or blocking or data["unresolved"]
            or not data["evidence"] or not data["checked_scope"]
        ):
            raise ValueError("pass requires complete status, evidence, coverage, and no blocking/unresolved issues")
        if data["verdict"] == "changes_required" and not blocking:
            raise ValueError("changes_required needs a concrete violation or bug")
    return data


def validate_adjudication(data, source):
    expected_refs = [
        f"{field}/{index}"
        for field in ("violations", "bugs", "suggestions", "unresolved")
        for index in range(len(source[field]))
    ]
    actual_refs = [decision["ref"] for decision in data["decisions"]]
    duplicates = sorted({ref for ref in actual_refs if actual_refs.count(ref) > 1})
    if duplicates:
        raise ValueError(f"duplicate source finding dispositions: {duplicates}")
    missing = sorted(set(expected_refs) - set(actual_refs))
    unknown = sorted(set(actual_refs) - set(expected_refs))
    if missing or unknown:
        raise ValueError(f"source finding dispositions mismatch; missing={missing}, unknown={unknown}")

    actions = [decision["action"] for decision in data["decisions"]]
    source_incomplete = (
        source["status"] != "complete"
        or source["verdict"] == "inconclusive"
        or bool(source["unresolved"])
        or not source["evidence"]
        or not source["checked_scope"]
    )
    adjudication_incomplete = (
        data["status"] != "complete"
        or bool(data["unresolved"])
        or not data["evidence"]
        or not data["checked_scope"]
    )
    pending = source_incomplete or adjudication_incomplete or any(
        action in ("investigate", "human_decision") for action in actions
    )

    if pending and data["verdict"] != "inconclusive":
        raise ValueError("pending or incomplete adjudication requires an inconclusive verdict")
    if data["verdict"] == "accept" and any(action != "reject" for action in actions):
        raise ValueError("accept requires every source finding to be rejected with justification")
    if data["verdict"] == "changes_required" and "fix" not in actions:
        raise ValueError("changes_required requires at least one fix decision")


def validate_result(path, kind, task_id, target_id, accept=False, assurance="reported", receipt=None,
                    review_result=None, review_receipt=None):
    if accept and kind not in ("review", "adjudication"):
        raise ValueError("--accept is only for review or adjudication")
    if kind != "adjudication" and (review_result is not None or review_receipt is not None):
        raise ValueError("--review-result and --review-receipt are only for adjudication")
    if kind == "adjudication" and review_result is None:
        raise ValueError("adjudication requires --review-result")

    data = load_result(path, kind, task_id, target_id)
    if kind == "adjudication":
        source_bytes = Path(review_result).read_bytes()
        source = load_result(review_result, "review", task_id, target_id, source_bytes)
        expected_hash = "sha256:" + hashlib.sha256(source_bytes).hexdigest()
        if data["review_sha256"] != expected_hash:
            raise ValueError("review hash mismatch: adjudication is not bound to the supplied review bytes")
        validate_adjudication(data, source)

    if accept:
        if kind == "review" and data["verdict"] != "pass":
            raise ValueError("review does not pass; changes_required needs adjudication, inconclusive needs evidence")
        if kind == "adjudication" and data["verdict"] != "accept":
            raise ValueError("adjudication does not accept; do not accept")
    validate_receipt(receipt, assurance)
    if kind == "adjudication":
        validate_receipt(review_receipt, assurance, "--review-receipt")
    return {"valid": True, "acceptance_checks_passed": bool(accept), "result": data}


def target_id(repo):
    repo = Path(repo).resolve()
    actual = Path(run(["git", "rev-parse", "--show-toplevel"], cwd=repo).strip()).resolve()
    if actual != repo:
        raise ValueError("--repo must identify the Git repository root")
    def git(*args, optional=False):
        p = subprocess.run(["git", *args], cwd=repo, capture_output=True)
        if p.returncode and not optional:
            raise ValueError(p.stderr.decode(errors="replace"))
        return p.stdout if p.returncode == 0 else b"unborn"
    digest = hashlib.sha256()
    def add(label, value):
        digest.update(label + b"\0" + str(len(value)).encode() + b"\0" + value)
    add(b"head", git("rev-parse", "--verify", "HEAD", optional=True))
    for label, args in ((b"index", ["--cached"]), (b"worktree", [])):
        add(label, git("diff", "--binary", "--no-ext-diff", "--no-textconv", *args))
    for raw in sorted(filter(None, git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0"))):
        path = repo / os.fsdecode(raw)
        add(b"path", raw)
        if path.is_symlink():
            add(b"symlink", os.fsencode(os.readlink(path)))
        else:
            add(b"mode", str(path.stat().st_mode & 0o777).encode())
            add(b"file", path.read_bytes())
    return "sha256:" + digest.hexdigest()



def repository_root(repo):
    repo = Path(repo).resolve()
    actual = Path(run(["git", "rev-parse", "--show-toplevel"], cwd=repo).strip()).resolve()
    if actual != repo:
        raise ValueError("--repo must identify the Git repository root")
    return repo


def project_policy(repo):
    """Only the explicitly supplied root's astraeus.toml; no parent discovery."""
    repo = repository_root(repo)
    config = repo / "astraeus.toml"
    return policy(config if config.is_file() else None)


def changed_paths(repo):
    repo = repository_root(repo)
    paths = set()
    for args in (("diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z"),
                 ("diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z"),
                 ("ls-files", "--others", "--exclude-standard", "-z")):
        paths.update(os.fsdecode(path) for path in
                     subprocess_run_bytes(["git", *args], repo).split(b"\0") if path)
    return sorted(paths)


def subprocess_run_bytes(args, cwd):
    result = subprocess.run(args, cwd=cwd, capture_output=True, check=False)
    if result.returncode:
        raise ValueError(f"command failed ({result.returncode}): {args!r}\n"
                         + result.stderr.decode(errors="replace").strip())
    return result.stdout


def matches_review(repo):
    config = project_policy(repo)
    changed = changed_paths(repo)
    matched = [path for path in changed if any(
        fnmatch.fnmatchcase(path, pattern) for pattern in config["require_review_globs"])]
    return {"requires_review": bool(matched), "paths": matched, "changed_paths": changed}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("doctor", help="Read-only local policy diagnostics; no model calls")
    doctor.add_argument("--config", type=Path)
    for command in ("target", "policy", "matches-review"):
        bridge = sub.add_parser(command)
        bridge.add_argument("--repo", type=Path, default=Path.cwd())
    val = sub.add_parser("validate-result")
    val.add_argument("result", type=Path)
    val.add_argument("--kind", choices=["exploration", "research", "implementation", "review", "adjudication"], required=True)
    val.add_argument("--task-id", required=True)
    val.add_argument("--target-id", required=True)
    val.add_argument("--accept", action="store_true")
    val.add_argument("--assurance", choices=["reported", "strict"], default="reported")
    val.add_argument("--receipt", type=Path)
    val.add_argument("--review-result", type=Path)
    val.add_argument("--review-receipt", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "doctor":
            result = {"policy": policy(args.config), "plugin_path": str(PLUGIN),
                      "runtime_model": "unknown", "runtime_effort": "unknown",
                      "note": "Python diagnostics do not prove Pi model availability, sandbox enforcement, or extension loading."}
        elif args.command == "target":
            print(target_id(args.repo))
            return 0
        elif args.command == "policy":
            result = project_policy(args.repo)
        elif args.command == "matches-review":
            result = matches_review(args.repo)
        else:
            result = validate_result(args.result, args.kind, args.task_id, args.target_id, args.accept,
                                     args.assurance, args.receipt, args.review_result, args.review_receipt)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"astraeus: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
