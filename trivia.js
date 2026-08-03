// ===========================================================================
// LS Trivia - trivia.js
// Host-authoritative live quiz. Host presents & controls (not scored); players
// answer on their own devices. Speed-based scoring feeds the shared leaderboard.
// Answers stay OFF players' machines: only the host imports the question bank;
// players receive just the question + choices via the database, never the key.
// Data under trivia/{code}/ ; scores under lb/{scope}/{eid} (same as the others).
// ===========================================================================
import { auth, db } from "./firebase-config.js";
import { signInAnonymously, onAuthStateChanged } from
  "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  ref, set, update, get, onValue, push, remove, onDisconnect, off, runTransaction
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const $ = (id) => document.getElementById(id);
const show = (s) => { document.querySelectorAll(".screen").forEach(x => x.classList.remove("active")); $(s).classList.add("active"); };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- sound ----------------------------------------------------------------
const Sound = (() => {
  let ctx, muted = localStorage.getItem("triv_muted") === "1";
  const ensure = () => { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (ctx && ctx.state === "suspended") ctx.resume(); };
  const beep = (f, s, d, t = "sine", g = 0.12) => { if (muted || !ctx) return; const o = ctx.createOscillator(), gn = ctx.createGain(); o.type = t; o.frequency.value = f; o.connect(gn); gn.connect(ctx.destination); const at = ctx.currentTime + s; gn.gain.setValueAtTime(0.0001, at); gn.gain.linearRampToValueAtTime(g, at + .012); gn.gain.exponentialRampToValueAtTime(.0001, at + d); o.start(at); o.stop(at + d + .03); };
  const seq = (n) => { ensure(); n.forEach(x => beep(x.f, x.t, x.d, x.type, x.g)); };
  return {
    ensure, toggle() { muted = !muted; localStorage.setItem("triv_muted", muted ? "1" : "0"); return muted; }, isMuted() { return muted; },
    q() { seq([{ f: 620, t: 0, d: .1 }, { f: 820, t: .08, d: .1 }]); },
    tap() { seq([{ f: 520, t: 0, d: .05, g: .09 }]); },
    right() { seq([{ f: 660, t: 0, d: .1 }, { f: 990, t: .1, d: .16 }]); },
    wrong() { seq([{ f: 300, t: 0, d: .18, type: "sawtooth", g: .08 }]); },
    end() { seq([{ f: 523, t: 0, d: .13 }, { f: 659, t: .12, d: .13 }, { f: 784, t: .24, d: .13 }, { f: 1046, t: .36, d: .3 }]); },
  };
})();
document.addEventListener("click", () => Sound.ensure(), { once: true });

// ---- state ----------------------------------------------------------------
let ME, ROOM, IS_HOST = false, meta = null, players = {}, listeners = [];
let myAnswer = null, hostTimer = null, revealing = false, finalizing = false;
let TRIVIA = null, CATEGORIES = null, contentLoaded = false; // host-only content
let lastQid = "", soundState = "";

// ---- auth -----------------------------------------------------------------
onAuthStateChanged(auth, (u) => { if (u) { ME = u.uid; offerRejoin(); } });
signInAnonymously(auth).catch((e) => { $("join-error").textContent = "Couldn't connect to the server. (" + e.code + ")"; });

// ---- EID gate (format not revealed): VS + 5 digits, or MLG + 4 digits ------
const EID_RE = /^(VS\d{5}|MLG\d{4}|A\d{4}|INT\d{4})$/;
function getEid() { const raw = ($("eid").value || "").trim().toUpperCase(); if (!EID_RE.test(raw)) { $("join-error").textContent = "Enter a valid Employee ID to play."; return null; } return raw; }
function getName() { const n = ($("name").value || "").trim(); if (!n) $("join-error").textContent = "Enter your name first."; return n; }

// ---- leaderboard (period buckets; byGame.trivia) --------------------------
function weekKey(ts) { const dt = new Date(ts); const u = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate())); const day = u.getUTCDay() || 7; u.setUTCDate(u.getUTCDate() + 4 - day); const y = new Date(Date.UTC(u.getUTCFullYear(), 0, 1)); const wk = Math.ceil((((u - y) / 86400000) + 1) / 7); return u.getUTCFullYear() + "-W" + String(wk).padStart(2, "0"); }
function periodKeys(ts) { const d = new Date(ts); const year = String(d.getFullYear()); const month = year + "-" + String(d.getMonth() + 1).padStart(2, "0"); return ["all", year, month, weekKey(ts)]; }
async function addToLeaderboard(eid, name, points, won) {
  if (!eid) return; const now = Date.now();
  for (const scope of periodKeys(now)) {
    try {
      await runTransaction(ref(db, `lb/${scope}/${eid}`), (cur) => {
        cur = cur || { name, points: 0, wins: 0, games: 0, byGame: {} };
        cur.points = (cur.points || 0) + points; cur.wins = (cur.wins || 0) + (won ? 1 : 0); cur.games = (cur.games || 0) + 1;
        cur.byGame = cur.byGame || {}; cur.byGame.trivia = (cur.byGame.trivia || 0) + points;
        cur.name = name || cur.name; cur.ts = now; return cur;
      });
    } catch {}
  }
}

// ---- helpers --------------------------------------------------------------
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
function pickN(arr, n) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); }

// host loads the question bank on demand (never on players)
async function loadContent() {
  if (contentLoaded) return true;
  try { const m = await import("./trivia-content.js?v=1"); TRIVIA = m.TRIVIA; CATEGORIES = m.CATEGORIES; contentLoaded = true; return true; }
  catch (e) { alert("Could not load the question bank."); return false; }
}
function poolForLevel(level, category) {
  const cats = (category && category !== "mixed") ? [category] : CATEGORIES;
  const ids = [];
  cats.forEach((cat) => { const arr = (TRIVIA[cat] && TRIVIA[cat][level]) || []; arr.forEach((_, i) => ids.push(cat + "|" + level + "|" + i)); });
  return ids;
}
function lookupQ(qid) { const [cat, lvl, idx] = qid.split("|"); return (TRIVIA[cat] && TRIVIA[cat][lvl] && TRIVIA[cat][lvl][Number(idx)]) ? { ...TRIVIA[cat][lvl][Number(idx)], cat, qid } : null; }

// ---- create / join --------------------------------------------------------
$("btn-create").addEventListener("click", async () => {
  const name = getName(); if (!name) return; const eid = getEid(); if (!eid) return;
  const code = makeCode();
  try {
    await set(ref(db, `trivia/${code}/meta`), {
      hostUid: ME, level: Number($("opt-level").value), category: $("opt-cat").value,
      qCount: Number($("opt-count").value), questionSeconds: Number($("opt-time").value),
      state: "lobby", qIndex: -1, currentQ: null, reveal: null, usedQ: [], createdAt: Date.now(),
    });
    await joinRoom(code, name, eid);
  } catch (e) { $("join-error").textContent = "Could not create the game (" + (e.code || e.message) + ")."; }
});
$("btn-join").addEventListener("click", async () => {
  const name = getName(); if (!name) return; const eid = getEid(); if (!eid) return;
  const code = ($("join-code").value || "").trim().toUpperCase();
  if (code.length !== 4) { $("join-error").textContent = "Enter the 4-letter room code."; return; }
  const snap = await get(ref(db, `trivia/${code}/meta`));
  if (!snap.exists()) { $("join-error").textContent = "No game found with that code."; return; }
  await joinRoom(code, name, eid);
});
async function joinRoom(code, name, eid) {
  $("join-error").textContent = ""; ROOM = code;
  const pRef = ref(db, `trivia/${code}/players/${ME}`);
  const existing = await get(pRef);
  const metaSnap = await get(ref(db, `trivia/${code}/meta`));
  IS_HOST = metaSnap.val().hostUid === ME;
  await update(pRef, { name, eid, connected: true, isHost: IS_HOST, score: existing.exists() ? (existing.val().score || 0) : 0, joinedAt: existing.exists() ? existing.val().joinedAt : Date.now() });
  onDisconnect(pRef).update({ connected: false });
  localStorage.setItem("triv_last", JSON.stringify({ code, name, eid }));
  if (IS_HOST) await loadContent();
  attachListeners(code);
}
async function offerRejoin() {
  try {
    const last = JSON.parse(localStorage.getItem("triv_last") || "null"); if (!last) return;
    const snap = await get(ref(db, `trivia/${last.code}/meta`)); if (!snap.exists()) { localStorage.removeItem("triv_last"); return; }
    const h = $("rejoin-hint"); h.style.display = "block"; h.innerHTML = `Rejoin game <b>${esc(last.code)}</b> as <b>${esc(last.name)}</b>? `;
    const b = document.createElement("button"); b.className = "btn-ghost mini"; b.textContent = "Rejoin";
    b.onclick = () => { $("name").value = last.name; if (last.eid) $("eid").value = last.eid; joinRoom(last.code, last.name, last.eid); }; h.appendChild(b);
  } catch {}
}

// ---- listeners ------------------------------------------------------------
function attachListeners(code) {
  detach();
  const m = ref(db, `trivia/${code}/meta`); onValue(m, s => { meta = s.val(); if (meta) { IS_HOST = meta.hostUid === ME; onMeta(); } }); listeners.push(m);
  const p = ref(db, `trivia/${code}/players`); onValue(p, s => { players = s.val() || {}; onPlayers(); }); listeners.push(p);
}
function detach() { listeners.forEach(r => off(r)); listeners = []; stopHostTimer(); }
function stopHostTimer() { if (hostTimer) { clearInterval(hostTimer); hostTimer = null; } }

// ---- meta / render --------------------------------------------------------
function onMeta() {
  if (!meta) return;
  if (meta.state === "lobby") {
    show("screen-lobby"); $("lobby-code").textContent = ROOM; $("lobby-sub").textContent = lobbyLabel();
    renderHowto(); $("btn-start").style.display = IS_HOST ? "block" : "none"; $("lobby-hint").style.display = IS_HOST ? "none" : "block";
  } else if (meta.state === "done") {
    show("screen-done"); renderScoreboard($("done-board"), true);
    $("btn-again").style.display = IS_HOST ? "block" : "none"; $("done-hint").textContent = IS_HOST ? "" : "Waiting for the host…";
    if (soundState !== "done") { soundState = "done"; Sound.end(); }
  } else { // playing or reveal
    show("screen-game"); renderGame();
    if (meta.state === "playing" && meta.currentQ && meta.currentQ.qid !== lastQid) { lastQid = meta.currentQ.qid; myAnswer = null; if (!IS_HOST) Sound.q(); soundState = ""; }
  }
  if (IS_HOST && (meta.state === "playing")) { startHostTimer(); } else { stopHostTimer(); }
}
function onPlayers() { if (meta && meta.state === "lobby") renderLobbyPlayers(); if (meta && (meta.state === "playing" || meta.state === "reveal") && IS_HOST) renderHostDash(); if (IS_HOST && meta && meta.state === "playing") checkAllAnswered(); }

const lobbyLabel = () => { const lv = meta.level, ct = meta.category === "mixed" ? "Mixed categories" : meta.category; return `${ct} · Level ${lv} · ${meta.qCount} questions`; };
function renderHowto() {
  $("howto-list").innerHTML = [
    "The host runs the questions. Each one appears with four choices and a countdown.",
    "Tap your answer fast — the quicker you lock in a correct answer, the more points you earn.",
    "After each question the correct answer is revealed with the running scoreboard.",
    "Highest total after all questions wins. Your points also feed the games leaderboard.",
  ].map(t => `<li>${esc(t)}</li>`).join("");
}
function renderLobbyPlayers() {
  const ll = $("lobby-players"); if (!ll) return;
  const e = Object.entries(players);
  ll.innerHTML = e.map(([, p]) => `<li><span class="dot ${p.connected ? "" : "off"}"></span><span>${esc(p.name)}</span>${p.isHost ? '<span class="badge">HOST</span>' : ""}</li>`).join("");
  $("lobby-count").textContent = `${e.length} player${e.length !== 1 ? "s" : ""}`;
}

// ---- game render ----------------------------------------------------------
function renderGame() {
  const q = meta.currentQ; const revealed = meta.state === "reveal" && meta.reveal;
  $("q-progress").textContent = `Q${(meta.qIndex || 0) + 1} / ${meta.qCount}`;
  $("q-category").textContent = q ? q.category : "";
  $("q-text").textContent = q ? q.q : "";
  $("host-controls").style.display = IS_HOST ? "flex" : "none";
  $("host-dash").style.display = IS_HOST ? "block" : "none";
  $("player-note").style.display = IS_HOST ? "none" : "block";
  // countdown
  const cd = $("countdown");
  if (q && meta.state === "playing") { const left = Math.max(0, Math.ceil((q.endsAt - Date.now()) / 1000)); cd.textContent = left + "s"; cd.style.display = "block"; }
  else cd.style.display = "none";
  // choices
  const wrap = $("choices"); wrap.innerHTML = "";
  const letters = ["A", "B", "C", "D"];
  (q ? q.choices : []).forEach((choice, i) => {
    const b = document.createElement("button"); b.className = "choice";
    b.innerHTML = `<span class="cl">${letters[i]}</span><span class="ct">${esc(choice)}</span>`;
    if (revealed) {
      if (i === meta.reveal.correctIndex) b.classList.add("correct");
      if (!IS_HOST && myAnswer && myAnswer.choice === i && i !== meta.reveal.correctIndex) b.classList.add("wrong");
    } else if (IS_HOST) {
      // host sees the correct one marked (to read it out) once content is known
      const full = lookupQ(q.qid); if (full && i === full.c) b.classList.add("host-key");
    } else if (myAnswer && myAnswer.choice === i) { b.classList.add("chosen"); }
    if (!IS_HOST && meta.state === "playing" && !myAnswer) b.addEventListener("click", () => submitAnswer(i));
    else b.disabled = true;
    wrap.appendChild(b);
  });
  // status line
  let msg = "";
  if (!IS_HOST) {
    if (meta.state === "playing") msg = myAnswer ? "Answer locked in — waiting for others…" : "Pick an answer!";
    else if (revealed) { const right = myAnswer && myAnswer.choice === meta.reveal.correctIndex; msg = myAnswer ? (right ? "✅ Correct!" : "❌ Not this time") : "⏱️ No answer"; if (soundState !== "rev") { soundState = "rev"; right ? Sound.right() : Sound.wrong(); } }
  } else { msg = meta.state === "reveal" ? "Answer revealed — review the board, then Next." : "Players are answering…"; }
  $("status-line").textContent = msg;
  // reveal scoreboard (compact)
  if (meta.state === "reveal") { $("mini-board").style.display = "block"; renderScoreboard($("mini-board"), false); } else $("mini-board").style.display = "none";
  // host buttons
  if (IS_HOST) { $("btn-reveal").style.display = meta.state === "playing" ? "inline-block" : "none"; $("btn-next").style.display = meta.state === "reveal" ? "inline-block" : "none"; }
}
function renderHostDash() {
  const list = $("dash-list"); if (!list) return;
  const q = meta.currentQ; const rows = Object.entries(players).filter(([uid, p]) => p && uid !== meta.hostUid);
  const answered = rows.filter(([, p]) => p.answer && q && p.answer.qid === q.qid).length;
  $("dash-count").textContent = `${answered}/${rows.length} answered`;
  const correctIdx = meta.reveal ? meta.reveal.correctIndex : (q ? (lookupQ(q.qid) || {}).c : -1);
  list.innerHTML = rows.map(([uid, p]) => {
    const a = p.answer && q && p.answer.qid === q.qid ? p.answer : null;
    let tag = a ? "answered" : "…";
    if (meta.state === "reveal" && a) tag = a.choice === correctIdx ? "✅" : "❌";
    return `<div class="dash-row"><span class="dot ${p.connected ? "" : "off"}"></span><span class="dr-name">${esc(p.name)}</span><span class="dr-score">${p.score || 0}</span><span class="dr-tag">${tag}</span></div>`;
  }).join("") || `<div class="dash-empty">No players yet.</div>`;
}
function renderScoreboard(el, big) {
  const rows = Object.entries(players).filter(([uid, p]) => p && uid !== meta.hostUid).map(([, p]) => p).sort((a, b) => (b.score || 0) - (a.score || 0));
  const medals = ["🥇", "🥈", "🥉"];
  el.innerHTML = rows.map((p, i) => `<div class="sb-row ${big && i === 0 ? "sb-top" : ""}"><span class="sb-rank">${i < 3 ? medals[i] : i + 1}</span><span class="sb-name">${esc(p.name)}</span><span class="sb-pts">${p.score || 0}</span></div>`).join("") || `<div class="dash-empty">No scores.</div>`;
}

function submitAnswer(i) {
  if (IS_HOST || !meta || meta.state !== "playing" || myAnswer) return;
  const q = meta.currentQ; if (!q) return;
  myAnswer = { qid: q.qid, choice: i, at: Date.now() };
  Sound.tap();
  update(ref(db, `trivia/${ROOM}/players/${ME}`), { answer: myAnswer });
  renderGame();
}

// ---- host: flow -----------------------------------------------------------
$("btn-start").addEventListener("click", async () => {
  if (!IS_HOST) return;
  const nonHost = Object.entries(players).filter(([uid, p]) => p.connected && uid !== meta.hostUid).length;
  if (nonHost < 1) { alert("Need at least 1 player (besides the host) to start."); return; }
  if (!(await loadContent())) return;
  finalizing = false; await drawNext(true);
});
$("btn-reveal").addEventListener("click", () => { if (IS_HOST) doReveal(); });
$("btn-next").addEventListener("click", () => { if (IS_HOST) advance(); });
$("btn-again").addEventListener("click", async () => { if (!IS_HOST) return; if (!(await loadContent())) return; finalizing = false; await update(ref(db, `trivia/${ROOM}/meta`), { qIndex: -1 }); await drawNext(true); });

function usedList() { const u = meta && meta.usedQ; return Array.isArray(u) ? u.slice() : (u ? Object.values(u) : []); }
async function drawNext(first) {
  revealing = false;
  const level = meta.level, category = meta.category;
  const pool = poolForLevel(level, category);
  let used = usedList();
  let avail = pool.filter((id) => !used.includes(id));
  if (avail.length === 0) { used = []; avail = pool.slice(); } // pool exhausted -> reset (no repeats until then)
  const qid = avail[Math.floor(Math.random() * avail.length)];
  used.push(qid);
  const full = lookupQ(qid);
  const qIndex = first ? 0 : (meta.qIndex || 0) + 1;
  // clear players' previous answers
  const clear = {}; Object.keys(players).forEach(uid => { clear[`trivia/${ROOM}/players/${uid}/answer`] = null; });
  if (Object.keys(clear).length) await update(ref(db), clear);
  const now = Date.now();
  await update(ref(db, `trivia/${ROOM}/meta`), {
    state: "playing", qIndex, usedQ: used, reveal: null,
    currentQ: { qid, category: full.cat, q: full.q, choices: full.a, startedAt: now, endsAt: now + (meta.questionSeconds || 20) * 1000 },
  });
}
function startHostTimer() { if (hostTimer) return; hostTimer = setInterval(() => { if (!IS_HOST || !meta || meta.state !== "playing") return; renderGame(); if (meta.currentQ && Date.now() >= meta.currentQ.endsAt) doReveal(); }, 400); }
function checkAllAnswered() {
  if (!IS_HOST || !meta || meta.state !== "playing" || !meta.currentQ) return;
  const rows = Object.entries(players).filter(([uid, p]) => p && uid !== meta.hostUid && p.connected);
  if (rows.length && rows.every(([, p]) => p.answer && p.answer.qid === meta.currentQ.qid)) doReveal();
}
async function doReveal() {
  if (!IS_HOST || revealing || !meta || meta.state !== "playing" || !meta.currentQ) return;
  revealing = true; stopHostTimer();
  const q = meta.currentQ; const full = lookupQ(q.qid); const correctIndex = full ? full.c : 0;
  const secs = (meta.questionSeconds || 20) * 1000;
  const updates = {};
  for (const [uid, p] of Object.entries(players)) {
    if (uid === meta.hostUid || !p.answer || p.answer.qid !== q.qid) continue;
    if (p.answer.choice === correctIndex) {
      const remain = Math.max(0, q.endsAt - p.answer.at);
      const pts = Math.max(10, Math.min(100, Math.round(100 * remain / secs)));
      updates[`trivia/${ROOM}/players/${uid}/score`] = (p.score || 0) + pts;
      updates[`trivia/${ROOM}/players/${uid}/lastPts`] = pts;
    } else { updates[`trivia/${ROOM}/players/${uid}/lastPts`] = 0; }
  }
  if (Object.keys(updates).length) await update(ref(db), updates);
  await update(ref(db, `trivia/${ROOM}/meta`), { state: "reveal", reveal: { qid: q.qid, correctIndex } });
}
async function advance() {
  if (!IS_HOST || !meta) return;
  if ((meta.qIndex || 0) + 1 >= meta.qCount) { await finalize(); return; }
  await drawNext(false);
}
async function finalize() {
  if (finalizing) return; finalizing = true;
  const scorers = Object.entries(players).filter(([uid, p]) => p && uid !== meta.hostUid);
  const top = Math.max(0, ...scorers.map(([, p]) => p.score || 0));
  for (const [, p] of scorers) { if (!p.eid) continue; await addToLeaderboard(p.eid, p.name, p.score || 0, top > 0 && (p.score || 0) === top); }
  await update(ref(db, `trivia/${ROOM}/meta`), { state: "done" });
}

// ---- feedback -------------------------------------------------------------
let fbRating = 0;
const openFb = () => { $("feedback-modal").style.display = "flex"; $("fb-form").style.display = "block"; $("fb-thanks").style.display = "none"; };
const closeFb = () => { $("feedback-modal").style.display = "none"; };
["btn-feedback", "btn-feedback-end"].forEach(id => { const el = $(id); if (el) el.addEventListener("click", openFb); });
$("fb-close").addEventListener("click", closeFb);
$("feedback-modal").addEventListener("click", e => { if (e.target.id === "feedback-modal") closeFb(); });
document.querySelectorAll("#fb-stars span").forEach(s => s.addEventListener("click", () => { fbRating = Number(s.dataset.v); document.querySelectorAll("#fb-stars span").forEach(x => x.classList.toggle("on", Number(x.dataset.v) <= fbRating)); }));
$("fb-send").addEventListener("click", async () => {
  const comment = $("fb-comment").value.trim(); if (!fbRating && !comment) return;
  try { await push(ref(db, "feedback/" + (ROOM || "trivia")), { game: "Trivia", name: (players[ME] && players[ME].name) || "", rating: fbRating || "", comment, gameDate: new Date((meta && meta.createdAt) || Date.now()).toISOString().slice(0, 10), ts: Date.now() }); } catch (e) {}
  $("fb-form").style.display = "none"; $("fb-thanks").style.display = "block"; fbRating = 0; $("fb-comment").value = ""; document.querySelectorAll("#fb-stars span").forEach(x => x.classList.remove("on"));
  setTimeout(closeFb, 1800);
});

// ---- misc -----------------------------------------------------------------
$("btn-copy").addEventListener("click", async () => { const url = `${location.origin}${location.pathname}?room=${ROOM}`; try { await navigator.clipboard.writeText(url); $("btn-copy").textContent = "Copied!"; } catch { prompt("Invite link:", url); } setTimeout(() => ($("btn-copy").textContent = "Copy invite link"), 1500); });
$("btn-mute").addEventListener("click", () => { $("btn-mute").textContent = Sound.toggle() ? "🔇" : "🔊"; });
$("btn-mute").textContent = Sound.isMuted() ? "🔇" : "🔊";
$("btn-home").addEventListener("click", leave); $("btn-leave").addEventListener("click", leave);
async function leave() { if (ROOM && ME) { try { await update(ref(db, `trivia/${ROOM}/players/${ME}`), { connected: false }); } catch {} } detach(); ROOM = null; IS_HOST = false; meta = null; players = {}; myAnswer = null; lastQid = ""; show("screen-join"); }

const params = new URLSearchParams(location.search);
if (params.get("room")) $("join-code").value = params.get("room").toUpperCase();
