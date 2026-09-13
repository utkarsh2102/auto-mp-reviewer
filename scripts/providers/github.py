"""GitHub pull-request provider - Phase 1 stub.

Deliberately unimplemented. It exists to prove the abstraction has room for a
second provider: the registry entry, the constructor signature and the return
contract are already correct, so implementing it is a matter of filling in
fetch() with calls to the GitHub REST API and mapping PR state onto the shared
status vocabulary.

Sketch of the mapping when this is built out:

    draft                       -> IN_PROGRESS
    open, no reviewers          -> NEEDS_REVIEW  (yields ATTN_NO_REVIEWER)
    open, approved review       -> APPROVED
    open, mergeable_state dirty -> CONFLICT

GitHub's API *does* send CORS headers, but this dashboard still fetches it
server-side so that rate limits and tokens stay out of the browser, and so that
every provider lands in the same cached JSON file.
"""

from __future__ import annotations

from .base import MergeRequest, Provider


class GitHubProvider(Provider):
    name = "github"

    def repo_url(self, repo_cfg: dict) -> str:
        return repo_cfg.get("url") or (
            f"https://github.com/{repo_cfg.get('namespace')}/{repo_cfg.get('repository')}"
        )

    def fetch(self, repo_cfg: dict) -> list[MergeRequest]:
        raise NotImplementedError(
            "The GitHub provider is a Phase 1 stub. Implement fetch() in "
            "scripts/providers/github.py before enabling a 'github' repository "
            "in config/repos.yaml."
        )
