"use strict";

// Auto-refresh the open page so a left-open dashboard keeps current with the
// data the workflow commits every ~5 minutes.
const REFRESH_MS = 60 * 1000;

const KNOCKOUT_STAGES = [
  { key: "LAST_32", title: "Round of 32", count: 16 },
  { key: "LAST_16", title: "Round of 16", count: 8 },
  { key: "QUARTER_FINALS", title: "Quarter-finals", count: 4 },
  { key: "SEMI_FINALS", title: "Semi-finals", count: 2 },
  { key: "THIRD_PLACE", title: "Third place", count: 1 },
  { key: "FINAL", title: "Final", count: 1 },
];

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
function penScore(m) { const p = m && m.penalties; return p && p.home != null && p.away != null ? p : null; }

function fmtDay(d) {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
function fmtTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Stable per-team key for the #team/<key> route (TLA when available, else name).
function keyOfTeam(team) {
  if (!team || !team.name || team.name === "TBD") return null;
  return team.tla || team.name;
}
function teamMatchesKey(team, key) {
  return !!team && (team.tla === key || team.name === key);
}

// Wrap a team's crest+name in a link to its page (or a plain span when unknown).
function teamLinkEl(key, children, cls) {
  const className = "team-link" + (cls ? " " + cls : "");
  if (!key) return el("span", { class: className }, children);
  return el("a", { class: className, href: "#team/" + encodeURIComponent(key) }, children);
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ---------------- standings ---------------- */

/* ---------------- qualification ---------------- */

// Remaining (not-yet-finished) matches in a group.
function groupRemaining(group) {
  return (state.matches.matches || []).filter((m) => m.groupName === group.name && !isFinished(m));
}

// Teams that have mathematically clinched a top-2 (knockout) spot — brute-forced
// over every remaining result in the group. Points only, and a points tie is
// counted against the team, so we never over-claim. Returns a Set of team keys.
function clinchedTeams(group) {
  const teams = (group.standings || []).map((r) => ({ key: r.tla || r.team, pts: r.points || 0 }));
  // Map any identifier (tla or name) back to a standings key, so a remaining
  // match still resolves even if the API gives a team a tla in one feed but not
  // the other.
  const idx = {};
  for (const r of (group.standings || [])) {
    const k = r.tla || r.team;
    if (r.tla) idx[r.tla] = k;
    if (r.team) idx[r.team] = k;
  }
  const resolve = (t) => (t && (idx[t.tla] || idx[t.name])) || null;
  const rem = groupRemaining(group)
    .map((m) => ({ home: resolve(m.home), away: resolve(m.away) }))
    .filter((x) => x.home && x.away);
  const clinched = new Set(teams.map((t) => t.key));
  const combos = Math.pow(3, rem.length);
  for (let c = 0; c < combos; c++) {
    const pts = {};
    teams.forEach((t) => (pts[t.key] = t.pts));
    let x = c;
    for (let i = 0; i < rem.length; i++) {
      const o = x % 3; x = Math.floor(x / 3);
      if (o === 0) pts[rem[i].home] += 3;
      else if (o === 1) { pts[rem[i].home] += 1; pts[rem[i].away] += 1; }
      else pts[rem[i].away] += 3;
    }
    for (const t of teams) {
      let atOrAbove = 0;
      for (const r of teams) if (r.key !== t.key && pts[r.key] >= pts[t.key]) atOrAbove++;
      if (atOrAbove > 1) clinched.delete(t.key);   // could finish 3rd in this scenario
    }
  }
  return clinched;
}

// Teams already placed into a knockout match (authoritative "through").
function knockoutTeamKeys() {
  const set = new Set();
  for (const m of (state.matches.matches || [])) {
    if (m.stage === "GROUP_STAGE") continue;
    const h = keyOfTeam(m.home), a = keyOfTeam(m.away);
    if (h) set.add(h);
    if (a) set.add(a);
  }
  return set;
}

// A group whose every group-stage match has finished — its final order (and so
// its 3rd-placed team's stats) can no longer change.
function groupComplete(group) {
  const ms = (state.matches.matches || []).filter((m) => m.groupName === group.name);
  return ms.length > 0 && ms.every(isFinished);
}

// 2026 sends the top two of each group PLUS the eight best third-placed teams to
// the Round of 32. Rank every group's current 3rd by points -> GD -> goals; the
// top eight take those spots. Only the thirds from finished groups are returned,
// so we never badge a placing that could still change.
function bestThirdKeys() {
  const thirds = [];
  for (const g of (state.standings.groups || [])) {
    const r = (g.standings || [])[2];
    if (r) thirds.push({ r, done: groupComplete(g) });
  }
  thirds.sort((a, b) =>
    (b.r.points - a.r.points) ||
    (b.r.goalDifference - a.r.goalDifference) ||
    (b.r.goalsFor - a.r.goalsFor));
  return new Set(thirds.slice(0, 8).filter((t) => t.done).map((t) => t.r.tla || t.r.team));
}

function isThroughKey(group, key) {
  return clinchedTeams(group).has(key) || knockoutTeamKeys().has(key) || bestThirdKeys().has(key);
}

// One group's table. currentKey (optional) highlights that team's row — used by
// the team page to show the team in the context of its group.
function groupTableEl(g, currentKey) {
  const letter = g.short || (g.name || "").replace(/^group\s*/i, "") || g.code || "";
  const table = el("table", { class: "standings-table" });
  const thead = el("tr", {}, [
    el("th", { class: "pos", text: "" }),
    el("th", { class: "group-th" }, [
      el("span", { class: "group-letter", text: letter }),
      el("span", { class: "group-tag", text: "Group" }),
    ]),
    el("th", { text: "P" }),
    el("th", { text: "W" }),
    el("th", { text: "D" }),
    el("th", { text: "L" }),
    el("th", { text: "GD" }),
    el("th", { text: "Pts" }),
  ]);
  const keys = (Array.isArray(currentKey) ? currentKey : [currentKey]).filter(Boolean);
  const through = clinchedTeams(g);
  const ko = knockoutTeamKeys();
  const thirds = bestThirdKeys();
  const tbody = el("tbody");
  (g.standings || []).forEach((row, i) => {
    const key = row.tla || row.team;
    const isCurrent = keys.some((k) => row.tla === k || row.team === k);
    const cls = (i < 2 ? "qualify" : "") + (isCurrent ? " current" : "");
    const tr = el("tr", { class: cls.trim() || null }, [
      el("td", { class: "pos", text: String(row.position ?? i + 1) }),
      el("td", { class: "team-cell" }, [
        teamLinkEl(key, [crestImg(row), el("span", { class: "name", text: row.team })]),
        (through.has(key) || ko.has(key) || thirds.has(key))
          ? el("span", { class: "qual-badge", title: "In a knockout-qualifying spot", "aria-label": "Qualified", text: "✓" })
          : null,
      ]),
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
  return el("div", { class: "group" }, [table]);
}

function renderStandings() {
  const root = document.getElementById("standings");
  root.innerHTML = "";
  const groups = state.standings.groups || [];
  if (!groups.length) {
    root.appendChild(el("div", { class: "empty", text: "Group standings will appear here once the tournament data is available." }));
    return;
  }
  for (const g of groups) root.appendChild(groupTableEl(g, null));
  root.appendChild(el("div", { class: "legend" }, [
    el("span", { class: "swatch" }),
    el("span", {}, [
      "The top two of each group, plus the eight best third-placed teams, advance. ",
      el("span", { class: "qual-badge", text: "✓" }),
      " marks a team in a qualifying spot.",
    ]),
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
      location.hash = "#schedule/" + f.key;   // linkable filter (#schedule/live, …)
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

// A chronological match list grouped by calendar day. Shared by the Calendar tab
// and a team's fixtures/results on its page.
function matchListEl(matches) {
  const frag = document.createDocumentFragment();
  const byDay = new Map();
  for (const m of matches) {
    const key = m.utcDate ? new Date(m.utcDate).toDateString() : "TBD";
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(m);
  }
  for (const [dayKey, dayMatches] of byDay) {
    const heading = dayKey === "TBD" ? "Date to be confirmed" : fmtDay(new Date(dayKey));
    const dayEl = el("div", { class: "day-group" }, [el("h3", { class: "day-heading", text: heading })]);
    for (const m of dayMatches) dayEl.appendChild(renderMatchRow(m));
    frag.appendChild(dayEl);
  }
  return frag;
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
  root.appendChild(matchListEl(matches));
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

  const pens = penScore(m);
  const scoreEl = showScore
    ? el("div", { class: "match-score" }, [
        el("div", { text: `${m.score.home} – ${m.score.away}` }),
        pens ? el("div", { class: "pens", text: `${pens.home}–${pens.away} pens` }) : null,
      ])
    : el("div", { class: "match-score" }, el("span", { class: "vs", text: "v" }));

  const stageLabel = m.groupName || stageTitle(m.stage) || "";

  return el("div", {
    class: "match-row" + (live ? " is-live" : ""),
    "data-game": m.id, role: "link", tabindex: "0",
    "aria-label": `View match: ${m.home.name} versus ${m.away.name}`,
  }, [
    el("div", { class: "match-time" }, timeContent),
    el("div", { class: "match-team home" + (homeWin ? " win" : "") }, [
      teamLinkEl(keyOfTeam(m.home), [el("span", { class: "name", text: m.home.name }), crestImg(m.home)]),
    ]),
    scoreEl,
    el("div", { class: "match-team away" + (awayWin ? " win" : "") }, [
      teamLinkEl(keyOfTeam(m.away), [crestImg(m.away), el("span", { class: "name", text: m.away.name })]),
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

  // Six columns, one per stage (R32, R16, QF, SF, third place, final). Each is a
  // simple top-aligned stack of game boxes; the full skeleton renders from the
  // start and fills in as teams advance.
  const grid = el("div", { class: "bracket-grid" });
  for (const stage of KNOCKOUT_STAGES) {
    const col = el("div", { class: "bracket-col" });
    const matches = stageMatches(stage.key);
    for (let k = 0; k < stage.count; k++) {
      const label = stage.count > 1 ? `${stage.title} · ${k + 1}` : stage.title;
      col.appendChild(bracketSlot(matches[k], label, stage.key === "FINAL"));
    }
    grid.appendChild(col);
  }
  root.appendChild(grid);
}

function bracketSlot(m, label, isFinal) {
  return el("div", { class: "bracket-slot" }, [
    el("div", { class: "game-label", text: label }),
    renderBracketMatch(m, isFinal),
  ]);
}

function renderBracketMatch(m, isFinal) {
  const cls = "bracket-match" + (isFinal ? " final" : "");
  if (!m) {
    return el("div", { class: cls }, [bracketTeamRow(null, null, false), bracketTeamRow(null, null, false)]);
  }
  const showScore = hasScore(m) && (isLive(m) || isFinished(m));
  const pens = penScore(m);
  return el("div", {
    class: cls, "data-game": m.id, role: "link", tabindex: "0",
    "aria-label": `View match: ${m.home.name} versus ${m.away.name}`,
  }, [
    bracketTeamRow(m.home, showScore ? m.score.home : null, m.winner === "HOME", pens ? pens.home : null),
    bracketTeamRow(m.away, showScore ? m.score.away : null, m.winner === "AWAY", pens ? pens.away : null),
  ]);
}

function bracketTeamRow(team, score, isWinner, pen) {
  const key = keyOfTeam(team);
  const nameKids = key
    ? [crestImg(team), el("span", { class: "name", text: team.name })]
    : [el("span", { class: "crest", "aria-hidden": "true" }), el("span", { class: "name", text: "TBD" })];
  const scoreText = score == null ? "" : (pen != null ? `${score} (${pen})` : String(score));
  return el("div", { class: "bracket-team" + (key ? "" : " tbd") + (isWinner ? " winner" : "") }, [
    teamLinkEl(key, nameKids),
    el("span", { class: "sc", text: scoreText }),
  ]);
}

/* ---------------- detail pages (team / game) ---------------- */

function currentDetail() {
  const hash = location.hash.replace(/^#/, "");
  let m;
  if ((m = hash.match(/^team\/(.+)$/))) return { type: "team", key: decodeURIComponent(m[1]) };
  if ((m = hash.match(/^game\/(.+)$/))) return { type: "game", key: decodeURIComponent(m[1]) };
  return null;
}

function renderDetail(d) {
  if (d.type === "team") renderTeamView(d.key);
  else renderGameView(d.key);
}

function detailBackLink() {
  const back = el("a", { class: "detail-back", href: "#", text: "← Back" });
  back.addEventListener("click", (e) => {
    e.preventDefault();
    if (history.length > 1) history.back();
    else location.hash = "";
  });
  return back;
}

function clearTabActive() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
  });
}

function renderTeamView(key) {
  const root = document.getElementById("detail-view");
  root.innerHTML = "";
  root.appendChild(detailBackLink());

  // The team in the context of its group (if the group table is loaded).
  let found = null;
  for (const g of (state.standings.groups || [])) {
    const row = (g.standings || []).find((r) => r.tla === key || r.team === key);
    if (row) { found = { row, group: g }; break; }
  }

  // Every match the team appears in, chronological.
  const teamMatches = (state.matches.matches || [])
    .filter((m) => teamMatchesKey(m.home, key) || teamMatchesKey(m.away, key))
    .sort((a, b) => (a.utcDate || "").localeCompare(b.utcDate || "") || (a.id || 0) - (b.id || 0));

  if (!found && !teamMatches.length) {
    root.appendChild(el("div", { class: "empty", text: "No data for this team yet." }));
    return;
  }

  // Resolve display name + crest from standings, falling back to a match entry.
  let name = key, crest = null;
  if (found) {
    name = found.row.team; crest = found.row.crest;
  } else {
    const m0 = teamMatches[0];
    const t = teamMatchesKey(m0.home, key) ? m0.home : m0.away;
    name = t.name; crest = t.crest;
  }

  const metaBits = [];
  if (found) {
    metaBits.push(found.group.name || ("Group " + (found.group.short || "")));
    if (found.row.position != null) metaBits.push(ordinal(found.row.position) + " place");
    metaBits.push(found.row.points + " pts");
    if (isThroughKey(found.group, found.row.tla || found.row.team)) metaBits.push("Through");
  }
  root.appendChild(el("div", { class: "team-head" }, [
    crestImg({ crest }),
    el("div", { class: "team-head-text" }, [
      el("h2", { class: "team-name", text: name }),
      metaBits.length ? el("div", { class: "team-meta", text: metaBits.join(" · ") }) : null,
    ]),
  ]));

  if (found) {
    root.appendChild(el("h3", { class: "section-title", text: "Group" }));
    root.appendChild(groupTableEl(found.group, key));
  }

  root.appendChild(el("h3", { class: "section-title", text: "Matches" }));
  root.appendChild(teamMatches.length
    ? matchListEl(teamMatches)
    : el("div", { class: "empty", text: "No matches scheduled yet." }));
}

function renderGameView(id) {
  const root = document.getElementById("detail-view");
  root.innerHTML = "";
  root.appendChild(detailBackLink());

  const m = (state.matches.matches || []).find((x) => String(x.id) === String(id));
  if (!m) {
    root.appendChild(el("div", { class: "empty", text: "No data for this match yet." }));
    return;
  }

  const live = isLive(m), finished = isFinished(m);
  const showScore = hasScore(m) && (live || finished);
  const d = m.utcDate ? new Date(m.utcDate) : null;

  root.appendChild(el("div", { class: "game-stage", text: m.groupName
    ? m.groupName + (m.matchday ? " · Matchday " + m.matchday : "")
    : (stageTitle(m.stage) || "") }));

  const teamRow = (team, score, win) => el("div", { class: "game-team" + (win ? " win" : "") }, [
    teamLinkEl(keyOfTeam(team), [crestImg(team), el("span", { class: "name", text: team.name })]),
    el("span", { class: "game-score", text: showScore ? String(score) : "" }),
  ]);
  root.appendChild(el("div", { class: "game-head" }, [
    teamRow(m.home, m.score.home, m.winner === "HOME"),
    teamRow(m.away, m.score.away, m.winner === "AWAY"),
  ]));

  const pens = penScore(m);
  if (pens) {
    root.appendChild(el("div", { class: "game-pens", text: `Penalty shootout — ${pens.home}–${pens.away}` }));
  }

  let kickoff;
  if (live) kickoff = "In progress";
  else if (finished) kickoff = "Full time";
  else if (d) kickoff = fmtDay(d) + " · " + fmtTime(d);
  else kickoff = "Date to be confirmed";
  root.appendChild(el("div", { class: "game-status" }, [
    live ? el("span", { class: "badge live", text: "Live" })
      : (finished ? el("span", { class: "badge ft", text: "FT" }) : null),
    el("span", { text: kickoff }),
  ]));

  // Group context for group-stage matches, with both teams highlighted.
  if (m.group) {
    const g = (state.standings.groups || []).find((gr) => gr.code === m.group || gr.name === m.groupName);
    if (g) {
      root.appendChild(el("h3", { class: "section-title", text: "Group" }));
      root.appendChild(groupTableEl(g, [keyOfTeam(m.home), keyOfTeam(m.away)]));
    }
  }
}

// Hash drives every view: #team/<key> and #game/<id> for detail pages,
// #standings/#schedule(/<filter>)/#bracket for tabs, empty for the default tab.
function route() {
  const detail = currentDetail();
  if (detail) {
    document.body.classList.add("viewing-detail");
    clearTabActive();
    renderDetail(detail);
    window.scrollTo(0, 0);
    return;
  }
  document.body.classList.remove("viewing-detail");

  const [seg, sub] = location.hash.replace(/^#/, "").split("/");
  const name = ["standings", "schedule", "bracket"].includes(seg)
    ? seg
    : (lsGet(LS_TAB) || "standings");

  // The Calendar filter lives in the URL too (#schedule/live, #schedule/finished…).
  if (name === "schedule") {
    const filters = ["all", "live", "today", "upcoming", "finished"];
    state.scheduleFilter = filters.includes(sub) ? sub : (lsGet(LS_FILTER) || "all");
    lsSet(LS_FILTER, state.scheduleFilter);
    renderScheduleFilters();
    renderSchedule();
  }
  activateTab(name);
}

/* ---------------- header / meta ---------------- */

function renderMeta() {
  const meta = state.meta || {};
  if (meta.competition) {
    // Drop "FIFA" everywhere; the masthead lowercases what's left. The year is
    // wrapped so it can be scaled down to the height of the lowercase text.
    const name = meta.competition.replace(/\bFIFA\b/gi, "").replace(/\s+/g, " ").trim() || "World Cup";
    const title = document.getElementById("comp-title");
    title.textContent = name;
    if (meta.season) {
      title.appendChild(document.createTextNode(" "));
      title.appendChild(el("span", { class: "title-year", text: String(meta.season) }));
    }
  }

  const dot = document.getElementById("live-dot");
  const label = document.getElementById("updated-label");

  dot.className = "dot";
  if (meta.ok && meta.updated) {
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
    : "Auto-updates every 5 minutes.";
}

// Live matches show as a stacked, blinking ticker top-right of the masthead.
function renderLiveBar() {
  const root = document.getElementById("live-bar");
  if (!root) return;
  root.innerHTML = "";
  const lives = (state.matches.matches || []).filter(isLive);
  for (const m of lives) {
    const middle = hasScore(m) ? `${m.score.home} – ${m.score.away}` : "v";
    root.appendChild(el("a", { class: "live-item", href: "#game/" + encodeURIComponent(m.id) }, [
      el("span", { class: "live-tag", text: "Live" }),
      el("span", { class: "live-match", text: `${m.home.name} ${middle} ${m.away.name}` }),
    ]));
  }
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
  renderLiveBar();
  renderStandings();
  renderScheduleFilters();
  renderSchedule();
  renderBracket();
  // Keep an open detail page in sync with freshly loaded data.
  const d = currentDetail();
  if (d) renderDetail(d);
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
      lsSet(LS_TAB, tab.dataset.tab);
      location.hash = "#" + tab.dataset.tab;   // navigate via the hash so it's linkable
    });
  });
}

initTabs();
// Clicking anywhere in a game element (calendar row, bracket box) opens that
// game's page — unless the click landed on a team link, which wins.
document.addEventListener("click", (e) => {
  if (e.target.closest("a.team-link")) return;
  const g = e.target.closest("[data-game]");
  if (g) location.hash = "#game/" + encodeURIComponent(g.dataset.game);
});
// Keyboard activation when a game container itself is focused (its inner team
// links handle their own Enter natively).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const g = e.target;
  if (g instanceof Element && g.matches("[data-game]")) {
    e.preventDefault();
    location.hash = "#game/" + encodeURIComponent(g.dataset.game);
  }
});
window.addEventListener("hashchange", route);
route();
refresh();
setInterval(refresh, REFRESH_MS);
