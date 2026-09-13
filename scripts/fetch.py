#!/usr/bin/env python3
"""Fetch open merge proposals and write the dashboard's data file.

Launchpad's API sends no Access-Control-Allow-Origin header, so the browser
cannot call it from GitHub Pages. This script runs in GitHub Actions instead and
commits its output; the static site only ever reads that cached JSON.

Failure handling is the point of the merge step: when a repository cannot be
fetched, its previously cached merge proposals are carried forward, marked with
status "error" and the timestamp of the last refresh that did succeed. One
repository going down never blanks the others.

Usage:
    python scripts/fetch.py
    python scripts/fetch.py --repo ubuntu-cdimage --dry-run
    python scripts/fetch.py --no-bugs
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers import Thresholds, apply_rules, get_provider  # noqa: E402
from providers.base import RepoResult  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "repos.yaml"
DEFAULT_OUT = ROOT / "docs" / "data" / "dashboard.json"
SCHEMA_VERSION = 1

log = logging.getLogger("fetch")


def load_previous(path: Path) -> dict[str, dict]:
    """Previously cached repo entries, keyed by id. Missing/corrupt -> empty."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("could not read previous data (%s); starting fresh", exc)
        return {}
    return {r["id"]: r for r in data.get("repositories", []) if "id" in r}


def fetch_repo(repo_cfg: dict, thresholds: Thresholds, now: datetime) -> RepoResult:
    """Fetch one repository. Raises nothing - failure is returned as data."""
    repo_id = repo_cfg.get("id") or repo_cfg.get("repository") or "unknown"
    name = repo_cfg.get("name") or repo_id
    provider_name = repo_cfg.get("provider", "")

    try:
        provider = get_provider(provider_name, thresholds)
        url = provider.repo_url(repo_cfg)
    except Exception as exc:  # noqa: BLE001
        log.error("%s: %s", repo_id, exc)
        return RepoResult(id=repo_id, name=name, provider=provider_name, url="", status="error", error=str(exc))

    started = time.monotonic()
    try:
        mrs = provider.fetch(repo_cfg)
    except Exception as exc:  # noqa: BLE001
        log.error("%s: fetch failed: %s", repo_id, exc)
        return RepoResult(id=repo_id, name=name, provider=provider_name, url=url, status="error", error=str(exc))

    for mr in mrs:
        apply_rules(mr, thresholds, now)
    mrs.sort(key=lambda m: m.inactive_days, reverse=True)

    log.info("%s: %d open MPs in %.1fs", repo_id, len(mrs), time.monotonic() - started)
    return RepoResult(
        id=repo_id,
        name=name,
        provider=provider_name,
        url=url,
        status="ok",
        last_successful_refresh=now.isoformat(),
        merge_requests=mrs,
    )


def carry_forward(result: RepoResult, previous: dict | None) -> dict:
    """Merge a failed fetch with its last known-good data."""
    payload = result.to_dict()
    if result.status == "ok" or not previous:
        return payload
    payload["merge_requests"] = previous.get("merge_requests", [])
    payload["last_successful_refresh"] = previous.get("last_successful_refresh")
    payload["url"] = payload["url"] or previous.get("url", "")
    log.warning(
        "%s: serving %d cached MPs from %s",
        result.id,
        len(payload["merge_requests"]),
        payload["last_successful_refresh"] or "an unknown time",
    )
    return payload


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--repo", action="append", help="only this repo id (repeatable)")
    ap.add_argument("--no-bugs", action="store_true", help="skip the slow linked-bug lookups")
    ap.add_argument("--dry-run", action="store_true", help="print a summary, write nothing")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)-7s %(message)s",
    )

    try:
        config = yaml.safe_load(args.config.read_text()) or {}
    except (OSError, yaml.YAMLError) as exc:
        log.error("cannot read config %s: %s", args.config, exc)
        return 2

    thresholds = Thresholds.from_config(config.get("defaults", {}))
    if args.no_bugs:
        thresholds.fetch_linked_bugs = False

    repos = config.get("repositories") or []
    if args.repo:
        wanted = set(args.repo)
        repos = [r for r in repos if r.get("id") in wanted]
        missing = wanted - {r.get("id") for r in repos}
        if missing:
            log.error("no such repo(s) in config: %s", ", ".join(sorted(missing)))
            return 2
    if not repos:
        log.error("no repositories configured")
        return 2

    now = datetime.now(timezone.utc)
    previous = load_previous(args.out)

    payloads = []
    for repo_cfg in repos:
        result = fetch_repo(repo_cfg, thresholds, now)
        payloads.append(carry_forward(result, previous.get(result.id)))

    # A --repo run must not delete the repos it did not look at.
    kept = [p for p in previous.values() if p["id"] not in {p2["id"] for p2 in payloads}]
    if kept and args.repo:
        log.info("keeping cached data for %d untouched repo(s)", len(kept))
        payloads.extend(kept)

    document = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now.isoformat(),
        "config": {
            "stale_after_days": thresholds.stale_after_days,
            "silent_after_days": thresholds.silent_after_days,
            "refresh_interval_minutes": thresholds.refresh_interval_minutes,
        },
        "repositories": payloads,
    }

    total = sum(len(p["merge_requests"]) for p in payloads)
    stale = sum(1 for p in payloads for m in p["merge_requests"] if m.get("is_stale"))
    attn = sum(1 for p in payloads for m in p["merge_requests"] if m.get("attention"))
    failed = [p["id"] for p in payloads if p["status"] == "error"]

    print(f"\n{total} open MPs across {len(payloads)} repos - {stale} stale, {attn} needing attention")
    for p in payloads:
        flag = "ERROR" if p["status"] == "error" else "ok"
        print(f"  {p['id']:<20} {len(p['merge_requests']):>3} MPs  [{flag}]")
    if failed:
        print(f"  failed: {', '.join(failed)} (serving cached data)")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=2, sort_keys=False) + "\n")
    try:
        shown = args.out.relative_to(ROOT)
    except ValueError:
        shown = args.out  # --out may point outside the project
    print(f"\nwrote {shown}")

    # Exit 0 even when a repo failed: that state is data the dashboard renders,
    # not a broken build. Only a total wipe-out is worth failing the job for.
    return 1 if failed and len(failed) == len(payloads) and total == 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
