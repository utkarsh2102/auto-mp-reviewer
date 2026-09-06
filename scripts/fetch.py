#!/usr/bin/env python3
"""Fetch open merge proposals and write the dashboard's data file.

Launchpad's API sends no Access-Control-Allow-Origin header, so the browser
cannot call it from GitHub Pages. This script runs in GitHub Actions instead and
commits its output; the static site only ever reads that cached JSON.

Failure handling is the point of the merge step: when a repository cannot be
fetched, its previously cached merge proposals are carried forward, marked with
status "error" and the timestamp of the last refresh that did succeed. One
repository going down never blanks the others.

Teams can discover their repositories at fetch time (see `teams` in
config/repos.yaml). If discovery fails, the repositories found by the last
successful run are fetched instead, so only the membership list goes stale.
A team can also list its people's open MPs wherever they are; those are fetched
after the repositories, so an MP a tracked repository shows is not fetched twice.

Usage:
    python scripts/fetch.py
    python scripts/fetch.py --repo ubuntu-cdimage --dry-run
    python scripts/fetch.py --team foundations --dry-run
    python scripts/fetch.py --no-bugs
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers import Thresholds, apply_rules, get_provider  # noqa: E402
from providers.base import RepoResult, slugify  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "repos.yaml"
DEFAULT_OUT = ROOT / "docs" / "data" / "dashboard.json"
SCHEMA_VERSION = 2

# Used when config/repos.yaml defines no teams, so older configs still run.
DEFAULT_TEAM = {"id": "repositories", "name": "Repositories"}

log = logging.getLogger("fetch")


class ConfigError(ValueError):
    """config/repos.yaml is inconsistent; the run stops before fetching."""


def load_previous(path: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """Previously cached (repo entries, team entries), each keyed by id.
    Missing/corrupt -> empty."""
    if not path.exists():
        return {}, {}
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("could not read previous data (%s); starting fresh", exc)
        return {}, {}
    repos = {r["id"]: r for r in data.get("repositories", []) if "id" in r}
    teams = {t["id"]: t for t in data.get("teams", []) if "id" in t}
    return repos, teams


def load_teams(config: dict) -> list[dict]:
    teams = config.get("teams") or [dict(DEFAULT_TEAM)]
    ids = [t.get("id") for t in teams]
    if not all(ids):
        raise ConfigError("every team needs an id")
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise ConfigError(f"duplicate team id(s): {', '.join(dupes)}")
    return teams


def resolve_repositories(
    config: dict,
    teams: list[dict],
    thresholds: Thresholds,
    previous: dict[str, dict],
    discover_teams: set[str] | None = None,
) -> tuple[list[dict], dict[str, str]]:
    """Every repository to fetch: the listed ones plus each team's discovered
    ones, all stamped with their team. Returns (repo configs, {team id: error}).

    `discover_teams` limits discovery to those teams (None = all of them).
    """
    team_ids = [t["id"] for t in teams]
    repos: list[dict] = []
    for cfg in config.get("repositories") or []:
        cfg = dict(cfg)
        if not config.get("teams"):
            cfg.setdefault("team", DEFAULT_TEAM["id"])
        if cfg.get("team") not in team_ids:
            raise ConfigError(
                f"repository {cfg.get('id')!r} has unknown team {cfg.get('team')!r}"
                f" (known: {', '.join(team_ids)})"
            )
        repos.append(cfg)

    errors: dict[str, str] = {}
    for team in teams:
        spec = team.get("discover")
        if not spec or (discover_teams is not None and team["id"] not in discover_teams):
            continue
        try:
            found = get_provider(spec.get("provider", ""), thresholds).discover(spec)
            log.info("%s: discovered %d repositories", team["id"], len(found))
        except Exception as exc:  # noqa: BLE001
            # Keep refreshing what the last good run found; only membership goes stale.
            found = [
                p["discovered_config"]
                for p in previous.values()
                if p.get("team") == team["id"] and p.get("discovered_config")
            ]
            errors[team["id"]] = (
                f"Could not refresh the repository list ({exc}). "
                f"Tracking the {len(found)} repositories found by the last successful refresh."
            )
            log.error("%s: discovery failed, reusing %d known repositories: %s", team["id"], len(found), exc)
        for found_cfg in found:
            repos.append({
                **found_cfg,
                "id": f"{team['id']}-{slugify(found_cfg['name'])}",
                "team": team["id"],
                "provider": spec.get("provider", ""),
                "_discovered": found_cfg,
            })

    ids = [r.get("id") for r in repos]
    if not all(ids):
        raise ConfigError("every repository needs an id")
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise ConfigError(f"duplicate repository id(s): {', '.join(dupes)}")
    return repos, errors


def fetch_people(
    spec: dict, thresholds: Thresholds, now: datetime, tracked: frozenset[str], previous: dict | None
) -> dict:
    """A team's `people` block: its members, plus every open MP they proposed
    that no tracked repository already shows (the UI merges the two).

    Failures degrade like repositories do: a member whose MPs cannot be listed
    keeps the ones from the last run, and the block records the error.
    """
    previous = previous or {}
    block = {
        "source": spec.get("members_of"),
        "members": previous.get("members", []),
        "merge_requests": previous.get("merge_requests", []),
        "error": None,
        "last_successful_refresh": previous.get("last_successful_refresh"),
    }
    try:
        provider = get_provider(spec.get("provider", ""), thresholds)
        members = provider.members(spec)
    except Exception as exc:  # noqa: BLE001
        log.error("people %s: %s", spec.get("members_of"), exc)
        block["error"] = f"Could not refresh the member list ({exc}). Showing the previous data."
        return block

    started = time.monotonic()
    earlier: dict[str, list[dict]] = {}
    for mp in previous.get("merge_requests", []):
        if mp.get("url") not in tracked:
            earlier.setdefault(mp.get("author", {}).get("name"), []).append(mp)
    mrs: list[dict] = []
    failed: list[str] = []
    for person in members:
        try:
            found = provider.merge_requests_by(person.name, skip=tracked)
        except Exception as exc:  # noqa: BLE001
            log.error("people: ~%s: %s", person.name, exc)
            failed.append(person.name)
            mrs.extend(earlier.get(person.name, []))
            continue
        for mr in found:
            apply_rules(mr, thresholds, now)
        mrs.extend(mr.to_dict() for mr in found)
    mrs.sort(key=lambda m: m.get("inactive_days", 0), reverse=True)
    log.info("people %s: %d members, %d MPs outside tracked repos in %.1fs",
             spec.get("members_of"), len(members), len(mrs), time.monotonic() - started)

    block.update(
        members=[asdict(m) for m in members],
        merge_requests=mrs,
        last_successful_refresh=now.isoformat(),
        error=(f"Could not refresh the merge proposals of {', '.join('~' + n for n in failed)}. "
               "Showing their previous data.") if failed else None,
    )
    return block


def fetch_repo(repo_cfg: dict, thresholds: Thresholds, now: datetime) -> RepoResult:
    """Fetch one repository. Raises nothing - failure is returned as data."""
    repo_id = repo_cfg.get("id") or repo_cfg.get("repository") or "unknown"
    name = repo_cfg.get("name") or repo_id
    provider_name = repo_cfg.get("provider", "")
    team = repo_cfg.get("team")

    try:
        provider = get_provider(provider_name, thresholds)
        url = provider.repo_url(repo_cfg)
    except Exception as exc:  # noqa: BLE001
        log.error("%s: %s", repo_id, exc)
        return RepoResult(id=repo_id, name=name, provider=provider_name, url="", team=team,
                          status="error", error=str(exc))

    started = time.monotonic()
    try:
        mrs = provider.fetch(repo_cfg)
    except Exception as exc:  # noqa: BLE001
        log.error("%s: fetch failed: %s", repo_id, exc)
        return RepoResult(id=repo_id, name=name, provider=provider_name, url=url, team=team,
                          status="error", error=str(exc))

    for mr in mrs:
        apply_rules(mr, thresholds, now)
    mrs.sort(key=lambda m: m.inactive_days, reverse=True)

    log.info("%s: %d open MPs in %.1fs", repo_id, len(mrs), time.monotonic() - started)
    return RepoResult(
        id=repo_id,
        name=name,
        provider=provider_name,
        url=url,
        team=team,
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
    ap.add_argument("--team", action="append", help="only this team's repos (repeatable)")
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

    now = datetime.now(timezone.utc)
    previous, previous_teams = load_previous(args.out)

    try:
        teams = load_teams(config)
        team_ids = [t["id"] for t in teams]
        if args.team and set(args.team) - set(team_ids):
            raise ConfigError(f"no such team(s) in config: {', '.join(sorted(set(args.team) - set(team_ids)))}")
        repos, discovery_errors = resolve_repositories(
            config, teams, thresholds, previous, set(args.team) if args.team else None
        )
    except ConfigError as exc:
        log.error("%s", exc)
        return 2

    team_of = {r["id"]: r["team"] for r in repos}
    if args.team:
        repos = [r for r in repos if r["team"] in set(args.team)]
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

    payloads = []
    for repo_cfg in repos:
        result = fetch_repo(repo_cfg, thresholds, now)
        payload = carry_forward(result, previous.get(result.id))
        if repo_cfg.get("_discovered"):
            # Lets a later run whose discovery fails keep refreshing this repo.
            payload["discovered_config"] = repo_cfg["_discovered"]
        payloads.append(payload)

    # A --repo/--team run must not delete the repos it did not look at.
    kept = [p for p in previous.values() if p["id"] not in {p2["id"] for p2 in payloads}]
    if kept and (args.repo or args.team):
        log.info("keeping cached data for %d untouched repo(s)", len(kept))
        for p in kept:
            p["team"] = team_of.get(p["id"], p.get("team"))
        payloads.extend(kept)

    # Group by team in config order, so the data file reads like the dashboard.
    order = {t: i for i, t in enumerate(team_ids)}
    payloads.sort(key=lambda p: order.get(p.get("team"), len(order)))

    discovered_now = {t["id"] for t in teams if t.get("discover")
                      and (not args.team or t["id"] in args.team)}
    team_entries = [
        {
            "id": t["id"],
            "name": t.get("name") or t["id"],
            "description": t.get("description"),
            # A team whose discovery was skipped this run keeps its last known error.
            "error": discovery_errors.get(t["id"]) if t["id"] in discovered_now
            else (previous_teams.get(t["id"]) or {}).get("error"),
        }
        for t in teams
    ]

    tracked = frozenset(m["url"] for p in payloads for m in p["merge_requests"])
    for entry, t in zip(team_entries, teams):
        if not t.get("people"):
            continue
        earlier = (previous_teams.get(t["id"]) or {}).get("people")
        if args.repo or (args.team and t["id"] not in args.team):
            entry["people"] = earlier  # not part of this run
        else:
            entry["people"] = fetch_people(t["people"], thresholds, now, tracked, earlier)

    document = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now.isoformat(),
        "config": {
            "stale_after_days": thresholds.stale_after_days,
            "silent_after_days": thresholds.silent_after_days,
            "refresh_interval_minutes": thresholds.refresh_interval_minutes,
        },
        "teams": team_entries,
        "repositories": payloads,
    }

    total = sum(len(p["merge_requests"]) for p in payloads)
    stale = sum(1 for p in payloads for m in p["merge_requests"] if m.get("is_stale"))
    attn = sum(1 for p in payloads for m in p["merge_requests"] if m.get("attention"))
    failed = [p["id"] for p in payloads if p["status"] == "error"]

    print(f"\n{total} open MPs across {len(payloads)} repos in {len(teams)} team{'s' * (len(teams) != 1)}"
          f" - {stale} stale, {attn} needing attention")
    for t in team_entries:
        members = [p for p in payloads if p.get("team") == t["id"]]
        print(f"\n  {t['name']}: {len(members)} repos,"
              f" {sum(len(p['merge_requests']) for p in members)} MPs")
        if t["error"]:
            print(f"    DISCOVERY FAILED: {t['error']}")
        if t.get("people"):
            pp = t["people"]
            print(f"    people {pp['source']}: {len(pp['members'])} members,"
                  f" {len(pp['merge_requests'])} MPs outside tracked repos")
            if pp["error"]:
                print(f"    PEOPLE FAILED: {pp['error']}")
        quiet = 0
        for p in members:
            if p["status"] == "ok" and not p["merge_requests"]:
                quiet += 1
                continue
            flag = "ERROR" if p["status"] == "error" else "ok"
            print(f"    {p['id']:<32} {len(p['merge_requests']):>3} MPs  [{flag}]")
        if quiet:
            print(f"    + {quiet} repo(s) with no open MPs")
    if failed:
        print(f"\n  failed: {', '.join(failed)} (serving cached data)")

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
