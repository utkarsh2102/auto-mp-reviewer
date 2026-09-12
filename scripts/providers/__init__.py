"""Provider registry.

Adding a provider is: implement Provider, import it here, add one line to
PROVIDERS. Nothing in the UI or the data model changes.
"""

from __future__ import annotations

from .base import (  # noqa: F401 - re-exported for convenience
    Author,
    LinkedBug,
    MergeRequest,
    Provider,
    ProviderError,
    RepoResult,
    Reviewer,
    Thresholds,
    apply_rules,
)
from .github import GitHubProvider
from .launchpad import LaunchpadGitProvider

PROVIDERS: dict[str, type[Provider]] = {
    LaunchpadGitProvider.name: LaunchpadGitProvider,
    GitHubProvider.name: GitHubProvider,
}


def get_provider(name: str, thresholds: Thresholds) -> Provider:
    try:
        return PROVIDERS[name](thresholds)
    except KeyError:
        known = ", ".join(sorted(PROVIDERS))
        raise ProviderError(f"unknown provider {name!r} (known: {known})") from None
