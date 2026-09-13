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
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})

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
        """Build '~owner/project/+git/repository' from config."""
        missing = [k for k in ("namespace", "project", "repository") if not repo_cfg.get(k)]
        if missing:
            raise ProviderError(f"config is missing {', '.join(missing)}")
        ns = repo_cfg["namespace"]
        if not ns.startswith("~"):
            ns = "~" + ns
        parts = [quote(p, safe="~+") for p in (ns, repo_cfg["project"], "+git", repo_cfg["repository"])]
        return "/".join(parts)

    def repo_url(self, repo_cfg: dict) -> str:
        return repo_cfg.get("url") or f"{WEB_ROOT}/{self._path(repo_cfg)}"

    def _get(self, url: str, params=None) -> dict:
        """GET with a short timeout and retries.

        A stalled Launchpad request is abandoned rather than waited out: the
        retry almost always answers immediately. 404 and other client errors
        are raised at once, since retrying them is pointless.
        """
        last: Exception | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
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

            if attempt < MAX_ATTEMPTS:
                delay = min(2 ** (attempt - 1), 4) + random.uniform(0, 0.4)
                log.debug("retry %d/%d after %s: %s", attempt, MAX_ATTEMPTS, type(last).__name__, url)
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
        entries = self._open_merge_proposals(repo_cfg)
        if not entries:
            return []

        workers = max(1, int(self.thresholds.max_workers))
        results: list[MergeRequest] = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for mr in pool.map(self._build_safe, entries):
                if mr is not None:
                    results.append(mr)
        return results

    def _build_safe(self, entry: dict) -> MergeRequest | None:
        try:
            return self._build(entry)
        except Exception as exc:  # noqa: BLE001
            log.warning("skipping merge proposal %s: %s", entry.get("self_link"), exc)
            return None


def _short_ref(ref: str | None) -> str | None:
    """'refs/heads/ubuntu/master' -> 'ubuntu/master'."""
    if not ref:
        return None
    return ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
