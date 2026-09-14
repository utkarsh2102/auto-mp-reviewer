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
 */

const DATA_URL = "data/dashboard.json";

const state = {
  doc: null,
  activeTab: "overview",
  filters: {},          // repoId -> { q, statuses:Set, flags:Set }
  sort: {},             // repoId -> { key, dir }
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

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const allMps = (doc) => doc.repositories.flatMap((r) =>
  r.merge_requests.map((m) => ({ ...m, _repo: r.name || r.id, _repoId: r.id })));

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

/* ------------------------------------------------------------- rendering -- */

function renderBanners(doc) {
  const el = document.getElementById("banners");
  const out = [];

  const failed = doc.repositories.filter((r) => r.status === "error");
  for (const r of failed) {
    out.push(`<div class="banner banner--critical">
      <span class="banner__icon" aria-hidden="true">✕</span>
      <div><strong>${esc(r.name || r.id)} could not be refreshed.</strong>
      ${esc(r.error || "Unknown error")}.
      Showing ${plural(r.merge_requests.length, "cached merge proposal")} from
      ${esc(relative(r.last_successful_refresh))}
      (${esc(absolute(r.last_successful_refresh))}).</div></div>`);
  }

  // Our cached file being old is a different problem from an MP being stale.
  const intervalMs = (doc.config.refresh_interval_minutes || 120) * 60000;
  const ageMs = Date.now() - new Date(doc.generated_at).getTime();
  if (ageMs > intervalMs * 2) {
    out.push(`<div class="banner banner--warning">
      <span class="banner__icon" aria-hidden="true">⚠</span>
      <div><strong>This data is out of date.</strong>
      Last collected ${esc(relative(doc.generated_at))}, but it should refresh every
      ${doc.config.refresh_interval_minutes} minutes. The scheduled GitHub Action
      may have failed or been disabled.</div></div>`);
  }
  el.innerHTML = out.join("");
}

function renderTabs(doc) {
  const tabs = document.getElementById("tabs");
  const items = [{ id: "overview", label: "Overview", count: null, error: false }];
  for (const r of doc.repositories) {
    items.push({
      id: r.id,
      label: r.name || r.id,
      count: r.merge_requests.length,
      error: r.status === "error",
    });
  }
  tabs.innerHTML = items.map((t) => `
    <button type="button" class="tab" role="tab" data-tab="${esc(t.id)}"
            id="tab-${esc(t.id)}" aria-controls="panel-${esc(t.id)}"
            aria-selected="${t.id === state.activeTab}">
      ${esc(t.label)}
      ${t.count !== null ? `<span class="tab__count">${t.count}</span>` : ""}
      ${t.error ? `<span class="tab__warn" aria-label="refresh failed">✕</span>` : ""}
    </button>`).join("");

  tabs.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => selectTab(b.dataset.tab)));
}

function selectTab(id) {
  state.activeTab = id;
  document.querySelectorAll(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === id)));
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.dataset.panel !== id;
  });
  try { history.replaceState(null, "", `#${id}`); } catch { /* file:// */ }
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

  const stat = (label, value, note, mod) => `
    <div class="stat ${mod ? `stat--${mod}` : ""}">
      <div class="stat__label">${label}</div>
      <div class="stat__value num">${value}</div>
      <div class="stat__note">${note}</div>
    </div>`;

  const repoRows = doc.repositories.map((r) => {
    const m = r.merge_requests;
    const s = m.filter((x) => x.is_stale).length;
    const a = m.filter((x) => x.attention?.length).length;
    const pct = m.length ? Math.round((s / m.length) * 100) : 0;
    return `<tr>
      <td><a class="mp-title" href="${esc(r.url)}" rel="noopener">${esc(r.name || r.id)}</a>
          <div class="mp-meta">${esc(r.provider)}</div></td>
      <td class="num">${m.length}</td>
      <td class="num">${s}
        <div class="meter" role="img" aria-label="${pct}% stale">
          <div class="meter__fill ${pct >= 50 ? "meter__fill--critical" : ""}" style="width:${pct}%"></div>
        </div>
      </td>
      <td class="num">${a}</td>
      <td>${r.status === "error"
            ? badge("critical", "✕", "Refresh failed", r.error || "")
            : badge("good", "✓", "OK")}
          <div class="mp-meta mp-meta--sans">${esc(relative(r.last_successful_refresh))}</div></td>
    </tr>`;
  }).join("");

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
      <span class="hero__label">open merge proposals<br>across ${plural(doc.repositories.length, "repository", "repositories")}</span>
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

    <h2 class="section-title">By repository</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr>
          <th scope="col">Repository</th><th scope="col">Open</th>
          <th scope="col">Stale</th><th scope="col">Attention</th><th scope="col">Last refresh</th>
        </tr></thead>
        <tbody>${repoRows}</tbody>
      </table>
    </div>

    <h2 class="section-title">Why MPs need attention</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr><th scope="col">Signal</th><th scope="col">MPs</th><th scope="col">Meaning</th></tr></thead>
        <tbody>${attnRows}</tbody>
      </table>
    </div>`;
}

/* -- per repository -- */

const SORTS = {
  title: (m) => m.title.toLowerCase(),
  author: (m) => (m.author?.display_name || "").toLowerCase(),
  status: (m) => m.status,
  age_days: (m) => m.age_days,
  inactive_days: (m) => m.inactive_days,
};

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
    return [m.title, m.author?.display_name, m.author?.name, m.id, m.source_branch, m.status,
            ...(m.linked_bugs || []).map((b) => `${b.id} ${b.title}`)]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}

function repoPanel(repo, doc) {
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

  const head = (key, label, extra = "") => {
    const active = sort.key === key;
    const arrow = active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅";
    return `<th scope="col" role="button" tabindex="0" data-sort="${key}" ${extra}
       ${active ? `aria-sort="${sort.dir === "asc" ? "ascending" : "descending"}"` : ""}>
       ${esc(label)}<span class="sort-arrow" aria-hidden="true">${arrow}</span></th>`;
  };

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
      <td>${m.author?.url ? `<a href="${esc(m.author.url)}" rel="noopener">${esc(m.author.display_name)}</a>`
                          : esc(m.author?.display_name || "Unknown")}
          ${(m.reviewers || []).length ? `<div class="mp-meta">${plural(m.reviewers.length, "reviewer")}</div>` : ""}
      </td>
      <td>${statusBadge(m)}</td>
      <td class="num" title="Opened ${esc(absolute(m.created_at))}">${days(m.age_days)}</td>
      <td class="num" title="${m.updated_at ? `Last activity ${esc(absolute(m.updated_at))}` : "No activity recorded"}">${days(m.inactive_days)}</td>
      <td><div class="badge-row">${flagBadges(m, staleDays) || `<span class="mp-meta">—</span>`}</div></td>
    </tr>`).join("")
    : `<tr><td colspan="6" class="empty">No merge proposals match these filters.</td></tr>`;

  const chip = (key, label, count, pressed) =>
    `<button type="button" class="chip" data-chip="${esc(key)}" aria-pressed="${pressed}">
       ${esc(label)}<span class="chip__count">${count}</span></button>`;

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
             placeholder="Filter by title, author, branch or bug…"
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
          ${head("author", "Author")}
          ${head("status", "Status")}
          ${head("age_days", "Age")}
          ${head("inactive_days", "Idle")}
          <th scope="col">Flags</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function wireRepoPanel(panel, repo, doc) {
  const rerender = () => {
    panel.innerHTML = repoPanel(repo, doc);
    wireRepoPanel(panel, repo, doc);
  };

  const input = panel.querySelector('[data-filter="q"]');
  if (input) {
    input.addEventListener("input", (e) => {
      state.filters[repo.id].q = e.target.value;
      const pos = e.target.selectionStart;
      rerender();
      const next = panel.querySelector('[data-filter="q"]');
      next.focus();
      next.setSelectionRange(pos, pos);
    });
  }

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

  panel.querySelectorAll("[data-sort]").forEach((th) => {
    const go = () => {
      const key = th.dataset.sort;
      const s = state.sort[repo.id];
      // Text sorts read best ascending first; numeric ones descending first.
      if (s.key === key) s.dir = s.dir === "asc" ? "desc" : "asc";
      else { s.key = key; s.dir = (key === "age_days" || key === "inactive_days") ? "desc" : "asc"; }
      rerender();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
}

function render(doc) {
  state.doc = doc;
  document.getElementById("loading")?.remove();

  for (const r of doc.repositories) {
    state.filters[r.id] ??= { q: "", statuses: new Set(), flags: new Set() };
    state.sort[r.id] ??= { key: "inactive_days", dir: "desc" };
  }
  if (state.activeTab !== "overview" && !doc.repositories.some((r) => r.id === state.activeTab)) {
    state.activeTab = "overview";
  }

  renderBanners(doc);
  renderTabs(doc);

  const panels = document.getElementById("panels");
  panels.innerHTML = `<section class="panel" role="tabpanel" data-panel="overview"
      id="panel-overview" aria-labelledby="tab-overview"></section>` +
    doc.repositories.map((r) => `<section class="panel" role="tabpanel" data-panel="${esc(r.id)}"
      id="panel-${esc(r.id)}" aria-labelledby="tab-${esc(r.id)}" hidden></section>`).join("");

  panels.querySelector('[data-panel="overview"]').innerHTML = overviewPanel(doc);
  for (const r of doc.repositories) {
    const panel = panels.querySelector(`[data-panel="${CSS.escape(r.id)}"]`);
    panel.innerHTML = repoPanel(r, doc);
    wireRepoPanel(panel, r, doc);
  }

  selectTab(state.activeTab);
  updateClocks();

  document.getElementById("footer-meta").textContent =
    `Schema v${doc.schema_version} · stale after ${doc.config.stale_after_days} days · ` +
    `silent after ${doc.config.silent_after_days} days · ` +
    `refreshes every ${doc.config.refresh_interval_minutes} minutes`;
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
  const mins = state.doc?.config?.refresh_interval_minutes || 120;
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

const hash = location.hash.slice(1);
if (hash) state.activeTab = hash;

initTheme();
document.getElementById("refresh-btn").addEventListener("click", () => load({ manual: true }));
await load();
scheduleRefresh();
state.clockTimer = setInterval(updateClocks, 60000);
