"""Launchpad git repository provider.

Every endpoint and field name below was verified against the live
api.launchpad.net during design. Notes on the non-obvious choices:

* We list open MPs with ``getMergeProposals`` and an explicit list of the five
  open statuses. The ``landing_candidates`` collection returns a byte-identical
  set (verified on both configured repos), but it has pathological cold-cache
  latency on Launchpad -- measured at 120s and 270s for a 7-entry response,
  against 0.2-2s for getMergeProposals. Listing the statuses explicitly is also
  self-documenting: "open" is defined in OPEN_STATUSES, not implied by an
  endpoint's behaviour.

* Linked bugs come from the ``getRelatedBugTasks`` named operation. The more
  obvious ``{mp}/bugs`` collection returns HTTP 401 for anonymous callers.

* A merge proposal has no "last modified" field. ``updated_at`` is therefore
  derived from the newest of its date fields, its newest comment and its
  newest review vote.

* Launchpad stalls sporadically. Measured repeatedly: an endpoint answering in
  0.2s will, on an arbitrary later call, hang for ~271s before responding --
  seen on the MP listing and on a votes collection within the same run. It is a
  server-side stall, not a slow endpoint, and an immediate retry returns in
  0.2s. So requests use a short read timeout and retry rather than waiting it
  out; REQUEST_TIMEOUT is deliberately far below that ~271s stall.

* Enrichment runs concurrently and every enrichment call is individually
  fault-isolated: a lookup that fails costs that one field, never the whole
  merge proposal.

* Discovery: ``{team}?ws.op=getBugSubscriberPackages`` returns exactly the
  packages on the team's +packagebugs page. Every Ubuntu source package's
  default git repository (lp:ubuntu/+source/<pkg>) is the git-ubuntu import
  at ~git-ubuntu-import/ubuntu/+source/<pkg>/+git/<pkg>, and Ubuntu MPs target
  it -- verified for all 220 ~foundations-bugs packages, none missing.
"""

from __future__ import annotations

import logging
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter

from .base import (
    APPROVED,
    CONFLICT,
    IN_PROGRESS,
    NEEDS_REVIEW,
    QUEUED,
    UNKNOWN,
    Author,
    LinkedBug,
    MergeRequest,
    Provider,
    ProviderError,
    Reviewer,
    newest,
)

log = logging.getLogger(__name__)

API_ROOT = "https://api.launchpad.net/devel"
WEB_ROOT = "https://code.launchpad.net"
USER_AGENT = "ubuntu-mp-review-dashboard/1.0 (+https://github.com/)"

# (connect, read). The read budget must stay well under Launchpad's ~271s stall
# so that we abandon a stalled request and retry instead of blocking on it.
REQUEST_TIMEOUT = (10, 25)
MAX_ATTEMPTS = 4
# Listing a team's bug subscriptions is slow on a cold cache (measured 27s,
# then 6s, then 0.2s) and Launchpad answers 503 when its own request timeout
# trips, so discovery gets more attempts; each one warms the cache further.
DISCOVERY_ATTEMPTS = 8
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})

# Owner of the git-ubuntu import repositories that source-package MPs target.
GIT_UBUNTU_OWNER = "~git-ubuntu-import"

# Launchpad BranchMergeProposalStatus -> our shared vocabulary.
STATUS_MAP = {
    "Work in progress": IN_PROGRESS,
    "Needs review": NEEDS_REVIEW,
    "Approved": APPROVED,
    "Code failed to merge": CONFLICT,
    "Queued": QUEUED,
}

# Our definition of "open": everything except Merged, Rejected and Superseded.
# Superseded MPs have been replaced by a successor and are dead, so they are
# excluded even though they are literally neither merged nor rejected.
OPEN_STATUSES = tuple(STATUS_MAP)

# 'Bug #2042955 in kdump-tools (Ubuntu): "Add dracut support"' -> the quoted part.
_BUG_TITLE_RE = re.compile(r'^Bug #\d+ in .*?: "(.*)"$', re.DOTALL)


def _session() -> requests.Session:
    """A pooled session. Retries are handled in _get, not by urllib3, so that
    timeout stalls and retryable statuses go through one visible code path."""
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0)
    s.mount("https://", adapter)
    return s


class LaunchpadGitProvider(Provider):
    name = "launchpad-git"

    def __init__(self, thresholds):
        super().__init__(thresholds)
        self.session = _session()
        self._people: dict[str, Author] = {}  # registrant_link -> Author

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _path(repo_cfg: dict) -> str:
        """Build '~owner/project/+git/repository' from config, or
        '~owner/distribution/+source/package/+git/repository' when the
        repository is attached to a distribution source package."""
        target = ("source_package",) if repo_cfg.get("source_package") else ("project",)
        missing = [k for k in ("namespace", *target, "repository") if not repo_cfg.get(k)]
        if missing:
            raise ProviderError(f"config is missing {', '.join(missing)}")
        ns = repo_cfg["namespace"]
        if not ns.startswith("~"):
            ns = "~" + ns
        if repo_cfg.get("source_package"):
            target = (repo_cfg.get("distribution") or "ubuntu", "+source", repo_cfg["source_package"])
        else:
            target = (repo_cfg["project"],)
        parts = [quote(p, safe="~+") for p in (ns, *target, "+git", repo_cfg["repository"])]
        return "/".join(parts)

    def repo_url(self, repo_cfg: dict) -> str:
        return repo_cfg.get("url") or f"{WEB_ROOT}/{self._path(repo_cfg)}"

    def _get(self, url: str, params=None, attempts: int = MAX_ATTEMPTS) -> dict:
        """GET with a short timeout and retries.

        A stalled Launchpad request is abandoned rather than waited out: the
        retry almost always answers immediately. 404 and other client errors
        are raised at once, since retrying them is pointless.
        """
        last: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                r = self.session.get(url, params=params, timeout=REQUEST_TIMEOUT)
                if r.status_code in RETRY_STATUS:
                    last = requests.HTTPError(f"HTTP {r.status_code}", response=r)
                else:
                    r.raise_for_status()
                    return r.json()
            except (requests.Timeout, requests.ConnectionError, ValueError) as exc:
                last = exc
            except requests.HTTPError:
                raise  # 404 and friends: no point retrying

            if attempt < attempts:
                delay = min(2 ** (attempt - 1), 4) + random.uniform(0, 0.4)
                log.debug("retry %d/%d after %s: %s", attempt, attempts, type(last).__name__, url)
                time.sleep(delay)

        raise last if last else RuntimeError(f"GET failed: {url}")

    def _get_quiet(self, url: str, params=None) -> dict | None:
        """A GET whose failure degrades one field instead of the whole MP."""
        try:
            return self._get(url, params)
        except Exception as exc:  # noqa: BLE001 - deliberately broad
            log.warning("optional lookup failed for %s: %s", url, exc)
            return None

    def _person(self, link: str | None) -> Author:
        """Resolve a person link to a display name, memoised for the run."""
        if not link:
            return Author(name="unknown", display_name="Unknown", url=None)
        if link in self._people:
            return self._people[link]

        name = link.rstrip("/").rsplit("/", 1)[-1].lstrip("~")
        author = Author(name=name, display_name=name, url=f"https://launchpad.net/~{name}")
        data = self._get_quiet(link)
        if data:
            author = Author(
                name=data.get("name") or name,
                display_name=data.get("display_name") or name,
                url=data.get("web_link") or author.url,
            )
        self._people[link] = author
        return author

    # -- listing ---------------------------------------------------------

    def _open_merge_proposals(self, repo_cfg: dict) -> list[dict]:
        """Every MP targeting this repo whose status counts as open."""
        url = f"{API_ROOT}/{self._path(repo_cfg)}"
        params = [("ws.op", "getMergeProposals")] + [("status", s) for s in OPEN_STATUSES]
        entries: list[dict] = []
        seen_pages = 0
        while url and seen_pages < 50:  # hard stop against a pagination loop
            try:
                page = self._get(url, params)
            except Exception as exc:  # noqa: BLE001
                if entries:
                    log.warning("pagination stopped early: %s", exc)
                    break
                raise ProviderError(f"listing merge proposals failed: {exc}") from exc
            entries.extend(page.get("entries", []))
            # next_collection_link already carries the query string.
            url, params = page.get("next_collection_link"), None
            seen_pages += 1
        return entries

    # -- discovery -------------------------------------------------------

    def _collection(self, url: str, params, what: str, attempts: int = MAX_ATTEMPTS) -> list[dict]:
        """Every entry of a collection, or ProviderError. Unlike the MP listing
        above, a failed or short page is never tolerated: a truncated list would
        silently drop packages or people from the dashboard."""
        entries: list[dict] = []
        total = None
        for _ in range(50):  # hard stop against a pagination loop
            try:
                page = self._get(url, params, attempts=attempts)
            except Exception as exc:  # noqa: BLE001
                raise ProviderError(f"listing {what} failed: {exc}") from exc
            total = page.get("total_size", total)
            entries.extend(page.get("entries", []))
            url, params = page.get("next_collection_link"), None
            if not url:
                break
        if url or (isinstance(total, int) and len(entries) != total):
            raise ProviderError(f"{what} came back incomplete ({len(entries)} of {total})")
        return entries

    @staticmethod
    def _team(spec: dict, key: str) -> str:
        team = spec.get(key)
        if not team:
            raise ProviderError(f"needs a {key} team")
        return team if team.startswith("~") else "~" + team

    def discover(self, spec: dict) -> list[dict]:
        """Every source package a team is bug-subscribed to, as git-ubuntu repos."""
        team = self._team(spec, "bug_subscriber")
        distribution = spec.get("distribution") or "ubuntu"
        # Launchpad's default batch (75): smaller pages stay under its timeout.
        entries = self._collection(
            f"{API_ROOT}/{quote(team, safe='~')}", {"ws.op": "getBugSubscriberPackages"},
            f"{team} bug subscriptions", attempts=DISCOVERY_ATTEMPTS,
        )
        names = {
            e["name"]
            for e in entries
            if e.get("name")
            and (e.get("distribution_link") or "").rstrip("/").rsplit("/", 1)[-1] == distribution
        }
        return [
            {
                "name": name,
                "namespace": GIT_UBUNTU_OWNER,
                "distribution": distribution,
                "source_package": name,
                "repository": name,
            }
            for name in sorted(names)
        ]

    # -- people ----------------------------------------------------------

    def members(self, spec: dict) -> list[Author]:
        """A team's people, including those in it through a sub-team."""
        team = self._team(spec, "members_of")
        entries = self._collection(f"{API_ROOT}/{quote(team, safe='~')}/participants", None,
                                   f"{team} members")
        people = [
            Author(name=e["name"], display_name=e.get("display_name") or e["name"],
                   url=e.get("web_link") or f"https://launchpad.net/~{e['name']}")
            for e in entries
            if e.get("name") and not e.get("is_team")
        ]
        return sorted(people, key=lambda a: a.display_name.lower())

    def merge_requests_by(self, person: str, skip: frozenset[str] = frozenset()) -> list[MergeRequest]:
        """Every open MP proposed from a person's own branches, anywhere."""
        params = [("ws.op", "getMergeProposals")] + [("status", s) for s in OPEN_STATUSES]
        entries = self._collection(f"{API_ROOT}/~{quote(person)}", params, f"~{person}'s merge proposals")
        entries = [e for e in entries if (e.get("web_link") or e.get("self_link")) not in skip]
        return self._enrich(entries, with_target=True)

    # -- enrichment ------------------------------------------------------

    def _comments(self, mp_link: str) -> tuple[int, str | None, dict[str, str]]:
        """Return (count, newest date, {author_link: vote}) for an MP."""
        data = self._get_quiet(f"{mp_link}/all_comments")
        if not data:
            return 0, None, {}
        entries = data.get("entries", [])
        latest = newest(*(c.get("date_created") for c in entries))
        votes = {
            c["author_link"]: c["vote"]
            for c in entries
            if c.get("vote") and c.get("author_link")
        }
        return data.get("total_size", len(entries)), latest, votes

    def _reviewers(self, mp_link: str, comment_votes: dict[str, str]) -> tuple[list[Reviewer], str | None]:
        data = self._get_quiet(f"{mp_link}/votes")
        if not data:
            return [], None
        entries = data.get("entries", [])
        reviewers = []
        for v in entries:
            link = v.get("reviewer_link")
            if not link:
                continue
            person = self._person(link)
            reviewers.append(
                Reviewer(
                    name=person.name,
                    display_name=person.display_name,
                    url=person.url,
                    pending=bool(v.get("is_pending", True)),
                    vote=comment_votes.get(link),
                )
            )
        return reviewers, newest(*(v.get("date_created") for v in entries))

    def _linked_bugs(self, mp_link: str) -> list[LinkedBug]:
        data = self._get_quiet(mp_link, {"ws.op": "getRelatedBugTasks"})
        if not data:
            return []
        bugs = []
        for b in data.get("entries", []):
            bug_link = b.get("bug_link") or ""
            bug_id = bug_link.rstrip("/").rsplit("/", 1)[-1]
            raw_title = b.get("title") or ""
            m = _BUG_TITLE_RE.match(raw_title)
            bugs.append(
                LinkedBug(
                    id=bug_id,
                    title=(m.group(1) if m else raw_title).strip(),
                    url=b.get("web_link") or f"https://bugs.launchpad.net/bugs/{bug_id}",
                    status=b.get("status"),
                    importance=b.get("importance"),
                )
            )
        return bugs

    def _build(self, entry: dict) -> MergeRequest:
        mp_link = entry["self_link"]
        web_link = entry.get("web_link") or mp_link
        mp_id = web_link.rstrip("/").rsplit("/", 1)[-1]

        comment_count, last_comment_at, comment_votes = self._comments(mp_link)
        reviewers, last_vote_at = self._reviewers(mp_link, comment_votes)
        bugs = self._linked_bugs(mp_link) if self.thresholds.fetch_linked_bugs else []

        status = entry.get("queue_status") or "Unknown"
        title = (
            entry.get("commit_message")
            or entry.get("description")
            or f"{_short_ref(entry.get('source_git_path')) or '?'}"
            f" \u2192 {_short_ref(entry.get('target_git_path')) or '?'}"
        )
        # Commit messages are multi-line; the table wants the summary line.
        title = title.strip().splitlines()[0].strip() if title.strip() else f"Merge proposal {mp_id}"

        return MergeRequest(
            id=mp_id,
            title=title,
            url=web_link,
            author=self._person(entry.get("registrant_link")),
            status=status,
            status_category=STATUS_MAP.get(status, UNKNOWN),
            created_at=entry["date_created"],
            updated_at=newest(
                entry.get("date_created"),
                entry.get("date_review_requested"),
                entry.get("date_reviewed"),
                last_comment_at,
                last_vote_at,
            ),
            source_branch=_short_ref(entry.get("source_git_path")),
            target_branch=_short_ref(entry.get("target_git_path")),
            reviewers=reviewers,
            comment_count=comment_count,
            last_comment_at=last_comment_at,
            linked_bugs=bugs,
            diff_url=entry.get("preview_diff_link"),
        )

    # -- entrypoint ------------------------------------------------------

    def fetch(self, repo_cfg: dict) -> list[MergeRequest]:
        return self._enrich(self._open_merge_proposals(repo_cfg))

    def _enrich(self, entries: list[dict], with_target: bool = False) -> list[MergeRequest]:
        if not entries:
            return []
        workers = max(1, int(self.thresholds.max_workers))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            built = pool.map(lambda e: self._build_safe(e, with_target), entries)
            return [mr for mr in built if mr is not None]

    def _build_safe(self, entry: dict, with_target: bool = False) -> MergeRequest | None:
        try:
            mr = self._build(entry)
        except Exception as exc:  # noqa: BLE001
            log.warning("skipping merge proposal %s: %s", entry.get("self_link"), exc)
            return None
        if with_target:
            mr.target_repository, mr.target_repository_url = _target(entry)
        return mr


def _target(entry: dict) -> tuple[str | None, str | None]:
    """(display name, web URL) of the repository or branch an MP targets.

    '~git-ubuntu-import/ubuntu/+source/apport/+git/apport' -> 'apport';
    a bzr branch '~owner/project/series' -> 'project/series'.
    """
    link = entry.get("target_git_repository_link") or entry.get("target_branch_link") or ""
    path = link[len(API_ROOT) + 1:] if link.startswith(API_ROOT + "/") else ""
    if not path:
        return None, None
    parts = path.split("/")
    name = parts[parts.index("+git") + 1] if "+git" in parts else "/".join(parts[1:])
    return name, f"{WEB_ROOT}/{path}"


def _short_ref(ref: str | None) -> str | None:
    """'refs/heads/ubuntu/master' -> 'ubuntu/master'."""
    if not ref:
        return None
    return ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
