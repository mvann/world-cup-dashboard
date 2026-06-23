"use strict";

// Auto-refresh the open page so a left-open dashboard keeps current with the
// data the workflow commits every ~20 minutes.
const REFRESH_MS = 60 * 1000;

const KNOCKOUT_STAGES = [
  { key: "LAST_32", title: "Round of 32", count: 16 },
  { key: "LAST_16", title: "Round of 16", count: 8 },
  { key: "QUARTER_FINALS", title: "Quarter-finals", count: 4 },
  { key: "SEMI_FINALS", title: "Semi-finals", count: 2 },
  { key: "THIRD_PLACE", title: "Third place", count: 1 },
  { key: "FINAL", title: "Final", count: 1 },
];

// Rounds that form the single-elimination tree (third place is tucked under the
// final rather than getting its own column).
const TREE_STAGES = KNOCKOUT_STAGES.filter((s) => s.key !== "THIRD_PLACE");

const LIVE_STATUSES = new Set(["IN_PLAY", "PAUSED", "LIVE"]);
const FINISHED_STATUSES = new Set(["FINISHED", "AWARDED"]);

// Persist lightweight view state across reloads.
const LS_TAB = "wc.tab";
const LS_FILTER = "wc.filter";
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

const state = {
  standings: { groups: [] },
  matches: { matches: [] },
  meta: {},
  scheduleFilter: lsGet(LS_FILTER) || "all",
};

/* ---------------- data loading ---------------- */

async function loadJSON(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    const [standings, matches, meta] = await Promise.all([
      loadJSON("./data/standings.json"),
      loadJSON("./data/matches.json"),
      loadJSON("./data/meta.json"),
    ]);
    state.standings = standings || { groups: [] };
    state.matches = matches || { matches: [] };
    state.meta = meta || {};
  } catch (err) {
    console.error("Data load failed", err);
  }
  renderAll();
}

/* ---------------- helpers ---------------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function crestImg(team) {
  if (team && team.crest) {
    return el("img", { class: "crest", src: team.crest, alt: "", loading: "lazy" });
  }
  return el("span", { class: "crest", "aria-hidden": "true" });
}

function isLive(m) { return LIVE_STATUSES.has(m.status); }
function isFinished(m) { return FINISHED_STATUSES.has(m.status); }
function hasScore(m) { return m.score && m.score.home != null && m.score.away != null; }

function fmtDay(d) {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
function fmtTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* ---------------- standings ---------------- */

function renderStandings() {
  const root = document.getElementById("standings");
  root.innerHTML = "";
  const groups = state.standings.groups || [];
  if (!groups.length) {
    root.appendChild(el("div", { class: "empty", text: "Group standings will appear here once the tournament data is available." }));
    return;
  }
  for (const g of groups) {
    const table = el("table");
    const thead = el("tr", {}, [
      el("th", { class: "pos", text: "#" }),
      el("th", { class: "team-cell", text: "Team" }),
      el("th", { text: "P" }),
      el("th", { text: "W" }),
      el("th", { text: "D" }),
      el("th", { text: "L" }),
      el("th", { text: "GD" }),
      el("th", { text: "Pts" }),
    ]);
    const tbody = el("tbody");
    (g.standings || []).forEach((row, i) => {
      const tr = el("tr", { class: i < 2 ? "qualify" : "" }, [
        el("td", { class: "pos", text: String(row.position ?? i + 1) }),
        el("td", { class: "team-cell" }, [crestImg(row), el("span", { class: "name", text: row.team })]),
        el("td", { text: String(row.playedGames) }),
        el("td", { text: String(row.won) }),
        el("td", { text: String(row.draw) }),
        el("td", { text: String(row.lost) }),
        el("td", { text: (row.goalDifference > 0 ? "+" : "") + row.goalDifference }),
        el("td", { class: "pts", text: String(row.points) }),
      ]);
      tbody.appendChild(tr);
    });
    table.appendChild(el("thead", {}, thead));
    table.appendChild(tbody);
    root.appendChild(el("div", { class: "group-card" }, [el("h3", { text: g.name || g.code }), table]));
  }
  root.appendChild(el("div", { class: "legend" }, [
    el("span", { class: "swatch" }), "Top two of each group advance to the knockout stage.",
  ]));
}

/* ---------------- schedule / calendar ---------------- */

function renderScheduleFilters() {
  const root = document.getElementById("schedule-filters");
  root.innerHTML = "";
  const filters = [
    { key: "all", label: "All" },
    { key: "live", label: "Live" },
    { key: "today", label: "Today" },
    { key: "upcoming", label: "Upcoming" },
    { key: "finished", label: "Results" },
  ];
  for (const f of filters) {
    const chip = el("button", {
      class: "chip" + (state.scheduleFilter === f.key ? " active" : ""),
      text: f.label,
    });
    chip.addEventListener("click", () => {
      state.scheduleFilter = f.key;
      lsSet(LS_FILTER, f.key);
      renderScheduleFilters();
      renderSchedule();
    });
    root.appendChild(chip);
  }
}

function matchPassesFilter(m, now) {
  switch (state.scheduleFilter) {
    case "live": return isLive(m);
    case "finished": return isFinished(m);
    case "upcoming": return !isFinished(m) && !isLive(m);
    case "today": {
      if (!m.utcDate) return false;
      const d = new Date(m.utcDate);
      return d.toDateString() === now.toDateString();
    }
    default: return true;
  }
}

function renderSchedule() {
  const root = document.getElementById("schedule");
  root.innerHTML = "";
  const now = new Date();
  const matches = (state.matches.matches || []).filter((m) => matchPassesFilter(m, now));

  if (!matches.length) {
    root.appendChild(el("div", { class: "empty", text: "No matches to show for this filter yet." }));
    return;
  }

  // group by calendar day
  const byDay = new Map();
  for (const m of matches) {
    const key = m.utcDate ? new Date(m.utcDate).toDateString() : "TBD";
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(m);
  }

  for (const [dayKey, dayMatches] of byDay) {
    const heading = dayKey === "TBD" ? "Date to be confirmed" : fmtDay(new Date(dayKey));
    const dayEl = el("div", { class: "day-group" }, [el("h3", { class: "day-heading", text: heading })]);
    for (const m of dayMatches) {
      dayEl.appendChild(renderMatchRow(m));
    }
    root.appendChild(dayEl);
  }
}

function renderMatchRow(m) {
  const live = isLive(m);
  const finished = isFinished(m);
  const showScore = hasScore(m) && (live || finished);

  let timeContent;
  if (live) timeContent = el("span", { class: "badge live", text: "Live" });
  else if (finished) timeContent = el("span", { class: "badge ft", text: "FT" });
  else if (m.utcDate) timeContent = el("span", { text: fmtTime(new Date(m.utcDate)) });
  else timeContent = el("span", { text: "TBD" });

  const homeWin = m.winner === "HOME";
  const awayWin = m.winner === "AWAY";

  const scoreEl = showScore
    ? el("div", { class: "match-score", text: `${m.score.home} – ${m.score.away}` })
    : el("div", { class: "match-score" }, el("span", { class: "vs", text: "v" }));

  const stageLabel = m.groupName || stageTitle(m.stage) || "";

  return el("div", { class: "match-row" + (live ? " is-live" : "") }, [
    el("div", { class: "match-time" }, timeContent),
    el("div", { class: "match-team home" + (homeWin ? " win" : "") }, [
      el("span", { class: "name", text: m.home.name }), crestImg(m.home),
    ]),
    scoreEl,
    el("div", { class: "match-team away" + (awayWin ? " win" : "") }, [
      crestImg(m.away), el("span", { class: "name", text: m.away.name }),
    ]),
    el("div", { class: "match-meta", text: stageLabel }),
  ]);
}

/* ---------------- bracket ---------------- */

function stageTitle(key) {
  const s = KNOCKOUT_STAGES.find((x) => x.key === key);
  return s ? s.title : null;
}

function renderBracket() {
  const root = document.getElementById("bracket");
  root.innerHTML = "";

  const all = state.matches.matches || [];
  const byStage = new Map();
  for (const m of all) {
    if (!byStage.has(m.stage)) byStage.set(m.stage, []);
    byStage.get(m.stage).push(m);
  }
  const stageMatches = (key) =>
    (byStage.get(key) || []).slice().sort(
      (a, b) => (a.utcDate || "").localeCompare(b.utcDate || "") || (a.id || 0) - (b.id || 0)
    );

  // Champion banner above the tree, once the final is decided.
  const finalMatch = stageMatches("FINAL")[0];
  if (finalMatch && isFinished(finalMatch) && finalMatch.winner && finalMatch.winner !== "DRAW") {
    const champ = finalMatch.winner === "HOME" ? finalMatch.home : finalMatch.away;
    root.appendChild(el("div", { class: "champion-card" }, [
      el("div", { class: "trophy", text: "🏆" }),
      el("div", { class: "label", text: "Champions" }),
      el("div", { class: "name", text: champ.name }),
    ]));
  }

  // Indented tree: the full skeleton is always drawn so the bracket is visible
  // from the start and fills in as teams are placed. The third-place match sits
  // in its own lane between the semi-finals and the final.
  const tree = el("div", { class: "bracket-tree" });
  tree.style.setProperty("--rows", String(TREE_STAGES[0].count));

  const thirdStage = KNOCKOUT_STAGES.find((s) => s.key === "THIRD_PLACE");
  const columns = [
    ...TREE_STAGES.slice(0, 4).map((stage) => ({ stage })), // R32, R16, QF, SF
    { stage: thirdStage, third: true },
    { stage: TREE_STAGES[4] },                              // Final
  ];
  const last = columns.length - 1;

  columns.forEach((cdef, i) => {
    const stage = cdef.stage;
    const isFinal = stage.key === "FINAL";
    const body = el("div", {
      class: "round-body" + (isFinal ? " final-body" : "") + (cdef.third ? " third-body" : ""),
    });
    const matches = stageMatches(stage.key);
    for (let k = 0; k < stage.count; k++) {
      const label = stage.count > 1 ? `${stage.title} · ${k + 1}` : stage.title;
      body.appendChild(bracketSlot(matches[k], label, isFinal, cdef.third));
    }
    const col = el("div", { class: "round-col" }, body);
    // Each column is pushed right by an equal share of the leftover width, so
    // the final lands flush against the right edge.
    col.style.left = `calc((100% - var(--box)) * ${i} / ${last})`;
    tree.appendChild(col);
  });

  root.appendChild(tree);
}

function bracketSlot(m, label, isFinal, isThird) {
  const box = renderBracketMatch(m, isFinal);
  if (isThird) box.classList.add("third-place");
  return el("div", { class: "bracket-slot" }, [
    el("div", { class: "game-label", text: label }),
    box,
  ]);
}

function renderBracketMatch(m, isFinal) {
  const cls = "bracket-match" + (isFinal ? " final" : "");
  if (!m) {
    return el("div", { class: cls }, [bracketTeamRow(null, null, false), bracketTeamRow(null, null, false)]);
  }
  const showScore = hasScore(m) && (isLive(m) || isFinished(m));
  return el("div", { class: cls }, [
    bracketTeamRow(m.home, showScore ? m.score.home : null, m.winner === "HOME"),
    bracketTeamRow(m.away, showScore ? m.score.away : null, m.winner === "AWAY"),
  ]);
}

function bracketTeamRow(team, score, isWinner) {
  if (!team || !team.name || team.name === "TBD") {
    return el("div", { class: "bracket-team tbd" }, [
      el("span", { class: "crest", "aria-hidden": "true" }),
      el("span", { class: "name", text: "TBD" }),
    ]);
  }
  return el("div", { class: "bracket-team" + (isWinner ? " winner" : "") }, [
    crestImg(team),
    el("span", { class: "name", text: team.name }),
    el("span", { class: "sc", text: score == null ? "" : String(score) }),
  ]);
}

/* ---------------- header / meta ---------------- */

function renderMeta() {
  const meta = state.meta || {};
  if (meta.competition) {
    document.getElementById("comp-title").textContent =
      meta.competition + (meta.season ? ` ${meta.season}` : "");
  }

  const dot = document.getElementById("live-dot");
  const label = document.getElementById("updated-label");
  const anyLive = (state.matches.matches || []).some(isLive);

  dot.className = "dot";
  if (anyLive) {
    dot.classList.add("live");
    label.textContent = "Matches in progress";
  } else if (meta.ok && meta.updated) {
    dot.classList.add("ok");
    label.textContent = "Updated " + relativeTime(meta.updated);
  } else if (meta.updated) {
    dot.classList.add("stale");
    label.textContent = "Last data " + relativeTime(meta.updated);
  } else {
    label.textContent = "Awaiting data…";
  }

  const footer = document.getElementById("footer-note");
  footer.textContent = meta.updated
    ? `Last refresh: ${new Date(meta.updated).toLocaleString()}`
    : "Auto-updates every 20 minutes.";
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.round(hr / 24)} d ago`;
}

/* ---------------- wiring ---------------- */

function renderAll() {
  renderMeta();
  renderStandings();
  renderScheduleFilters();
  renderSchedule();
  renderBracket();
}

function activateTab(name) {
  const tabs = [...document.querySelectorAll(".tab")];
  if (!tabs.some((t) => t.dataset.tab === name)) name = "standings";
  tabs.forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const panel = document.getElementById("tab-" + name);
  if (panel) panel.classList.add("active");
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
      lsSet(LS_TAB, tab.dataset.tab);
    });
  });
  // Restore the tab the user was last on.
  activateTab(lsGet(LS_TAB) || "standings");
}

initTabs();
refresh();
setInterval(refresh, REFRESH_MS);
