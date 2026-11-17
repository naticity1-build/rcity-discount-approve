const cfg = window.DA_CONFIG || {};
const demo = false; // published copy: no demo mode, no sample data
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const toast = (msg) => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2800); };

let sb = null;           // supabase client (real mode)
let state, original;     // current edits / last saved

function demoState() { return null; }
const demoHistory = [];

// ---------------------------------------------------------------- data layer
async function loadState() {
  if (demo) return demoState();
  const q = (t, s = "*") => sb.from(t).select(s);
  const [lev, fam, lim, app, br, sel, set] = await Promise.all([
    q("da_levels").order("level"), q("da_families").order("family"), q("da_family_limits"),
    q("da_approvers").order("level"), q("da_branches").order("code"), q("da_sellers").order("agent_code"), q("da_settings"),
  ]);
  for (const r of [lev, fam, lim, app, br, sel, set]) if (r.error) throw r.error;
  const limits = {};
  for (const r of lim.data) (limits[r.family] ??= {})[r.level] = Number(r.max_pct);
  fam.data.sort((a, b) => (a.family === "*" ? -1 : b.family === "*" ? 1 : a.family.localeCompare(b.family, "he", { numeric: true })));
  return {
    levels: lev.data, families: fam.data, limits, approvers: app.data.map((a) => ({ ...a, branches: a.branches || [] })),
    branches: br.data, sellers: sel.data, settings: Object.fromEntries(set.data.map((r) => [r.key, r.value])),
  };
}

const limitRows = (s) => Object.entries(s.limits).flatMap(([family, lv]) =>
  Object.entries(lv).filter(([, v]) => v !== "" && v !== null && v !== undefined && !Number.isNaN(Number(v)))
    .map(([level, v]) => ({ family, level: Number(level), max_pct: Number(v) })));

async function syncTable(table, rows, oldRows, keyCols) {
  const k = (r) => keyCols.map((c) => r[c]).join("\u0001");
  const keep = new Set(rows.map(k));
  for (const r of oldRows.filter((r) => !keep.has(k(r)))) {
    const m = Object.fromEntries(keyCols.map((c) => [c, r[c]]));
    const { error } = await sb.from(table).delete().match(m);
    if (error) throw error;
  }
  if (rows.length) {
    const { error } = await sb.from(table).upsert(rows, { onConflict: keyCols.join(",") });
    if (error) throw error;
  }
}

async function saveState() {
  if (demo) { await new Promise((r) => setTimeout(r, 300)); return; }
  const s = state, o = original;
  const lvAdd = s.levels.filter((l) => !o.levels.some((x) => x.level === l.level));
  if (lvAdd.length || s.levels.length) {
    const { error } = await sb.from("da_levels").upsert(s.levels, { onConflict: "level" }); if (error) throw error;
  }
  await syncTable("da_families", s.families, o.families, ["family"]);
  await syncTable("da_branches", s.branches, o.branches, ["code"]);
  await syncTable("da_sellers", s.sellers, o.sellers, ["agent_code"]);
  await syncTable("da_approvers", s.approvers.map((a) => ({ ...a, branches: a.branches.length ? a.branches : null })), o.approvers, ["id"]);
  await syncTable("da_family_limits", limitRows(s), limitRows(o), ["family", "level"]);
  await syncTable("da_settings", Object.entries(s.settings).map(([key, value]) => ({ key, value })),
    Object.entries(o.settings).map(([key, value]) => ({ key, value })), ["key"]);
  // levels last: removing a level fails while approvers still point at it
  for (const l of o.levels.filter((l) => !s.levels.some((x) => x.level === l.level))) {
    const { error } = await sb.from("da_levels").delete().eq("level", l.level); if (error) throw error;
  }
}

async function adminAction(action, payload = {}) {
  if (demo) { await new Promise((r) => setTimeout(r, 300)); return { ok: true, demo: true, count: 0 }; }
  const { data, error } = await sb.functions.invoke("discount-admin", { body: { action, ...payload } });
  if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error || error.message);
  return data;
}

async function loadHistory(status) {
  if (demo) return demoHistory.filter((r) => !status || r.status === status);
  let q = sb.from("da_requests").select("*").order("created_at", { ascending: false }).limit(200);
  if (status) q = q.eq("status", status);
  const { data, error } = await q; if (error) throw error;
  return data;
}

// ---------------------------------------------------------------- dirty tracking
function markDirty() {
  const dirty = JSON.stringify(state) !== JSON.stringify(original);
  $("dirty").classList.toggle("hidden", !dirty);
  $("save").disabled = !dirty;
}
window.addEventListener("beforeunload", (e) => { if (!$("save").disabled) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------- renderers
const levelName = (n) => state.levels.find((l) => l.level === n)?.name ?? `דרג ${n}`;

function effective(family, level) {
  const v = state.limits[family]?.[level];
  if (v !== undefined && v !== "" && v !== null) return Number(v);
  const d = state.limits["*"]?.[level];
  return d === undefined || d === "" ? undefined : Number(d);
}

function renderLimits() {
  const lv = state.levels.map((l) => l.level).filter((l) => l > 0);
  const head = `<tr><th>קוד</th><th>משפחה</th>${lv.map((l) => `<th>${l === 0 ? "מוכר לבד" : esc(levelName(l))} עד %</th>`).join("")}<th></th></tr>`;
  const rows = state.families.map((f, i) => {
    const isDef = f.family === "*";
    const cells = lv.map((l) => {
      const own = state.limits[f.family]?.[l];
      const def = state.limits["*"]?.[l];
      const bad = !isDef && lv.some((x) => x < l && effective(f.family, x) > effective(f.family, l));
      return `<td><input class="pct num" inputmode="decimal" data-fam="${esc(f.family)}" data-level="${l}"
        value="${own ?? ""}" placeholder="${isDef ? "" : def ?? ""}" ${bad ? 'style="border-color:var(--bad)"' : ""}
        aria-label="${esc(f.description)} ${l === 0 ? "מוכר" : esc(levelName(l))}"></td>`;
    }).join("");
    return `<tr class="${isDef ? "default-row" : ""}">
      <td class="num">${isDef ? "★" : `<input data-famcode="${i}" value="${esc(f.family)}" style="width:70px">`}</td>
      <td>${isDef ? esc(f.description) : `<input data-famdesc="${i}" value="${esc(f.description)}">`}</td>${cells}
      <td>${isDef ? "" : `<button class="link" data-delfam="${i}" title="מחק">✕</button>`}</td></tr>`;
  }).join("");
  $("limitsTable").innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>
    <tfoot><tr><td colspan="${lv.length + 3}"><button class="link" id="addFamily">+ משפחה</button></td></tr></tfoot>`;
  $("addFamily").onclick = () => { state.families.push({ family: "", description: "", active: true }); renderLimits(); markDirty(); };
}

function renderApprovers() {
  const lvOpts = (sel) => state.levels.map((l) => `<option value="${l.level}" ${l.level === sel ? "selected" : ""}>${l.level} · ${esc(l.name)}</option>`).join("");
  const rows = state.approvers.map((a, i) => `<tr>
    <td><input data-app="${i}" data-k="name" value="${esc(a.name)}"></td>
    <td><input data-app="${i}" data-k="phone" class="num" value="${esc(a.phone)}" placeholder="05X-XXXXXXX" style="min-width:120px"></td>
    <td><select data-app="${i}" data-k="level">${lvOpts(a.level)}</select></td>
    <td><div class="chips">${state.branches.map((b) => `<label><input type="checkbox" data-appbr="${i}" value="${esc(b.code)}" ${a.branches.includes(b.code) ? "checked" : ""}>${esc(b.name)}</label>`).join("")}</div>
      ${a.branches.length ? "" : '<small class="muted">כל הסניפים</small>'}</td>
    <td style="text-align:center"><input type="checkbox" data-app="${i}" data-k="active" ${a.active ? "checked" : ""} style="width:auto" aria-label="פעיל"></td>
    <td><button class="link" data-delapp="${i}" title="מחק">✕</button></td></tr>`).join("");
  $("approversTable").innerHTML = `<thead><tr><th>שם</th><th>טלפון</th><th>דרג</th><th>סניפים</th><th>פעיל</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

function renderLevels() {
  $("levelsTable").innerHTML = `<thead><tr><th>דרג</th><th>שם</th><th>מאשרים</th><th></th></tr></thead><tbody>${
    state.levels.map((l, i) => `<tr><td class="num">${l.level}</td>
      <td><input data-lev="${i}" value="${esc(l.name)}"></td>
      <td>${state.approvers.filter((a) => a.level === l.level).length}</td>
      <td>${l.level === 1 || i !== state.levels.length - 1 ? "" : `<button class="link" data-dellev="${i}">✕</button>`}</td></tr>`).join("")}</tbody>`;
}

function renderPeople() {
  $("branchesTable").innerHTML = `<thead><tr><th>קוד</th><th>שם</th><th></th></tr></thead><tbody>${
    state.branches.map((b, i) => `<tr><td><input data-br="${i}" data-k="code" class="num" value="${esc(b.code)}" style="width:70px"></td>
      <td><input data-br="${i}" data-k="name" value="${esc(b.name)}"></td><td><button class="link" data-delbr="${i}">✕</button></td></tr>`).join("")}</tbody>`;
  $("sellersTable").innerHTML = `<thead><tr><th>קוד סוכן</th><th>שם</th><th>טלפון</th><th></th></tr></thead><tbody>${
    state.sellers.map((s, i) => `<tr><td><input data-sel="${i}" data-k="agent_code" value="${esc(s.agent_code)}" style="width:90px"></td>
      <td><input data-sel="${i}" data-k="name" value="${esc(s.name)}"></td>
      <td><input data-sel="${i}" data-k="phone" class="num" value="${esc(s.phone)}" style="min-width:110px"></td>
      <td><button class="link" data-delsel="${i}">✕</button></td></tr>`).join("") ||
      '<tr><td colspan="4" class="muted">עדיין לא הוגדרו מוכרים</td></tr>'}</tbody>`;
}

const GENERAL = [
  ["link_ttl_minutes", "תוקף קישור אישור (דקות)", "number"],
  ["sms_sender", "שם שולח ב-SMS (עד 11 תווים באנגלית)", "text"],
  ["fallback_phone", "טלפון גיבוי כשאין מאשר מוגדר", "tel"],
  ["exclude_branches", "סניפים בלי בקרה (שירות/חלקים), מופרד בפסיקים", "list"],
  ["approve_page_url", "כתובת עמוד האישור", "url"],
];
function renderGeneral() {
  $("generalForm").innerHTML = GENERAL.map(([k, label, type]) => {
    const v = state.settings[k];
    const val = type === "list" ? (v || []).join(", ") : v ?? "";
    return `<div class="field"><label for="g_${k}">${label}</label>
      <input id="g_${k}" data-set="${k}" data-type="${type}" value="${esc(val)}" ${type === "number" ? 'inputmode="numeric"' : ""}
        class="${type === "tel" || type === "number" || type === "url" ? "num" : ""}"></div>`;
  }).join("");
}

const STATUS = { pending: ["ממתין", "warn"], approved: ["אושר", "ok"], rejected: ["נדחה", "bad"], partial: ["חלקי", "warn"], auto: ["אוטומטי", ""], superseded: ["הוחלף", ""] };
async function renderHistory() {
  try {
    const rows = await loadHistory($("histStatus").value);
    const fmt = (d) => new Date(d).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
    $("historyTable").innerHTML = `<thead><tr><th>מתי</th><th>הזמנה</th><th>סניף</th><th>מוכר</th><th>סכום</th><th>הנחה</th><th>דרג</th><th>מצב</th><th>מי / הערה</th>${demo ? "" : "<th></th>"}</tr></thead><tbody>${
      rows.map((r) => {
        const [label, cls] = STATUS[r.status] ?? [r.status, ""];
        return `<tr><td class="num">${fmt(r.created_at)}</td><td class="num">${esc(r.ordname)}</td><td>${esc(state.branches.find((b) => b.code === r.branch)?.name ?? r.branch)}</td>
          <td>${esc(r.agent_name)}</td><td class="num">₪${Math.round(r.total).toLocaleString("he-IL")}</td><td class="num">${r.lines?.orderPct ?? ""}%</td>
          <td>${r.required_level ? esc(levelName(r.required_level)) : "—"}</td><td><span class="badge ${cls}">${label}</span></td>
          <td>${esc(r.decided_by_name ?? "")}${r.note ? ` <small class="muted">· ${esc(r.note)}</small>` : ""}</td>
          ${demo ? "" : `<td>${r.status === "pending" ? `<button class="link" data-retry="${esc(r.ordname)}">שלח שוב</button>` : ""}</td>`}</tr>`;
      }).join("") || '<tr><td colspan="10" class="muted">אין בקשות</td></tr>'}</tbody>`;
  } catch (e) { toast("שגיאה בטעינת ההיסטוריה: " + e.message); }
}

// ---------------------------------------------------------------- dashboard (control)
function demoDash() { return {}; }

function dashRange() {
  const v = $("dashPeriod").value, now = new Date();
  if (v === "month") return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  if (v === "lastmonth") return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)];
  return [new Date(now.getTime() - Number(v) * 864e5), now];
}

const ilsFmt = (n) => "₪" + Math.round(Number(n) || 0).toLocaleString("he-IL");
const intFmt = (n) => (Number(n) || 0).toLocaleString("he-IL");
const mins = (m) => m == null ? "—" : m < 60 ? `<span class="num">${m}</span> דק׳` : `<span class="num">${(m / 60).toFixed(1)}</span> שע׳`;
const rate = (ok, bad) => { const t = (+ok || 0) + (+bad || 0); return t ? Math.round((+ok / t) * 100) : null; };
const rateCell = (ok, bad) => { const r = rate(ok, bad); return r == null ? "—" : `<span class="${r < 70 ? "rate-low" : ""}">${r}%</span>`; };
const pendCell = (n) => +n ? `<span class="badge warn">${intFmt(n)}</span>` : "0";
function barCell(v, max, label) {
  const w = max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
  return `<div class="barcell" title="${esc(label)}: ${ilsFmt(v)}"><span class="num">${ilsFmt(v)}</span><span class="track"><span class="bar-fill" style="width:${w}%"></span></span></div>`;
}
const emptyRow = (cols) => `<tr><td colspan="${cols}" class="muted">אין נתונים בתקופה הזו</td></tr>`;

async function renderDashboard() {
  try {
    let d;
    if (demo) d = demoDash();
    else {
      const [from, to] = dashRange();
      const { data, error } = await sb.rpc("da_dashboard", { p_from: from.toISOString(), p_to: to.toISOString() });
      if (error) throw error;
      d = data;
    }
    const t = d.totals ?? {};
    const tile = (k, v, s) => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
    $("dashKpis").innerHTML =
      tile("בקשות אישור", `<span class="num">${intFmt(t.requests)}</span>`, `${intFmt(t.lines)} שורות · ${intFmt(t.pending)} ממתינות`) +
      tile("הנחה שאושרה", `<span class="num">${ilsFmt(t.approvedIls)}</span>`, `${intFmt(t.approvedLines)} שורות`) +
      tile("הנחה שנדחתה", `<span class="num">${ilsFmt(t.rejectedIls)}</span>`, `${intFmt(t.rejectedLines)} שורות · שיעור אישור ${rate(t.approvedLines, t.rejectedLines) ?? "—"}%`) +
      tile("ממתין לאישור עכשיו", `<span class="num">${ilsFmt(t.pendingIls)}</span>`, `${intFmt(t.pending)} בקשות פתוחות`) +
      tile("זמן תגובה ממוצע", mins(t.avgMinutes), "מהבקשה עד ההחלטה");

    const ap = d.approvers ?? [], maxA = Math.max(0, ...ap.map((r) => +r.approved_ils));
    $("dashApprovers").innerHTML = `<thead><tr><th>מאשר</th><th>דרג</th><th class="n">קיבל</th><th class="n">טיפל</th><th class="n">ממתין</th>
      <th class="n">שורות אושרו</th><th class="n">שורות נדחו</th><th class="n">שיעור אישור</th><th class="n">הנחה שאישר</th><th class="n">הנחה שדחה</th><th class="n">זמן תגובה</th></tr></thead><tbody>${
      ap.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(levelName(r.level))}</td><td class="n num">${intFmt(r.received)}</td><td class="n num">${intFmt(r.decided)}</td>
        <td class="n num">${pendCell(r.pending)}</td><td class="n num">${intFmt(r.approved_lines)}</td><td class="n num">${intFmt(r.rejected_lines)}</td>
        <td class="n num">${rateCell(r.approved_lines, r.rejected_lines)}</td><td class="n">${barCell(+r.approved_ils, maxA, r.name)}</td>
        <td class="n num">${ilsFmt(r.rejected_ils)}</td><td class="n">${mins(r.avg_minutes)}</td></tr>`).join("") || emptyRow(11)}</tbody>`;

    const brName = (c) => state.branches.find((b) => b.code === c)?.name ?? (c ? "סניף " + c : "");
    const se = d.sellers ?? [], maxS = Math.max(0, ...se.map((r) => +r.approved_ils));
    $("dashSellers").innerHTML = `<thead><tr><th>מוכר</th><th>סניף</th><th class="n">בקשות</th><th class="n">שורות</th><th class="n">אושרו</th><th class="n">נדחו</th>
      <th class="n">שיעור אישור</th><th class="n">הנחה שאושרה</th><th class="n">הנחה שנדחתה</th><th class="n">ממתין</th></tr></thead><tbody>${
      se.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(brName(r.branch))}</td><td class="n num">${intFmt(r.requests)}</td><td class="n num">${intFmt(r.lines)}</td>
        <td class="n num">${intFmt(r.approved_lines)}</td><td class="n num">${intFmt(r.rejected_lines)}</td><td class="n num">${rateCell(r.approved_lines, r.rejected_lines)}</td>
        <td class="n">${barCell(+r.approved_ils, maxS, r.name)}</td><td class="n num">${ilsFmt(r.rejected_ils)}</td><td class="n num">${pendCell(r.pending)}</td></tr>`).join("") || emptyRow(10)}</tbody>`;

    const br = d.branches ?? [], maxB = Math.max(0, ...br.map((r) => +r.approved_ils));
    $("dashBranches").innerHTML = `<thead><tr><th>סניף</th><th class="n">בקשות</th><th class="n">שורות אושרו</th><th class="n">שורות נדחו</th><th class="n">שיעור אישור</th>
      <th class="n">הנחה שאושרה</th><th class="n">הנחה שנדחתה</th></tr></thead><tbody>${
      br.map((r) => `<tr><td>${esc(brName(r.branch))}</td><td class="n num">${intFmt(r.requests)}</td><td class="n num">${intFmt(r.approved_lines)}</td>
        <td class="n num">${intFmt(r.rejected_lines)}</td><td class="n num">${rateCell(r.approved_lines, r.rejected_lines)}</td>
        <td class="n">${barCell(+r.approved_ils, maxB, brName(r.branch))}</td><td class="n num">${ilsFmt(r.rejected_ils)}</td></tr>`).join("") || emptyRow(7)}</tbody>`;
  } catch (e) { toast("שגיאה בטעינת הבקרה: " + e.message); }
}

function renderAll() { renderLimits(); renderApprovers(); renderLevels(); renderPeople(); renderGeneral(); renderDashboard(); markDirty(); }

// ---------------------------------------------------------------- events
document.addEventListener("input", (e) => {
  const t = e.target, d = t.dataset;
  if (d.fam !== undefined) {
    const v = t.value.trim();
    const fam = (state.limits[d.fam] ??= {});
    if (v === "") delete fam[d.level]; else fam[d.level] = Number(v.replace(",", "."));
  } else if (d.famcode !== undefined) {
    const f = state.families[d.famcode], old = f.family; f.family = t.value.trim();
    if (state.limits[old]) { state.limits[f.family] = state.limits[old]; delete state.limits[old]; }
  } else if (d.famdesc !== undefined) state.families[d.famdesc].description = t.value;
  else if (d.app !== undefined) {
    const a = state.approvers[d.app];
    a[d.k] = d.k === "active" ? t.checked : d.k === "level" ? Number(t.value) : t.value;
  } else if (d.appbr !== undefined) {
    const a = state.approvers[d.appbr];
    a.branches = t.checked ? [...new Set([...a.branches, t.value])] : a.branches.filter((b) => b !== t.value);
  } else if (d.lev !== undefined) state.levels[d.lev].name = t.value;
  else if (d.br !== undefined) state.branches[d.br][d.k] = t.value.trim();
  else if (d.sel !== undefined) state.sellers[d.sel][d.k] = t.value.trim();
  else if (d.set !== undefined) {
    state.settings[d.set] = d.type === "number" ? Number(t.value) : d.type === "list"
      ? t.value.split(",").map((s) => s.trim()).filter(Boolean) : t.value.trim();
  } else return;
  markDirty();
});
// re-render where other parts depend on the edit (validation colours, counts, chips)
document.addEventListener("change", (e) => {
  const d = e.target.dataset;
  if (d.fam !== undefined || d.famcode !== undefined) renderLimits();
  if (d.app !== undefined || d.appbr !== undefined) { renderApprovers(); renderLevels(); }
  if (d.lev !== undefined) { renderLimits(); renderApprovers(); }
  if (d.br !== undefined) renderApprovers();
});

document.addEventListener("click", async (e) => {
  const d = e.target.dataset;
  if (d.delfam !== undefined) { const f = state.families.splice(d.delfam, 1)[0]; delete state.limits[f.family]; renderLimits(); }
  else if (d.delapp !== undefined) { state.approvers.splice(d.delapp, 1); renderApprovers(); renderLevels(); }
  else if (d.dellev !== undefined) {
    const l = state.levels[d.dellev];
    if (state.approvers.some((a) => a.level === l.level)) return toast("יש מאשרים בדרג הזה. העבר אותם לדרג אחר קודם.");
    state.levels.splice(d.dellev, 1);
    for (const f of Object.values(state.limits)) delete f[l.level];
    renderAll();
  }
  else if (d.delbr !== undefined) { state.branches.splice(d.delbr, 1); renderPeople(); renderApprovers(); }
  else if (d.delsel !== undefined) { state.sellers.splice(d.delsel, 1); renderPeople(); }
  else if (d.retry !== undefined) {
    try { const r = await adminAction("retry", { ordname: d.retry }); toast(r.result === "sent" ? "נשלח שוב" : r.reason || r.result); }
    catch (err) { toast(err.message); }
    return;
  } else if (d.tab !== undefined) {
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b === e.target));
    document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== d.tab));
    if (d.tab === "history") renderHistory();
    if (d.tab === "dashboard") renderDashboard();
    return;
  } else return;
  markDirty();
});

$("addApprover").onclick = () => { state.approvers.push({ id: crypto.randomUUID(), name: "", phone: "", level: 1, branches: [], active: true }); renderApprovers(); markDirty(); };
$("addLevel").onclick = () => { const n = Math.max(0, ...state.levels.map((l) => l.level)) + 1; state.levels.push({ level: n, name: `דרג ${n}` }); renderAll(); };
$("addBranch").onclick = () => { state.branches.push({ code: "", name: "" }); renderPeople(); markDirty(); };
$("addSeller").onclick = () => { state.sellers.push({ agent_code: "", name: "", phone: "" }); renderPeople(); markDirty(); };
$("refreshHist").onclick = renderHistory;
$("refreshDash").onclick = renderDashboard;
$("dashPeriod").onchange = renderDashboard;
$("histStatus").onchange = renderHistory;

// Israeli mobile: 10 digits starting with 05 (a leading 972 counts as 0). InforU rejects anything else.
const phoneOk = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("972")) d = "0" + d.slice(3); return /^05\d{8}$/.test(d); };
const PHONE_HINT = "צריך 10 ספרות שמתחילות ב-05";

function validate() {
  const lv = state.levels.map((l) => l.level).filter((l) => l > 0);
  if (lv.some((l) => effective("*", l) === undefined)) return "בשורת ברירת המחדל חייב להיות ערך לכל דרג";
  const codes = state.families.map((f) => f.family);
  if (codes.some((c) => !c)) return "יש משפחה בלי קוד";
  if (new Set(codes).size !== codes.length) return "יש קוד משפחה כפול";
  for (const f of state.families) for (const l of lv) {
    const v = effective(f.family, l);
    if (v === undefined || Number.isNaN(v) || v < 0 || v > 100) return `ערך לא תקין במשפחה ${f.family}`;
    if (lv.some((x) => x < l && effective(f.family, x) > v)) return `במשפחה ${f.family || "?"}: דרג גבוה לא יכול לקבל פחות מדרג נמוך`;
  }
  for (const a of state.approvers) {
    if (!a.name.trim()) return "יש מאשר בלי שם";
    if (a.active && !phoneOk(a.phone)) return `הטלפון של ${a.name} לא תקין: ${PHONE_HINT}`;
  }
  if (state.branches.some((b) => !b.code)) return "יש סניף בלי קוד";
  if (state.sellers.some((s) => !s.agent_code || !s.phone)) return "יש מוכר בלי קוד או טלפון";
  const badSeller = state.sellers.find((s) => !phoneOk(s.phone));
  if (badSeller) return `הטלפון של המוכר ${badSeller.name || badSeller.agent_code} לא תקין: ${PHONE_HINT}`;
  const fb = state.settings.fallback_phone;
  if (fb && !phoneOk(fb)) return `טלפון הגיבוי לא תקין: ${PHONE_HINT}`;
  return null;
}

$("save").onclick = async () => {
  const err = validate(); if (err) return toast(err);
  $("save").disabled = true;
  try {
    await saveState();
    original = clone(state); markDirty();
    toast("נשמר");
  } catch (e) { toast("שמירה נכשלה: " + e.message); markDirty(); }
};

$("importFamilies").onclick = async () => {
  if (!$("save").disabled) return toast("שמור קודם את השינויים");
  try { const r = await adminAction("import-families"); toast(demo ? "בהדגמה: כאן ייובאו המשפחות מפריוריטי" : `יובאו ${r.count} משפחות`); if (!demo) await boot(); }
  catch (e) { toast(e.message); }
};
$("testSms").onclick = async () => {
  try { const r = await adminAction("test-sms", { phone: $("testPhone").value }); toast(demo ? "בהדגמה לא נשלח SMS" : r.ok ? "נשלח" : "נכשל: " + JSON.stringify(r.detail)); }
  catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- boot
async function boot() {
  state = await loadState();
  original = clone(state);
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderAll();
}

if (demo) {
  $("demo").classList.remove("hidden");
  boot();
} else {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  sb = createClient(cfg.supabaseUrl, cfg.anonKey);
  const { data } = await sb.auth.getSession();
  const tryBoot = () => boot().catch((e) => toast("אין הרשאה או שגיאה: " + e.message));
  if (data.session) tryBoot(); else $("login").classList.remove("hidden");
  $("login").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value, password: $("password").value });
    if (error) $("loginErr").textContent = "כניסה נכשלה"; else tryBoot();
  };
}
