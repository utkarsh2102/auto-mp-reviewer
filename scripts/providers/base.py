"""Provider-neutral data model and rules for the MP review dashboard.

Nothing in this module knows what Launchpad is. Providers translate their own
API into these dataclasses; the dashboard UI only ever reads the result. That
separation is what lets a GitHub pull-request provider drop in later without
touching the UI or the data model.

Staleness and "needs attention" are deliberately computed *here* rather than in
each provider, so every provider inherits byte-identical rules.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Shared vocabulary
# ---------------------------------------------------------------------------

# Providers map their own status strings onto these categories so that CSS
# classes, filters and rules stay provider-independent.
NEEDS_REVIEW = "needs_review"
IN_PROGRESS = "in_progress"
APPROVED = "approved"
CONFLICT = "conflict"
QUEUED = "queued"
UNKNOWN = "unknown"

STATUS_CATEGORIES = (NEEDS_REVIEW, IN_PROGRESS, APPROVED, CONFLICT, QUEUED, UNKNOWN)

# Attention reason codes. Labels live in docs/assets/app.js.
ATTN_NO_REVIEWER = "no_reviewer"
ATTN_APPROVED_NOT_LANDED = "approved_not_landed"
ATTN_SILENT = "silent"
ATTN_MERGE_CONFLICT = "merge_conflict"
ATTN_LINKED_BUG = "linked_bug"


@dataclass
class Thresholds:
    """Tunables from config/repos.yaml, passed down to the rules."""

    stale_after_days: int = 30
    silent_after_days: int = 7
    refresh_interval_minutes: int = 120
    fetch_linked_bugs: bool = True
    max_workers: int = 8

    @classmethod
    def from_config(cls, defaults: dict) -> "Thresholds":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in (defaults or {}).items() if k in known})


# ---------------------------------------------------------------------------
# Normalised entities
# ---------------------------------------------------------------------------


@dataclass
class Author:
    name: str
    display_name: str
    url: str | None = None


@dataclass
class Reviewer:
    name: str
    display_name: str
    url: str | None = None
    pending: bool = True
    vote: str | None = None


@dataclass
class LinkedBug:
    id: str
    title: str
    url: str
    status: str | None = None
    importance: str | None = None


@dataclass
class MergeRequest:
    """One open merge proposal / pull request, provider-neutral."""

    id: str
    title: str
    url: str
    author: Author
    status: str  # provider's own wording, for display
    status_category: str  # one of STATUS_CATEGORIES
    created_at: str  # ISO-8601 UTC
    updated_at: str | None = None
    source_branch: str | None = None
    target_branch: str | None = None
    reviewers: list[Reviewer] = field(default_factory=list)
    comment_count: int = 0
    last_comment_at: str | None = None
    linked_bugs: list[LinkedBug] = field(default_factory=list)

    # Captured now, unused in Phase 1: gives a future LLM review harness the
    # diff without having to re-crawl the provider.
    diff_url: str | None = None

    # Reserved for Phase 2 (LLM/code-review harness). Always None in Phase 1.
    review: dict | None = None

    # Derived by apply_rules().
    age_days: int = 0
    inactive_days: int = 0
    is_stale: bool = False
    attention: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RepoResult:
    """Per-repository outcome. A failure here never aborts the other repos."""

    id: str
    name: str
    provider: str
    url: str
    status: str = "ok"  # "ok" | "error"
    error: str | None = None
    last_successful_refresh: str | None = None
    merge_requests: list[MergeRequest] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["merge_requests"] = [mr.to_dict() for mr in self.merge_requests]
        return d


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def parse_dt(value: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp into an aware UTC datetime."""
    if not value:
        return None
    try:
        # Launchpad emits '+00:00'; tolerate a trailing 'Z' too.
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def newest(*values: str | None) -> str | None:
    """Return the latest of several ISO timestamps, ignoring unparseable ones."""
    parsed = [d for d in (parse_dt(v) for v in values) if d]
    return iso(max(parsed)) if parsed else None


def _days_since(value: str | None, now: datetime) -> int:
    dt = parse_dt(value)
    if not dt:
        return 0
    return max(0, (now - dt).days)


def apply_rules(mr: MergeRequest, t: Thresholds, now: datetime | None = None) -> MergeRequest:
    """Fill in age, inactivity, staleness and attention reasons.

    Stale is measured from last *activity*, not creation: a six-month-old MP
    reviewed yesterday is not neglected, and a week-old MP nobody touched is
    on its way to being.
    """
    now = now or datetime.now(timezone.utc)

    mr.age_days = _days_since(mr.created_at, now)
    # Fall back to creation when a provider gives us no activity signal at all.
    mr.inactive_days = _days_since(mr.updated_at or mr.created_at, now)
    mr.is_stale = mr.inactive_days >= t.stale_after_days

    reasons: list[str] = []

    if mr.status_category == NEEDS_REVIEW and not mr.reviewers:
        reasons.append(ATTN_NO_REVIEWER)

    if mr.status_category == APPROVED:
        reasons.append(ATTN_APPROVED_NOT_LANDED)

    if mr.status_category == NEEDS_REVIEW:
        # No comments at all? Measure silence from when it was opened.
        silent_since = mr.last_comment_at or mr.created_at
        if _days_since(silent_since, now) >= t.silent_after_days:
            reasons.append(ATTN_SILENT)

    if mr.status_category == CONFLICT:
        reasons.append(ATTN_MERGE_CONFLICT)

    if mr.linked_bugs:
        reasons.append(ATTN_LINKED_BUG)

    mr.attention = reasons
    return mr


# ---------------------------------------------------------------------------
# Provider contract
# ---------------------------------------------------------------------------


class ProviderError(RuntimeError):
    """Raised by a provider when a repository cannot be fetched at all."""


class Provider(ABC):
    """Fetches open merge requests for one repository.

    Implementations return raw-but-normalised MergeRequest objects; the caller
    applies the shared rules. Providers must raise ProviderError for a
    whole-repository failure, and degrade silently for per-MP detail they
    cannot retrieve.
    """

    name: str = "base"

    def __init__(self, thresholds: Thresholds):
        self.thresholds = thresholds

    @abstractmethod
    def fetch(self, repo_cfg: dict) -> list[MergeRequest]:
        """Return every OPEN merge request targeting the configured repo."""

    @abstractmethod
    def repo_url(self, repo_cfg: dict) -> str:
        """Human-facing URL for the repository itself."""


def slugify(value: str) -> str:
    """Stable id for use in DOM ids and anchors."""
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
