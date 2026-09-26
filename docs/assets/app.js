/* Ubuntu MP Review Dashboard - view layer.
 *
 * This file reads only the normalised schema written by scripts/fetch.py. It
 * contains no provider-specific knowledge: nothing here knows what Launchpad
 * is, which is what lets a GitHub pull-request provider appear as just another
 * repository with no change to this file.
 *
 * Two different kinds of "old" are deliberately never called the same thing:
 *   - an MP is STALE when it has had no activity for stale_after_days;
 *   - our data file is OUT OF DATE when the Action has not refreshed recently.
 *
 * Navigation is Overview, then one tab per team, then a team's repositories.
 * Teams come from the data file (config/repos.yaml), never from this file.
 * Every view lives in the URL hash (#overview, #team/<id>, #repo/<id>), so each
 * has a shareable link and the page works under any sub-path.
 */

import {
  REVIEWERS, activeConfig, forgetKeys, getKey, getReviewer, loadSettings, saveSettings,
} from "./review.js";

const DATA_URL = "data/dashboard.json";

// However rarely the fetcher runs, an open tab re-reads the published file at
// least this often, so it picks up a new refresh within the hour.
const MAX_POLL_MINUTES = 60;

const SEARCH_LIMIT = 12;

const state = {
  doc: null,
  teams: [],              // [{ id, name, description, error, repos: [...] }]
  repoById: new Map(),
  teamOfRepo: new Map(),  // repoId -> team
  route: { view: "overview" },
  filters: {},            // repoId -> { q, statuses:Set, flags:Set }
  sort: {},               // repoId -> { key, dir }
  teamView: {},           // teamId -> { q, onlyOpen, sort: { key, dir } }
  people: new Map(),      // teamId -> [{ name, display_name, url, mps }] for teams with people
  peopleView: {},         // teamId -> { q, onlyOpen, sort: { key, dir } }
  overviewShowAll: false,
  search: { index: [], results: [], active: -1 },
  timer: null,
  clockTimer: null,
};

/* ----------------------------------------------------------- vocabulary -- */

const STATUS_ROLE = {
  needs_review: { role: "warning",  glyph: "◐" },
  in_progress:  { role: "neutral",  glyph: "○" },
  approved:     { role: "good",     glyph: "✓" },
  conflict:     { role: "critical", glyph: "✕" },
  queued:       { role: "neutral",  glyph: "⋯" },
  unknown:      { role: "neutral",  glyph: "•" },
};

// Labels live here rather than in the data file so the fetcher stays a pure
// data producer. Codes are defined in scripts/providers/base.py.
const ATTENTION = {
  no_reviewer:         { label: "No reviewer",   glyph: "⚑", role: "warning",
                         hint: "Awaiting review with nobody assigned" },
  approved_not_landed: { label: "Ready to land", glyph: "✓", role: "good",
                         hint: "Approved but not merged yet" },
  silent:              { label: "Silent",        glyph: "◴", role: "warning",
                         hint: "Awaiting review with no recent comment" },
  merge_conflict:      { label: "Conflict",      glyph: "✕", role: "critical",
                         hint: "Code failed to merge - needs a rebase" },
  linked_bug:          { label: "Linked bug",    glyph: "⊕", role: "serious",
                         hint: "Has a linked Launchpad bug" },
};

/* -------------------------------------------------------------- helpers -- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// `many` is for irregular plurals ("repository" -> "repositories").
const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + "s"}`;

function days(n) {
  if (n == null) return "—";
  if (n < 1) return "today";
  if (n < 30) return `${n}d`;
  if (n < 365) return `${Math.floor(n / 30)}mo`;
  const y = Math.floor(n / 365);
  const mo = Math.floor((n % 365) / 30);
  return mo ? `${y}y ${mo}mo` : `${y}y`;
}

function relative(iso) {
  if (!iso) return "never";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(secs)) return "unknown";
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

const absolute = (iso) => {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown"
    : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
};

// The refresh cadence in words: "daily", "every 2 hours", "every 2 days".
function every(mins) {
  if (!mins) return "regularly";
  if (mins % 1440 === 0) return mins === 1440 ? "daily" : `every ${mins / 1440} days`;
  if (mins % 60 === 0) return mins === 60 ? "hourly" : `every ${mins / 60} hours`;
  return `every ${mins} minutes`;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const allMps = (doc) => doc.repositories.flatMap((r) =>
  r.merge_requests.map((m) => ({ ...m, _repo: r.name || r.id, _repoId: r.id })));

const openCount = (repos) => repos.reduce((n, r) => n + r.merge_requests.length, 0);

// Search and filter text: case-insensitive, with - _ / . + ~ : read as spaces,
// so "archive tools" finds ubuntu-archive-tools.
const norm = (s) => String(s ?? "").toLowerCase()
  .replace(/[-_/.+~:]+/g, " ").replace(/\s+/g, " ").trim();
const matchesAll = (hay, q) => !q || q.split(" ").every((t) => hay.includes(t));

// "https://host/~a/b/+git/c" -> "~a/b/+git/c"
const urlPath = (u) => String(u || "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?/i, "");
const urlHost = (u) => { try { return new URL(u).host; } catch { return ""; } };

function badge(role, glyph, label, title) {
  return `<span class="badge badge--${role}"${title ? ` title="${esc(title)}"` : ""}>` +
    `<span class="badge__glyph" aria-hidden="true">${glyph}</span>${esc(label)}</span>`;
}

const statusBadge = (mp) => {
  const s = STATUS_ROLE[mp.status_category] || STATUS_ROLE.unknown;
  return badge(s.role, s.glyph, mp.status);
};

function flagBadges(mp, staleDays) {
  const out = [];
  if (mp.is_stale) {
    out.push(badge("critical", "◷", "Stale",
      `No activity for ${mp.inactive_days} days (threshold ${staleDays})`));
  }
  for (const code of mp.attention || []) {
    const a = ATTENTION[code];
    if (a) out.push(badge(a.role, a.glyph, a.label, a.hint));
  }
  return out.join("");
}

const stat = (label, value, note, mod) => `
    <div class="stat ${mod ? `stat--${mod}` : ""}">
      <div class="stat__label">${label}</div>
      <div class="stat__value num">${value}</div>
      <div class="stat__note">${note}</div>
    </div>`;

const chip = (key, label, count, pressed) =>
  `<button type="button" class="chip" data-chip="${esc(key)}" aria-pressed="${pressed}">
     ${esc(label)}<span class="chip__count">${count}</span></button>`;

function sortHead(sort, key, label, extra = "") {
  const active = sort.key === key;
  const arrow = active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅";
  return `<th scope="col" role="button" tabindex="0" data-sort="${key}" ${extra}
     ${active ? `aria-sort="${sort.dir === "asc" ? "ascending" : "descending"}"` : ""}>
     ${esc(label)}<span class="sort-arrow" aria-hidden="true">${arrow}</span></th>`;
}

function wireSort(panel, sort, descFirst, rerender) {
  panel.querySelectorAll("[data-sort]").forEach((th) => {
    const go = () => {
      const key = th.dataset.sort;
      // Text sorts read best ascending first; numeric ones descending first.
      if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
      else { sort.key = key; sort.dir = descFirst.has(key) ? "desc" : "asc"; }
      rerender();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
}

// Re-rendering replaces the input, so put the caret back where it was.
function wireFilterInput(panel, set, rerender) {
  const input = panel.querySelector('[data-filter="q"]');
  if (!input) return;
  input.addEventListener("input", (e) => {
    set(e.target.value);
    const pos = e.target.selectionStart;
    rerender();
    const next = panel.querySelector('[data-filter="q"]');
    next.focus();
    next.setSelectionRange(pos, pos);
  });
}

/* ---------------------------------------------------------------- teams -- */

// Teams in config order, each holding its repositories. Data written before
// teams existed (schema v1) becomes one implicit team.
function teamsOf(doc) {
  const declared = doc.teams?.length ? doc.teams : [{ id: "repositories", name: "Repositories" }];
  const teams = declared.map((t) => ({ ...t, name: t.name || t.id, repos: [] }));
  const byId = new Map(teams.map((t) => [t.id, t]));
  for (const r of doc.repositories) {
    let team = byId.get(r.team) ?? (doc.teams?.length ? null : teams[0]);
    if (!team) {
      // A repository naming an unknown team stays visible rather than vanish.
      team = byId.get("other") ?? { id: "other", name: "Other", repos: [] };
      if (!byId.has("other")) { teams.push(team); byId.set("other", team); }
    }
    team.repos.push(r);
  }
  return teams;
}

/* --------------------------------------------------------------- people -- */

// A team's members, each with every open MP they proposed: those in tracked
// repositories (matched by author) plus those the fetcher found elsewhere.
function peopleOf(team, doc) {
  if (!team.people) return null;
  const byName = new Map(team.people.members.map((m) => [m.name, { ...m, mps: [], seen: new Set() }]));
  const add = (mp, extra) => {
    const p = byName.get(mp.author?.name);
    if (!p || p.seen.has(mp.url)) return;
    p.seen.add(mp.url);
    p.mps.push({ ...mp, ...extra });
  };
  for (const r of doc.repositories) {
    const team = state.teamOfRepo.get(r.id);
    const href = routeHash({ view: "repo", id: r.id });
    for (const mp of r.merge_requests) add(mp, { _repoName: r.name || r.id, _repoHref: href, _repoTeam: team });
  }
  for (const mp of team.people.merge_requests) {
    add(mp, { _repoName: mp.target_repository || "—", _repoHref: mp.target_repository_url, _external: true });
  }
  return [...byName.values()];
}

/* -------------------------------------------------------------- routing -- */

// #overview, #repo/<id>, #team/<id>, #team/<id>/people, #team/<id>/people/<person>
function routeHash(r) {
  if (r.view === "overview") return "#overview";
  const base = `#${r.view}/${encodeURIComponent(r.id)}`;
  if (r.tab !== "people") return base;
  return `${base}/people${r.person ? `/${encodeURIComponent(r.person)}` : ""}`;
}

function parseRoute(hash) {
  const h = hash.replace(/^#/, "");
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  if (!h || h === "overview") return { view: "overview" };
  const [kind, id, tab, person] = h.split("/").map(dec);
  if (kind === "repo" && id) return { view: "repo", id: dec(h.slice("repo/".length)) };
  if (kind === "team" && id) return tab === "people" ? { view: "team", id, tab, person } : { view: "team", id };
  return { view: "legacy", id: dec(h) };  // #<repoId> links from before teams existed
}

// Unknown ids fall back to the nearest view that exists: an unknown person to
// the People list, a team without people to the team, anything else to the
// Overview, as unknown tabs always have.
function resolveRoute(r) {
  if ((r.view === "repo" || r.view === "legacy") && state.repoById.has(r.id)) {
    return { view: "repo", id: r.id };
  }
  const team = state.teams.find((t) => t.id === r.id);
  if (team && (r.view === "team" || r.view === "legacy")) {
    const people = state.people.get(team.id);
    if (r.tab !== "people" || !people) return { view: "team", id: team.id };
    const person = people.find((p) => p.name === r.person);
    return { view: "team", id: team.id, tab: "people", person: person?.name };
  }
  return { view: "overview" };
}

const activeTabId = () => state.route.view === "team" ? state.route.id
  : state.route.view === "repo" ? state.teamOfRepo.get(state.route.id)?.id
  : "overview";

function applyRoute({ scroll = false } = {}) {
  state.route = resolveRoute(parseRoute(location.hash));
  const canonical = routeHash(state.route);
  if (location.hash !== canonical) {
    try { history.replaceState(null, "", canonical); } catch { /* file:// */ }
  }
  renderTabs();
  renderView();
  if (scroll) window.scrollTo(0, 0);
}

/* ------------------------------------------------------------- rendering -- */

function renderBanners(doc) {
  const el = document.getElementById("banners");
  const out = [];

  const failed = doc.repositories.filter((r) => r.status === "error");
  if (failed.length > 3) {
    // One outage must not stack a banner per repository.
    out.push(`<div class="banner banner--critical">
      <span class="banner__icon" aria-hidden="true">✕</span>
      <div><strong>${plural(failed.length, "repository", "repositories")} could not be refreshed.</strong>
      Their cached merge proposals are shown instead.
      <details class="banner__details"><summary>Show which</summary><ul>${failed.map((r) => `
        <li><a href="${esc(routeHash({ view: "repo", id: r.id }))}">${esc(r.name || r.id)}</a>:
        ${esc(r.error || "Unknown error")}; data from ${esc(relative(r.last_successful_refresh))}</li>`).join("")}
      </ul></details></div></div>`);
  } else {
    for (const r of failed) {
      out.push(`<div class="banner banner--critical">
        <span class="banner__icon" aria-hidden="true">✕</span>
        <div><strong>${esc(r.name || r.id)} could not be refreshed.</strong>
        ${esc(r.error || "Unknown error")}.
        Showing ${plural(r.merge_requests.length, "cached merge proposal")} from
        ${esc(relative(r.last_successful_refresh))}
        (${esc(absolute(r.last_successful_refresh))}).</div></div>`);
    }
  }

  for (const t of state.teams.filter((x) => x.error)) {
    out.push(`<div class="banner banner--warning">
      <span class="banner__icon" aria-hidden="true">⚠</span>
      <div><strong>${esc(t.name)}: repository list not refreshed.</strong> ${esc(t.error)}</div></div>`);
  }
  for (const t of state.teams.filter((x) => x.people?.error)) {
    out.push(`<div class="banner banner--warning">
      <span class="banner__icon" aria-hidden="true">⚠</span>
      <div><strong>${esc(t.name)}: people's merge proposals not fully refreshed.</strong>
      ${esc(t.people.error)}</div></div>`);
  }

  // Our cached file being old is a different problem from an MP being stale.
  const mins = doc.config.refresh_interval_minutes || 120;
  const ageMs = Date.now() - new Date(doc.generated_at).getTime();
  if (ageMs > mins * 60000 * 2) {
    out.push(`<div class="banner banner--warning">
      <span class="banner__icon" aria-hidden="true">⚠</span>
      <div><strong>This data is out of date.</strong>
      Last collected ${esc(relative(doc.generated_at))}, but it should refresh
      ${every(mins)}. The scheduled GitHub Action may have failed or been disabled.</div></div>`);
  }
  el.innerHTML = out.join("");
}

function renderTabs() {
  const tabs = document.getElementById("tabs");
  const current = activeTabId();
  const items = [{ id: "overview", href: "#overview", label: "Overview", count: null, error: false }];
  for (const t of state.teams) {
    items.push({
      id: t.id,
      href: routeHash({ view: "team", id: t.id }),
      label: t.name,
      count: openCount(t.repos),
      error: t.repos.some((r) => r.status === "error"),
    });
  }
  tabs.innerHTML = items.map((t) => `
    <a class="tab" href="${esc(t.href)}" id="tab-${esc(t.id)}"
       ${t.id === current ? `aria-current="page"` : ""}>
      ${esc(t.label)}
      ${t.count !== null ? `<span class="tab__count">${t.count}</span>` : ""}
      ${t.error ? `<span class="tab__warn" aria-label="refresh failed">✕</span>` : ""}
    </a>`).join("");

  // On narrow screens the strip scrolls sideways; keep the current tab in view.
  const cur = tabs.querySelector("[aria-current]");
  if (cur) {
    const strip = tabs.getBoundingClientRect(), tab = cur.getBoundingClientRect();
    if (tab.right > strip.right || tab.left < strip.left) tabs.scrollLeft += tab.left - strip.left - 16;
  }
}

function renderView() {
  const doc = state.doc;
  const { view, id } = state.route;
  const main = document.getElementById("panels");
  main.innerHTML = `<section class="panel" id="view"></section>`;
  const panel = main.firstElementChild;

  let label = "Overview";
  if (view === "team") {
    const team = state.teams.find((t) => t.id === id);
    const person = state.route.person && state.people.get(id).find((p) => p.name === state.route.person);
    if (person) {
      label = person.display_name;
      personView(panel, team, person, doc);
    } else if (state.route.tab === "people") {
      label = `${team.name} people`;
      panel.innerHTML = peoplePanel(team, doc);
      wirePeoplePanel(panel, team, doc);
    } else {
      label = team.name;
      panel.innerHTML = teamPanel(team, doc);
      wireTeamPanel(panel, team, doc);
    }
  } else if (view === "repo") {
    const repo = state.repoById.get(id);
    label = repo.name || repo.id;
    repoView(panel, repo, doc);
  } else {
    panel.innerHTML = overviewPanel(doc);
    panel.querySelector("[data-toggle-all]")?.addEventListener("click", () => {
      state.overviewShowAll = !state.overviewShowAll;
      renderView();
    });
  }
  panel.setAttribute("aria-label", label);
  document.title = view === "overview" ? "Ubuntu MP Review Dashboard"
    : `${label} · Ubuntu MP Review Dashboard`;
}

/* -- repository rows, shared by the Overview and team views -- */

function staleCell(stale, total) {
  const pct = total ? Math.round((stale / total) * 100) : 0;
  return `${stale}
        <div class="meter" role="img" aria-label="${pct}% stale">
          <div class="meter__fill ${pct >= 50 ? "meter__fill--critical" : ""}" style="width:${pct}%"></div>
        </div>`;
}

const teamPill = (team) => team
  ? `<a class="team-pill" href="${esc(routeHash({ view: "team", id: team.id }))}">${esc(team.name)}</a>` : "";

function repoRow(r, { showTeam = false } = {}) {
  const m = r.merge_requests;
  const host = urlHost(r.url);
  return `<tr>
      <td><a class="mp-title" href="${esc(routeHash({ view: "repo", id: r.id }))}">${esc(r.name || r.id)}</a>
          <div class="mp-meta">${esc(r.provider)}${host ? ` · <a href="${esc(r.url)}" rel="noopener"
             title="Open ${esc(r.name || r.id)} on ${esc(host)}">${esc(host)}&nbsp;↗</a>` : ""}</div></td>
      ${showTeam ? `<td>${teamPill(state.teamOfRepo.get(r.id))}</td>` : ""}
      <td class="num">${m.length}</td>
      <td class="num">${staleCell(m.filter((x) => x.is_stale).length, m.length)}</td>
      <td class="num">${m.filter((x) => x.attention?.length).length}</td>
      <td>${r.status === "error"
            ? badge("critical", "✕", "Refresh failed", r.error || "")
            : badge("good", "✓", "OK")}
          <div class="mp-meta mp-meta--sans">${esc(relative(r.last_successful_refresh))}</div></td>
    </tr>`;
}

/* -- overview -- */

function overviewPanel(doc) {
  const mps = allMps(doc);
  const stale = mps.filter((m) => m.is_stale);
  const attention = mps.filter((m) => m.attention?.length);
  const withBugs = mps.filter((m) => m.linked_bugs?.length);
  const oldest = mps.reduce((a, b) => (!a || b.age_days > a.age_days ? b : a), null);
  const staleDays = doc.config.stale_after_days;

  const attnCounts = {};
  for (const m of mps) for (const c of m.attention || []) attnCounts[c] = (attnCounts[c] || 0) + 1;

  const teamRows = state.teams.map((t) => {
    const m = t.repos.flatMap((r) => r.merge_requests);
    const failed = t.repos.filter((r) => r.status === "error").length;
    const active = t.repos.filter((r) => r.merge_requests.length).length;
    const status = !t.repos.length ? badge("neutral", "•", "No repositories")
      : failed ? badge("critical", "✕", `${failed} failed`, "Repositories whose last refresh failed")
      : t.error ? badge("warning", "⚠", "List not refreshed", t.error)
      : badge("good", "✓", "OK");
    return `<tr>
      <td><a class="mp-title" href="${esc(routeHash({ view: "team", id: t.id }))}">${esc(t.name)}</a>
          ${t.description ? `<div class="mp-meta mp-meta--sans">${esc(t.description)}</div>` : ""}</td>
      <td class="num">${t.repos.length}
          <div class="mp-meta mp-meta--sans">${active} with open MPs</div></td>
      <td class="num">${m.length}</td>
      <td class="num">${staleCell(m.filter((x) => x.is_stale).length, m.length)}</td>
      <td class="num">${m.filter((x) => x.attention?.length).length}</td>
      <td>${status}</td>
    </tr>`;
  }).join("");

  // Repositories with nothing open stay one click away, so the table scales.
  const quiet = doc.repositories.filter((r) => !r.merge_requests.length && r.status !== "error");
  const listed = state.overviewShowAll ? doc.repositories
    : doc.repositories.filter((r) => !quiet.includes(r));
  const repoRows = listed.map((r) => repoRow(r, { showTeam: true })).join("");

  const attnRows = Object.entries(ATTENTION)
    .map(([code, a]) => ({ code, a, n: attnCounts[code] || 0 }))
    .sort((x, y) => y.n - x.n)
    .map(({ a, n }) => `<tr>
        <td>${badge(a.role, a.glyph, a.label)}</td>
        <td class="num">${n}</td>
        <td class="mp-meta mp-meta--sans">${esc(a.hint)}</td>
      </tr>`).join("");

  return `
    <div class="hero">
      <span class="hero__value">${mps.length}</span>
      <span class="hero__label">open merge proposals<br>across ${plural(doc.repositories.length, "repository", "repositories")}
        in ${plural(state.teams.length, "team")}</span>
      <span class="hero__sub">
        Last refresh ${esc(relative(doc.generated_at))}<br>${esc(absolute(doc.generated_at))}
      </span>
    </div>

    <div class="stats">
      ${stat(`<span class="badge__glyph" aria-hidden="true">◷</span> Stale`,
             stale.length,
             `No activity for ${staleDays}+ days`,
             stale.length ? "critical" : null)}
      ${stat(`<span class="badge__glyph" aria-hidden="true">⚑</span> Needs attention`,
             attention.length,
             `${mps.length ? Math.round((attention.length / mps.length) * 100) : 0}% of open MPs`,
             attention.length ? "warning" : null)}
      ${stat(`<span class="badge__glyph" aria-hidden="true">⊕</span> With linked bugs`,
             withBugs.length, "Have a related Launchpad bug", withBugs.length ? "warning" : null)}
      ${stat("Oldest open MP",
             oldest ? days(oldest.age_days) : "—",
             oldest ? `<a href="${esc(oldest.url)}" rel="noopener">${esc(oldest._repo)} #${esc(oldest.id)}</a>` : "")}
      ${stat("Median age", days(median(mps.map((m) => m.age_days))), "Half are older than this")}
      ${stat("Median time idle", days(median(mps.map((m) => m.inactive_days))), "Since last comment or review")}
    </div>

    <h2 class="section-title">By team</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr>
          <th scope="col">Team</th><th scope="col">Repositories</th><th scope="col">Open</th>
          <th scope="col">Stale</th><th scope="col">Attention</th><th scope="col">Status</th>
        </tr></thead>
        <tbody>${teamRows}</tbody>
      </table>
    </div>

    <h2 class="section-title">By repository</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr>
          <th scope="col">Repository</th><th scope="col">Team</th><th scope="col">Open</th>
          <th scope="col">Stale</th><th scope="col">Attention</th><th scope="col">Last refresh</th>
        </tr></thead>
        <tbody>${repoRows || `<tr><td colspan="6" class="empty">No repository has open merge proposals.</td></tr>`}</tbody>
      </table>
    </div>
    ${quiet.length ? `<button type="button" class="link-btn" data-toggle-all aria-expanded="${state.overviewShowAll}">
      ${state.overviewShowAll ? "Show only repositories with open merge proposals"
        : `Show ${plural(quiet.length, "more repository", "more repositories")} with no open merge proposals`}
    </button>` : ""}

    <h2 class="section-title">Why MPs need attention</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr><th scope="col">Signal</th><th scope="col">MPs</th><th scope="col">Meaning</th></tr></thead>
        <tbody>${attnRows}</tbody>
      </table>
    </div>`;
}

/* -- per team -- */

const TEAM_SORTS = {
  name: (r) => (r.name || r.id).toLowerCase(),
  open: (r) => r.merge_requests.length,
  stale: (r) => r.merge_requests.filter((m) => m.is_stale).length,
  attention: (r) => r.merge_requests.filter((m) => m.attention?.length).length,
  refreshed: (r) => new Date(r.last_successful_refresh || 0).getTime() || 0,
};

// The team's title, plus a Repositories | People switch for teams with people.
function teamHead(team, tab) {
  const people = state.people.get(team.id);
  const desc = tab === "people"
    ? `Members of ${team.people.source}, with every merge proposal they have open`
    : team.description;
  const link = (t, label, count) => `
      <a href="${esc(routeHash({ view: "team", id: team.id, tab: t }))}"${tab === t ? ` aria-current="page"` : ""}>
        ${label}<span class="tab__count">${count}</span></a>`;
  return `
    <div class="team-head">
      <div>
        <h2 class="team-head__title">${esc(team.name)}</h2>
        ${desc ? `<p class="team-head__desc">${esc(desc)}</p>` : ""}
      </div>
      ${people ? `<nav class="view-switch" aria-label="${esc(team.name)} views">${
        link("repos", "Repositories", team.repos.length)}${link("people", "People", people.length)}</nav>` : ""}
    </div>`;
}

function teamPanel(team, doc) {
  const head = teamHead(team, "repos");

  if (!team.repos.length) {
    return `${head}
      <div class="card empty-state">
        <strong>No repositories yet.</strong>
        Add repositories with <code>team: ${esc(team.id)}</code> in <code>config/repos.yaml</code>,
        or give this team a <code>discover</code> block.
      </div>`;
  }

  const v = state.teamView[team.id];
  const staleDays = doc.config.stale_after_days;
  const mps = team.repos.flatMap((r) => r.merge_requests.map((m) => ({ ...m, _repo: r.name || r.id })));
  const stale = mps.filter((m) => m.is_stale).length;
  const attention = mps.filter((m) => m.attention?.length).length;
  const active = team.repos.filter((r) => r.merge_requests.length).length;
  const oldest = mps.reduce((a, b) => (!a || b.age_days > a.age_days ? b : a), null);

  const q = norm(v.q);
  const get = TEAM_SORTS[v.sort.key] || TEAM_SORTS.open;
  const rows = team.repos
    .filter((r) => !v.onlyOpen || r.merge_requests.length)
    .filter((r) => matchesAll(norm(`${r.name} ${r.id} ${urlPath(r.url)}`), q))
    .sort((a, b) => {
      const [x, y] = [get(a), get(b)];
      const cmp = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      return (v.sort.dir === "asc" ? cmp : -cmp) || (a.name || a.id).localeCompare(b.name || b.id);
    });

  return `${head}
    <div class="stats" style="margin-bottom:16px">
      ${stat("Open", mps.length, `Across ${plural(team.repos.length, "repository", "repositories")}`)}
      ${stat(`<span class="badge__glyph" aria-hidden="true">◷</span> Stale`,
             stale, `No activity for ${staleDays}+ days`, stale ? "critical" : null)}
      ${stat(`<span class="badge__glyph" aria-hidden="true">⚑</span> Needs attention`,
             attention, `${mps.length ? Math.round((attention / mps.length) * 100) : 0}% of open MPs`,
             attention ? "warning" : null)}
      ${stat("Repositories", team.repos.length, `${active} with open MPs`)}
      ${stat("Oldest open MP",
             oldest ? days(oldest.age_days) : "—",
             oldest ? `<a href="${esc(oldest.url)}" rel="noopener">${esc(oldest._repo)} #${esc(oldest.id)}</a>` : "")}
      ${stat("Median time idle", days(median(mps.map((m) => m.inactive_days))), "Since last comment or review")}
    </div>

    <div class="filters">
      <input type="search" data-filter="q" value="${esc(v.q)}"
             placeholder="Filter repositories…"
             aria-label="Filter repositories in ${esc(team.name)}">
      <div class="chips">${chip("open", "With open MPs", active, v.onlyOpen)}</div>
      <span class="filter-summary">${rows.length} of ${plural(team.repos.length, "repository", "repositories")} shown</span>
    </div>

    <div class="card table-wrap">
      <table>
        <thead><tr>
          ${sortHead(v.sort, "name", "Repository")}
          ${sortHead(v.sort, "open", "Open")}
          ${sortHead(v.sort, "stale", "Stale")}
          ${sortHead(v.sort, "attention", "Attention")}
          ${sortHead(v.sort, "refreshed", "Last refresh")}
        </tr></thead>
        <tbody>${rows.map((r) => repoRow(r)).join("")
          || `<tr><td colspan="5" class="empty">No repositories match these filters.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function wireTeamPanel(panel, team, doc) {
  const v = state.teamView[team.id];
  const rerender = () => {
    panel.innerHTML = teamPanel(team, doc);
    wireTeamPanel(panel, team, doc);
  };
  wireFilterInput(panel, (value) => { v.q = value; }, rerender);
  panel.querySelector('[data-chip="open"]')?.addEventListener("click", () => {
    v.onlyOpen = !v.onlyOpen;
    rerender();
  });
  wireSort(panel, v.sort, new Set(["open", "stale", "attention", "refreshed"]), rerender);
}

/* -- a team's people -- */

const PEOPLE_SORTS = {
  name: (p) => p.display_name.toLowerCase(),
  open: (p) => p.mps.length,
  stale: (p) => p.mps.filter((m) => m.is_stale).length,
  attention: (p) => p.mps.filter((m) => m.attention?.length).length,
  oldest: (p) => Math.max(0, ...p.mps.map((m) => m.age_days)),
};

function peoplePanel(team, doc) {
  const people = state.people.get(team.id);
  const v = state.peopleView[team.id];
  const staleDays = doc.config.stale_after_days;
  const mps = people.flatMap((p) => p.mps);
  const stale = mps.filter((m) => m.is_stale).length;
  const attention = mps.filter((m) => m.attention?.length).length;
  const active = people.filter((p) => p.mps.length).length;
  const elsewhere = mps.filter((m) => m._external).length;
  const oldest = mps.reduce((a, b) => (!a || b.age_days > a.age_days ? b : a), null);

  const q = norm(v.q);
  const get = PEOPLE_SORTS[v.sort.key] || PEOPLE_SORTS.open;
  const rows = people
    .filter((p) => !v.onlyOpen || p.mps.length)
    .filter((p) => matchesAll(norm(`${p.display_name} ${p.name}`), q))
    .sort((a, b) => {
      const [x, y] = [get(a), get(b)];
      const cmp = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      return (v.sort.dir === "asc" ? cmp : -cmp) || a.display_name.localeCompare(b.display_name);
    });

  const row = (p) => {
    const host = urlHost(p.url);
    return `<tr>
      <td><a class="mp-title" href="${esc(routeHash({ view: "team", id: team.id, tab: "people", person: p.name }))}">${esc(p.display_name)}</a>
          <div class="mp-meta">~${esc(p.name)}${host ? ` · <a href="${esc(p.url)}" rel="noopener"
             title="${esc(p.display_name)} on ${esc(host)}">${esc(host)}&nbsp;↗</a>` : ""}</div></td>
      <td class="num">${p.mps.length}</td>
      <td class="num">${staleCell(p.mps.filter((m) => m.is_stale).length, p.mps.length)}</td>
      <td class="num">${p.mps.filter((m) => m.attention?.length).length}</td>
      <td class="num">${p.mps.length ? days(PEOPLE_SORTS.oldest(p)) : "—"}</td>
    </tr>`;
  };

  return `${teamHead(team, "people")}
    <div class="stats" style="margin-bottom:16px">
      ${stat("Open", mps.length, `${elsewhere} outside the repositories tracked here`)}
      ${stat(`<span class="badge__glyph" aria-hidden="true">◷</span> Stale`,
             stale, `No activity for ${staleDays}+ days`, stale ? "critical" : null)}
      ${stat(`<span class="badge__glyph" aria-hidden="true">⚑</span> Needs attention`,
             attention, `${mps.length ? Math.round((attention / mps.length) * 100) : 0}% of open MPs`,
             attention ? "warning" : null)}
      ${stat("People", people.length, `${active} with open MPs`)}
      ${stat("Oldest open MP",
             oldest ? days(oldest.age_days) : "—",
             oldest ? `<a href="${esc(oldest.url)}" rel="noopener">${esc(oldest._repoName)} #${esc(oldest.id)}</a>` : "")}
      ${stat("Median time idle", days(median(mps.map((m) => m.inactive_days))), "Since last comment or review")}
    </div>

    <div class="filters">
      <input type="search" data-filter="q" value="${esc(v.q)}"
             placeholder="Filter people…"
             aria-label="Filter people in ${esc(team.name)}">
      <div class="chips">${chip("open", "With open MPs", active, v.onlyOpen)}</div>
      <span class="filter-summary">${rows.length} of ${plural(people.length, "person", "people")} shown</span>
    </div>

    <div class="card table-wrap">
      <table>
        <thead><tr>
          ${sortHead(v.sort, "name", "Person")}
          ${sortHead(v.sort, "open", "Open")}
          ${sortHead(v.sort, "stale", "Stale")}
          ${sortHead(v.sort, "attention", "Attention")}
          ${sortHead(v.sort, "oldest", "Oldest")}
        </tr></thead>
        <tbody>${rows.map(row).join("")
          || `<tr><td colspan="5" class="empty">No people match these filters.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function wirePeoplePanel(panel, team, doc) {
  const v = state.peopleView[team.id];
  const rerender = () => {
    panel.innerHTML = peoplePanel(team, doc);
    wirePeoplePanel(panel, team, doc);
  };
  wireFilterInput(panel, (value) => { v.q = value; }, rerender);
  panel.querySelector('[data-chip="open"]')?.addEventListener("click", () => {
    v.onlyOpen = !v.onlyOpen;
    rerender();
  });
  wireSort(panel, v.sort, new Set(["open", "stale", "attention", "oldest"]), rerender);
}

// One person's MPs, in the repository table with a Repository column.
function personView(panel, team, person, doc) {
  const list = {
    id: `person:${team.id}:${person.name}`, name: person.display_name, url: person.url,
    status: "ok", merge_requests: person.mps,
  };
  listState(list.id);
  panel.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${esc(routeHash({ view: "team", id: team.id }))}">${esc(team.name)}</a>
      <span class="crumbs__sep" aria-hidden="true">›</span>
      <a href="${esc(routeHash({ view: "team", id: team.id, tab: "people" }))}">People</a>
      <span class="crumbs__sep" aria-hidden="true">›</span>
      <span aria-current="page">${esc(person.display_name)}</span>
    </nav>
    <div data-repo-body></div>`;
  const body = panel.querySelector("[data-repo-body]");
  const opts = { column: "repository" };
  body.innerHTML = repoPanel(list, doc, opts);
  wireRepoPanel(body, list, doc, opts);
}

/* -- per repository -- */

const SORTS = {
  title: (m) => m.title.toLowerCase(),
  author: (m) => (m.author?.display_name || "").toLowerCase(),
  repository: (m) => (m._repoName || "").toLowerCase(),
  status: (m) => m.status,
  age_days: (m) => m.age_days,
  inactive_days: (m) => m.inactive_days,
};

// Filter and sort state for one MP list (a repository, or a person's MPs).
function listState(id) {
  state.filters[id] ??= { q: "", statuses: new Set(), flags: new Set() };
  state.sort[id] ??= { key: "inactive_days", dir: "desc" };
}

function repoView(panel, repo, doc) {
  const team = state.teamOfRepo.get(repo.id);
  panel.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      ${team ? `<a href="${esc(routeHash({ view: "team", id: team.id }))}">${esc(team.name)}</a>
        <span class="crumbs__sep" aria-hidden="true">›</span>` : ""}
      <span aria-current="page">${esc(repo.name || repo.id)}</span>
    </nav>
    <div data-repo-body></div>`;
  const body = panel.querySelector("[data-repo-body]");
  body.innerHTML = repoPanel(repo, doc);
  wireRepoPanel(body, repo, doc);
}

function visibleMps(repo, doc) {
  const f = state.filters[repo.id];
  const q = f.q.trim().toLowerCase();
  return repo.merge_requests.filter((m) => {
    if (f.statuses.size && !f.statuses.has(m.status)) return false;
    if (f.flags.has("stale") && !m.is_stale) return false;
    if (f.flags.has("attention") && !m.attention?.length) return false;
    for (const code of f.flags) {
      if (code !== "stale" && code !== "attention" && !(m.attention || []).includes(code)) return false;
    }
    if (!q) return true;
    return [m.title, m.author?.display_name, m.author?.name, m.id, m.source_branch, m.status, m._repoName,
            ...(m.linked_bugs || []).map((b) => `${b.id} ${b.title}`)]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}

// `column: "repository"` swaps the Author column for the MP's repository,
// for lists where every MP has the same author (one person's MPs).
function repoPanel(repo, doc, { column = "author" } = {}) {
  const staleDays = doc.config.stale_after_days;
  const sort = state.sort[repo.id];
  const rows = visibleMps(repo, doc).sort((a, b) => {
    const get = SORTS[sort.key] || SORTS.inactive_days;
    const [x, y] = [get(a), get(b)];
    const cmp = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.dir === "asc" ? cmp : -cmp;
  });

  const all = repo.merge_requests;
  const statuses = [...new Set(all.map((m) => m.status))].sort();
  const f = state.filters[repo.id];

  const head = (key, label, extra = "") => sortHead(sort, key, label, extra);

  const body = rows.length ? rows.map((m) => `
    <tr>
      <td>
        <a class="mp-title" href="${esc(m.url)}" rel="noopener">${esc(m.title)}</a>
        <div class="mp-meta">#${esc(m.id)}${m.source_branch ? ` · ${esc(m.source_branch)} → ${esc(m.target_branch || "")}` : ""}</div>
        ${(m.linked_bugs || []).length ? `<div class="badge-row" style="margin-top:4px">${
          m.linked_bugs.map((b) => `<a class="bug-pill" href="${esc(b.url)}" rel="noopener"
             title="${esc(b.title)} — ${esc(b.status || "")}, ${esc(b.importance || "")}">#${esc(b.id)}</a>`).join("")
        }</div>` : ""}
      </td>
      ${column === "repository" ? `<td>${m._external
          ? `<a href="${esc(m._repoHref || "")}" rel="noopener">${esc(m._repoName)}&nbsp;↗</a>
             <div class="mp-meta mp-meta--sans">Not tracked here</div>`
          : `<a href="${esc(m._repoHref)}">${esc(m._repoName)}</a>
             ${m._repoTeam ? `<div class="badge-row" style="margin-top:3px">${teamPill(m._repoTeam)}</div>` : ""}`}
      </td>` : `<td>${m.author?.url ? `<a href="${esc(m.author.url)}" rel="noopener">${esc(m.author.display_name)}</a>`
                          : esc(m.author?.display_name || "Unknown")}
          ${(m.reviewers || []).length ? `<div class="mp-meta">${plural(m.reviewers.length, "reviewer")}</div>` : ""}
      </td>`}
      <td>${statusBadge(m)}</td>
      <td class="num" title="Opened ${esc(absolute(m.created_at))}">${days(m.age_days)}</td>
      <td class="num" title="${m.updated_at ? `Last activity ${esc(absolute(m.updated_at))}` : "No activity recorded"}">${days(m.inactive_days)}</td>
      <td><div class="badge-row">${flagBadges(m, staleDays) || `<span class="mp-meta">—</span>`}</div></td>
    </tr>`).join("")
    : `<tr><td colspan="6" class="empty">No merge proposals match these filters.</td></tr>`;

  return `
    ${repo.status === "error" ? `<div class="banner banner--critical" style="margin-bottom:14px">
        <span class="banner__icon" aria-hidden="true">✕</span>
        <div><strong>Showing cached data.</strong> The last refresh of this repository failed
        (${esc(repo.error || "unknown error")}). These ${plural(all.length, "merge proposal")} were
        collected ${esc(relative(repo.last_successful_refresh))}.</div></div>` : ""}

    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="stat__label">Open</div>
        <div class="stat__value num">${all.length}</div>
        <div class="stat__note"><a href="${esc(repo.url)}" rel="noopener">${esc(repo.name || repo.id)}</a></div></div>
      <div class="stat ${all.some((m) => m.is_stale) ? "stat--critical" : ""}">
        <div class="stat__label"><span class="badge__glyph" aria-hidden="true">◷</span> Stale</div>
        <div class="stat__value num">${all.filter((m) => m.is_stale).length}</div>
        <div class="stat__note">No activity for ${staleDays}+ days</div></div>
      <div class="stat ${all.some((m) => m.attention?.length) ? "stat--warning" : ""}">
        <div class="stat__label"><span class="badge__glyph" aria-hidden="true">⚑</span> Needs attention</div>
        <div class="stat__value num">${all.filter((m) => m.attention?.length).length}</div>
        <div class="stat__note">One or more review signals</div></div>
      <div class="stat"><div class="stat__label">Oldest</div>
        <div class="stat__value num">${all.length ? days(Math.max(...all.map((m) => m.age_days))) : "—"}</div>
        <div class="stat__note">Median ${days(median(all.map((m) => m.age_days)))}</div></div>
    </div>

    <div class="filters">
      <input type="search" data-filter="q" value="${esc(f.q)}"
             placeholder="Filter by title, ${column === "repository" ? "repository" : "author"}, branch or bug…"
             aria-label="Filter merge proposals in ${esc(repo.name || repo.id)}">
      <div class="chips">
        ${chip("stale", "Stale", all.filter((m) => m.is_stale).length, f.flags.has("stale"))}
        ${chip("attention", "Needs attention", all.filter((m) => m.attention?.length).length, f.flags.has("attention"))}
        ${statuses.map((s) => chip(`status:${s}`, s, all.filter((m) => m.status === s).length, f.statuses.has(s))).join("")}
      </div>
      <span class="filter-summary">${rows.length} of ${plural(all.length, "MP")} shown</span>
    </div>

    <div class="card table-wrap">
      <table>
        <thead><tr>
          ${head("title", "Merge proposal")}
          ${column === "repository" ? head("repository", "Repository") : head("author", "Author")}
          ${head("status", "Status")}
          ${head("age_days", "Age")}
          ${head("inactive_days", "Idle")}
          <th scope="col">Flags</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function wireRepoPanel(panel, repo, doc, opts = {}) {
  const rerender = () => {
    panel.innerHTML = repoPanel(repo, doc, opts);
    wireRepoPanel(panel, repo, doc, opts);
  };

  wireFilterInput(panel, (value) => { state.filters[repo.id].q = value; }, rerender);

  panel.querySelectorAll("[data-chip]").forEach((c) => c.addEventListener("click", () => {
    const key = c.dataset.chip;
    const f = state.filters[repo.id];
    if (key.startsWith("status:")) {
      const s = key.slice(7);
      f.statuses.has(s) ? f.statuses.delete(s) : f.statuses.add(s);
    } else {
      f.flags.has(key) ? f.flags.delete(key) : f.flags.add(key);
    }
    rerender();
  }));

  wireSort(panel, state.sort[repo.id], new Set(["age_days", "inactive_days"]), rerender);
}

/* ---------------------------------------------------------- LLM settings -- */

const byId = (id) => document.getElementById(id);
const providerName = (id) => (getReviewer(id)?.label || id).replace(/ \(.*\)$/, "");

// The dialog edits a draft; nothing is stored until Save.
const draft = { provider: null, models: {}, keys: {}, remember: false };

const settingsStatus = (text) => { byId("llm-status").textContent = text; };

function openSettings() {
  const s = loadSettings();
  Object.assign(draft, {
    provider: s.provider, models: { ...s.models }, remember: s.remember,
    keys: Object.fromEntries(REVIEWERS.map((r) => [r.id, getKey(r.id)])),
  });
  byId("llm-remember").checked = s.remember;
  settingsStatus("");
  fillSettings();
  const dlg = byId("llm-dialog");
  if (!dlg.open) dlg.showModal();
}

function fillSettings() {
  const r = getReviewer(draft.provider);
  byId("llm-provider").value = r.id;
  byId("llm-key-label").textContent = r.keyLabel;
  const key = byId("llm-key");
  key.value = draft.keys[r.id] || "";
  key.placeholder = r.keyPlaceholder;
  byId("llm-key-hint").innerHTML = `<a href="${esc(r.keyUrl)}" rel="noopener" target="_blank">Create a key&nbsp;↗</a>
    ${esc(r.keyNote || "")}`;
  const model = byId("llm-model");
  model.value = draft.models[r.id] || r.defaultModel;
  model.placeholder = r.defaultModel;
  byId("llm-models").innerHTML = "";
  byId("llm-model-hint").textContent = `Default: ${r.defaultModel}. Load models to pick from what ${providerName(r.id)} offers.`;
}

// The key and model fields belong to the provider shown; keep them in the draft.
function keepFields() {
  const r = getReviewer(draft.provider);
  draft.keys[r.id] = byId("llm-key").value.trim();
  const model = byId("llm-model").value.trim();
  if (model && model !== r.defaultModel) draft.models[r.id] = model;
  else delete draft.models[r.id];
}

async function loadModels() {
  keepFields();
  const r = getReviewer(draft.provider);
  const key = draft.keys[r.id];
  if (r.modelsNeedKey && !key) {
    settingsStatus(`Enter the ${r.keyLabel} first; ${providerName(r.id)} lists its models only for a key.`);
    return;
  }
  const btn = byId("llm-load-models");
  btn.disabled = true;
  settingsStatus("Loading models…");
  try {
    const models = await r.listModels(key);
    byId("llm-models").innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("");
    settingsStatus(`${plural(models.length, "model")} available: type in the Model field to pick one.`);
  } catch (err) {
    settingsStatus(`Couldn't load models: ${err.status ? `HTTP ${err.status}, ` : ""}${err.message || "unknown error"}`);
  } finally {
    btn.disabled = false;
  }
}

function settingsChanged() {
  updateLlmButton();
  if (state.doc) renderView();
}

function updateLlmButton() {
  const cfg = activeConfig();
  const btn = byId("llm-btn");
  btn.dataset.configured = String(!!cfg.key);
  btn.title = cfg.key ? `LLM review: ${cfg.model} via ${providerName(cfg.provider)}` : "Set up LLM review";
}

function initSettings() {
  const dlg = byId("llm-dialog");
  byId("llm-host").textContent = location.host || "this site";
  byId("llm-provider").innerHTML = REVIEWERS.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join("");
  byId("llm-btn").addEventListener("click", openSettings);
  byId("llm-provider").addEventListener("change", (e) => {
    keepFields();
    draft.provider = e.target.value;
    fillSettings();
  });
  byId("llm-key-show").addEventListener("click", (e) => {
    const key = byId("llm-key");
    const show = key.type === "password";
    key.type = show ? "text" : "password";
    e.currentTarget.setAttribute("aria-pressed", String(show));
    e.currentTarget.textContent = show ? "Hide" : "Show";
  });
  byId("llm-load-models").addEventListener("click", loadModels);
  byId("llm-cancel").addEventListener("click", () => dlg.close());
  byId("llm-save").addEventListener("click", () => {
    keepFields();
    draft.remember = byId("llm-remember").checked;
    try {
      saveSettings(draft, draft.keys);
    } catch (err) {
      settingsStatus(`Couldn't save: this browser refused to store the settings (${err.message}).`);
      return;
    }
    dlg.close();
    settingsChanged();
  });
  byId("llm-forget").addEventListener("click", () => {
    forgetKeys();
    for (const r of REVIEWERS) draft.keys[r.id] = "";
    byId("llm-key").value = "";
    settingsStatus("API keys removed from this browser.");
    settingsChanged();
  });
  // The dialog closes and the key field hides again, however it was closed.
  dlg.addEventListener("close", () => {
    byId("llm-key").type = "password";
    byId("llm-key-show").textContent = "Show";
    byId("llm-key-show").setAttribute("aria-pressed", "false");
  });
  // Enter saves, except in the model field, where it picks from the list.
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.('input:not([type="checkbox"]):not([list])')) {
      e.preventDefault();
      byId("llm-save").click();
    }
  });
  updateLlmButton();
}

/* ---------------------------------------------------------------- search -- */

function buildSearchIndex() {
  state.search.index = [
    ...state.teams.map((t) => ({
      kind: "team", id: t.id, label: t.name, team: null, route: { view: "team", id: t.id },
      sub: t.description || plural(t.repos.length, "repository", "repositories"),
      open: openCount(t.repos), error: t.repos.some((r) => r.status === "error"),
      name: norm(t.name), hay: norm(`${t.name} ${t.id}`),
    })),
    // People match on their display name or Launchpad name.
    ...[...state.people].flatMap(([teamId, people]) => people.map((p) => ({
      kind: "person", id: `${teamId}/${p.name}`, label: p.display_name,
      team: state.teams.find((t) => t.id === teamId).name,
      route: { view: "team", id: teamId, tab: "people", person: p.name },
      sub: `~${p.name}`, open: p.mps.length, error: false,
      name: norm(p.display_name), alt: [norm(p.name)], hay: norm(`${p.display_name} ${p.name}`),
    }))),
    // A repository matches on its own name and path, not its team's name: the
    // team is its own result, and matching members would list all 220 of them.
    ...state.doc.repositories.map((r) => {
      const path = urlPath(r.url);
      return {
        kind: "repo", id: r.id, label: r.name || r.id, team: state.teamOfRepo.get(r.id)?.name,
        route: { view: "repo", id: r.id }, sub: path, open: r.merge_requests.length, error: r.status === "error",
        name: norm(r.name || r.id), hay: norm(`${r.name || r.id} ${path}`),
      };
    }),
  ];
  if (!document.getElementById("search-results").hidden) runSearch();
}

// Higher is better, 0 is no match. Matches on the name outrank matches on the
// path or team; the fuzzy fallback only runs when nothing else matched.
function searchScore(e, q, tokens) {
  let best = 0;
  for (const n of [e.name, ...(e.alt || [])]) {
    best = Math.max(best, n === q ? 100 : n.startsWith(q) ? 90 : ` ${n}`.includes(` ${q}`) ? 80
      : n.includes(q) ? 70 : tokens.every((t) => n.includes(t)) ? 60 : 0);
  }
  return best || (tokens.every((t) => e.hay.includes(t)) ? 40 : 0);
}

// Every query character appears in order: "ubarctools" -> ubuntu-archive-tools.
function isSubsequence(q, s) {
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return true;
  return false;
}

function search(raw) {
  const q = norm(raw);
  if (!q) return [];
  const tokens = q.split(" ");
  let hits = state.search.index
    .map((e) => ({ e, s: searchScore(e, q, tokens) }))
    .filter((h) => h.s > 0);
  if (!hits.length && q.length >= 2) {
    const compact = q.replace(/ /g, "");
    hits = state.search.index
      .filter((e) => isSubsequence(compact, e.name.replace(/ /g, "")))
      .map((e) => ({ e, s: 10 }));
  }
  return hits.sort((a, b) => b.s - a.s
      || (a.e.kind === b.e.kind ? 0 : a.e.kind === "team" ? -1 : 1)
      || a.e.label.length - b.e.label.length
      || a.e.label.localeCompare(b.e.label))
    .map((h) => h.e);
}

// Marks the first occurrence of each query token in the label.
function highlight(label, tokens) {
  const lower = label.toLowerCase();
  const ranges = tokens.map((t) => [lower.indexOf(t), t.length])
    .filter(([i]) => i >= 0)
    .map(([i, n]) => [i, i + n])
    .sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    out += esc(label.slice(pos, a)) + `<mark>${esc(label.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(label.slice(pos));
}

function runSearch() {
  const s = state.search;
  s.results = search(document.getElementById("global-search").value);
  s.active = s.results.length ? 0 : -1;
  renderSearch();
}

function renderSearch() {
  const input = document.getElementById("global-search");
  const list = document.getElementById("search-results");
  const status = document.getElementById("search-status");
  const { results, active } = state.search;
  const query = input.value.trim();
  if (!query) { closeSearch(); return; }

  const tokens = norm(query).split(" ").filter(Boolean);
  const shown = results.slice(0, SEARCH_LIMIT);
  list.innerHTML = shown.length ? shown.map((e, i) => `
      <li role="option" id="search-opt-${i}" class="search-result" data-index="${i}"
          aria-selected="${i === active}">
        <span class="search-result__line">
          <span class="search-result__name">${highlight(e.label, tokens)}</span>
          ${e.kind === "team" ? `<span class="team-pill team-pill--kind">Team</span>`
            : e.team ? `<span class="team-pill">${esc(e.team)}</span>` : ""}
          ${e.kind === "person" ? `<span class="team-pill team-pill--kind">Person</span>` : ""}
          <span class="search-result__count">${plural(e.open, "open MP")}${e.error
            ? ` <span class="tab__warn" aria-label="refresh failed">✕</span>` : ""}</span>
        </span>
        <span class="search-result__sub${e.kind === "repo" ? " search-result__sub--mono" : ""}">${esc(e.sub)}</span>
      </li>`).join("") +
      (results.length > shown.length ? `<li class="search-note" role="presentation">
        ${results.length - shown.length} more — keep typing to narrow the list</li>` : "")
    : `<li class="search-note" role="presentation">Nothing matches “${esc(query)}”</li>`;

  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  if (active >= 0) input.setAttribute("aria-activedescendant", `search-opt-${active}`);
  else input.removeAttribute("aria-activedescendant");
  status.textContent = results.length ? plural(results.length, "result") : "No results";
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function closeSearch() {
  const input = document.getElementById("global-search");
  document.getElementById("search-results").hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function initSearch() {
  const input = document.getElementById("global-search");
  const list = document.getElementById("search-results");
  const s = state.search;

  const go = (i) => {
    const e = s.results[i];
    if (!e) return;
    input.value = "";
    closeSearch();
    input.blur();
    location.hash = routeHash(e.route);
  };

  input.addEventListener("input", runSearch);
  input.addEventListener("focus", () => { if (input.value.trim()) runSearch(); });
  input.addEventListener("blur", closeSearch);
  input.addEventListener("keydown", (e) => {
    const n = Math.min(s.results.length, SEARCH_LIMIT);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { runSearch(); return; }
      if (!n) return;
      s.active = (s.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      renderSearch();
    } else if (e.key === "Enter") {
      if (!list.hidden && s.active >= 0) { e.preventDefault(); go(s.active); }
    } else if (e.key === "Escape") {
      if (!list.hidden) { e.preventDefault(); closeSearch(); }
    }
  });
  // Keep focus in the input while a result is being clicked.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const opt = e.target.closest("[data-index]");
    if (opt) go(Number(opt.dataset.index));
  });

  // "/" jumps to search from anywhere except another text field.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || input.disabled) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    input.focus();
  });
}

/* ---------------------------------------------------------------- render -- */

function render(doc) {
  state.doc = doc;
  document.getElementById("loading")?.remove();

  state.teams = teamsOf(doc);
  state.repoById = new Map(doc.repositories.map((r) => [r.id, r]));
  state.teamOfRepo = new Map(state.teams.flatMap((t) => t.repos.map((r) => [r.id, t])));
  state.people = new Map(state.teams.filter((t) => t.people).map((t) => [t.id, peopleOf(t, doc)]));
  for (const r of doc.repositories) listState(r.id);
  for (const t of state.teams) {
    state.teamView[t.id] ??= { q: "", onlyOpen: false, sort: { key: "open", dir: "desc" } };
    state.peopleView[t.id] ??= { q: "", onlyOpen: false, sort: { key: "open", dir: "desc" } };
  }

  renderBanners(doc);
  applyRoute();
  buildSearchIndex();
  document.getElementById("global-search").disabled = false;
  updateClocks();

  document.getElementById("footer-meta").textContent =
    `Schema v${doc.schema_version} · stale after ${doc.config.stale_after_days} days · ` +
    `silent after ${doc.config.silent_after_days} days · ` +
    `refreshes ${every(doc.config.refresh_interval_minutes)}`;
}

function updateClocks() {
  if (!state.doc) return;
  document.getElementById("last-refresh").textContent = relative(state.doc.generated_at);
}

/* ---------------------------------------------------------------- loading -- */

async function load({ manual = false } = {}) {
  const btn = document.getElementById("refresh-btn");
  if (manual) { btn.disabled = true; btn.classList.add("is-spinning"); }
  try {
    // Cache-bust so a manual refresh genuinely re-reads the published file.
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    const el = document.getElementById("banners");
    el.innerHTML = `<div class="banner banner--critical">
      <span class="banner__icon" aria-hidden="true">✕</span>
      <div><strong>Could not load dashboard data.</strong> ${esc(err.message)}.
      ${state.doc ? "Showing the data already on screen." :
        `Run <code>python scripts/fetch.py</code> to generate <code>${DATA_URL}</code>.`}</div></div>`;
    document.getElementById("loading")?.remove();
  } finally {
    if (manual) { btn.disabled = false; btn.classList.remove("is-spinning"); }
  }
}

function scheduleRefresh() {
  clearInterval(state.timer);
  const mins = Math.min(state.doc?.config?.refresh_interval_minutes || 120, MAX_POLL_MINUTES);
  state.timer = setInterval(() => load(), mins * 60000);
}

/* ------------------------------------------------------------------ theme -- */

function initTheme() {
  const saved = localStorage.getItem("mp-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  document.getElementById("theme-btn").addEventListener("click", () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.dataset.theme;
    const now = current === "dark" || (current === "auto" && dark) ? "light" : "dark";
    document.documentElement.dataset.theme = now;
    try { localStorage.setItem("mp-theme", now); } catch { /* private mode */ }
  });
}

/* ------------------------------------------------------------------- boot -- */

initTheme();
initSearch();
initSettings();
document.getElementById("refresh-btn").addEventListener("click", () => load({ manual: true }));
window.addEventListener("hashchange", () => { if (state.doc) applyRoute({ scroll: true }); });
await load();
scheduleRefresh();
state.clockTimer = setInterval(updateClocks, 60000);
