/* Leads Dashboard — upload → map columns → publish. Vanilla JS, no build step. */
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n ?? 0).toLocaleString();

let preview = null; // current upload preview awaiting mapping

/* ---------------- upload & mapping flow ---------------- */
$("upload-btn").addEventListener("click", () => {
  $("upload-panel").classList.toggle("hidden");
  showError("");
});
$("dropzone").addEventListener("click", () => $("file-input").click());
$("dropzone").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") $("file-input").click();
});
$("file-input").addEventListener("change", () => {
  if ($("file-input").files[0]) sendFile($("file-input").files[0]);
});
["dragover", "dragleave", "drop"].forEach((ev) =>
  $("dropzone").addEventListener(ev, (e) => {
    e.preventDefault();
    $("dropzone").classList.toggle("over", ev === "dragover");
    if (ev === "drop" && e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
  })
);

function showError(msg) {
  $("upload-error").textContent = msg;
  $("upload-error").classList.toggle("hidden", !msg);
}

async function sendFile(file) {
  showError("");
  const body = new FormData();
  body.append("file", file);
  let res;
  try {
    res = await fetch("/api/uploads/preview", { method: "POST", body });
  } catch {
    return showError("Upload failed — is the server running?");
  }
  if (!res.ok) return showError((await res.json()).detail || "Upload failed");
  preview = await res.json();
  renderMapping();
}

function renderMapping() {
  $("drop-step").classList.add("hidden");
  $("map-step").classList.remove("hidden");
  $("map-meta").textContent =
    `${preview.filename}${preview.sheet ? ` · sheet "${preview.sheet}"` : ""} · ${fmt(preview.row_count)} rows. ` +
    `Match each dashboard field to a column from your file.`;

  const opts = (sel) =>
    `<option value="">— not in this file —</option>` +
    preview.columns.map((c) =>
      `<option value="${esc(c)}"${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");

  $("map-table").innerHTML =
    `<thead><tr><th>Dashboard field</th><th>Column in your file</th></tr></thead><tbody>` +
    Object.entries(preview.fields).map(([f, spec]) =>
      `<tr><td>${esc(spec.label)}${spec.required ? ' <span class="req">*</span>' : ""}</td>
       <td><select data-field="${f}">${opts(preview.suggested_mapping[f])}</select></td></tr>`
    ).join("") + `</tbody>`;

  const cols = preview.columns;
  $("sample-table").innerHTML =
    `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
    preview.sample_rows.map((r) =>
      `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("") + `</tbody>`;
}

$("cancel-btn").addEventListener("click", resetUploadPanel);
function resetUploadPanel() {
  preview = null;
  $("file-input").value = "";
  $("map-step").classList.add("hidden");
  $("drop-step").classList.remove("hidden");
  $("upload-panel").classList.add("hidden");
  showError("");
}

$("commit-btn").addEventListener("click", async () => {
  const mapping = {};
  $("map-table").querySelectorAll("select").forEach((s) => {
    mapping[s.dataset.field] = s.value || null;
  });
  const res = await fetch("/api/uploads/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: preview.token, mapping }),
  });
  if (!res.ok) return showError((await res.json()).detail || "Publish failed");
  const upload = await res.json();
  resetUploadPanel();
  await refreshUploads(upload.id);
  await loadDashboard(upload.id);
});

/* ---------------- upload selector & history ---------------- */
async function refreshUploads(selectId) {
  const uploads = await (await fetch("/api/uploads")).json();
  const sel = $("upload-select");
  sel.innerHTML =
    uploads.map((u) =>
      `<option value="${u.id}">${esc(u.filename)} · ${u.uploaded_at.slice(0, 10)} (${fmt(u.row_count)} rows)</option>`
    ).join("") +
    (uploads.length > 1 ? `<option value="all">All uploads combined (${uploads.length} files)</option>` : "");
  if (selectId) sel.value = selectId;
  sel.classList.toggle("hidden", uploads.length === 0);

  $("uploads-table").innerHTML = uploads.length
    ? `<thead><tr><th>File</th><th>Uploaded</th><th class="num">Rows</th><th></th></tr></thead><tbody>` +
      uploads.map((u) =>
        `<tr><td>${esc(u.filename)}</td><td>${u.uploaded_at.replace("T", " ").slice(0, 16)} UTC</td>
         <td class="num">${fmt(u.row_count)}</td>
         <td><button class="del" data-id="${u.id}">Delete</button></td></tr>`).join("") + `</tbody>`
    : "";
  $("uploads-table").querySelectorAll(".del").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this upload and its leads?")) return;
      await fetch(`/api/uploads/${b.dataset.id}`, { method: "DELETE" });
      await refreshUploads();
      await loadDashboard($("upload-select").value || "latest");
    })
  );
  return uploads;
}

$("upload-select").addEventListener("change", () => loadDashboard($("upload-select").value));

/* ---------------- dashboard rendering ---------------- */
let data = null;

async function loadDashboard(uploadId = "latest") {
  const res = await fetch(`/api/dashboard?upload_id=${encodeURIComponent(uploadId)}`);
  data = await res.json();
  const empty = data.empty;
  $("empty-state").classList.toggle("hidden", !empty);
  $("dashboard").classList.toggle("hidden", empty);
  if (empty) return;

  const k = data.kpis;
  $("range-line").textContent = k.date_from
    ? `Leads created ${k.date_from} to ${k.date_to}` : "";
  $("kpis").innerHTML = [
    ["Total leads", fmt(k.total), "", ""],
    ["Qualified (QL)", fmt(k.ql), `${k.ql_rate}% of leads`, "good"],
    ["Lost", fmt(k.lost), `${k.lost_rate}% of leads`, ""],
    ["Still open", fmt(k.open), `${k.open_rate}% of leads`, ""],
    ["Site visits", fmt(k.visits), "leads with ≥1 visit", ""],
  ].map(([lab, val, sm, cls]) =>
    `<div class="tile"><div class="lab">${lab}</div><div class="val ${cls}">${val}</div><div class="sm">${sm}</div></div>`
  ).join("");

  drawTrend();
  drawSources();
  drawLost();
  renderProjects();
  renderManagers();
  renderCampaigns();
}

const qlChip = (rate) =>
  `<span class="chip ${rate >= 10 ? "hi" : rate >= 5 ? "mid" : "lo"}">${rate}%</span>`;

function renderProjects() {
  $("projects-table").innerHTML =
    `<thead><tr><th>Project</th><th class="num">Leads</th><th class="num">QL</th>
     <th class="num">QL rate</th><th class="num">Open</th><th class="num">Invalid</th>
     <th class="num">Site visits</th></tr></thead><tbody>` +
    data.projects.map((p) =>
      `<tr><td>${esc(p.name)}</td><td class="num">${fmt(p.total)}</td><td class="num">${fmt(p.ql)}</td>
       <td class="num">${qlChip(p.ql_rate)}</td><td class="num">${fmt(p.open)}</td>
       <td class="num">${fmt(p.invalid)}</td><td class="num">${fmt(p.visits)}</td></tr>`).join("") +
    `</tbody>`;
}

function renderManagers() {
  $("managers-table").innerHTML =
    `<thead><tr><th>Manager</th><th class="num">Leads</th><th class="num">QL</th>
     <th class="num">QL rate</th><th class="num">Avg attempts</th><th class="num">Site visits</th></tr></thead><tbody>` +
    data.managers.map((m) =>
      `<tr><td>${esc(m.name)}</td><td class="num">${fmt(m.total)}</td><td class="num">${fmt(m.ql)}</td>
       <td class="num">${qlChip(m.ql_rate)}</td><td class="num">${m.avg_attempts ?? "—"}</td>
       <td class="num">${fmt(m.visits)}</td></tr>`).join("") + `</tbody>`;
}

function renderCampaigns() {
  $("campaigns-table").innerHTML =
    `<thead><tr><th>Campaign</th><th class="num">Leads</th><th class="num">QL</th>
     <th class="num">QL rate</th><th class="num">Invalid rate</th></tr></thead><tbody>` +
    data.campaigns.map((c) =>
      `<tr><td>${esc(c.name)}</td><td class="num">${fmt(c.total)}</td><td class="num">${fmt(c.ql)}</td>
       <td class="num">${qlChip(c.ql_rate)}</td><td class="num">${c.invalid_rate}%</td></tr>`).join("") +
    `</tbody>`;
}

/* ---------------- charts (inline SVG) ---------------- */
function attachTip(box, els, html) {
  const tip = document.createElement("div");
  tip.className = "tip";
  box.appendChild(tip);
  els.forEach((el) => {
    el.addEventListener("mousemove", (e) => {
      tip.style.display = "block";
      tip.innerHTML = html(el);
      const bx = box.getBoundingClientRect();
      let tl = e.clientX - bx.left + 14;
      if (tl + 200 > bx.width) tl -= 220;
      tip.style.left = tl + "px";
      tip.style.top = e.clientY - bx.top - 34 + "px";
    });
    el.addEventListener("mouseleave", () => (tip.style.display = "none"));
  });
  return tip;
}

function niceMax(v) {
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
  return Math.ceil(v / step) * step;
}

function weekLabel(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function drawTrend() {
  const box = $("trend");
  const weeks = data.weekly;
  if (!weeks.length) { box.innerHTML = '<p class="note">No dated leads to plot.</p>'; return; }
  const W = Math.max(560, box.clientWidth), H = 260, m = { t: 14, r: 16, b: 28, l: 44 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(...weeks.map((w) => w.total)));
  const x = (i) => m.l + (weeks.length === 1 ? iw / 2 : iw * i / (weeks.length - 1));
  const y = (v) => m.t + ih * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Weekly leads">`;
  for (let g = 0; g <= max; g += max / 5) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(g)}" y2="${y(g)}" stroke="${css("--grid")}"/>`;
    s += `<text x="${m.l - 8}" y="${y(g) + 4}" text-anchor="end">${Math.round(g)}</text>`;
  }
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="${css("--axis")}"/>`;
  const every = Math.ceil(weeks.length / 8);
  weeks.forEach((w, i) => {
    if (i % every === 0) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${weekLabel(w.week)}</text>`;
  });
  const path = (k) => weeks.map((w, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(w[k]).toFixed(1)}`).join(" ");
  s += `<path d="${path("total")}" fill="none" stroke="${css("--s-blue")}" stroke-width="2" stroke-linejoin="round"/>`;
  s += `<path d="${path("ql")}" fill="none" stroke="${css("--good")}" stroke-width="2" stroke-linejoin="round"/>`;
  const last = weeks.length - 1;
  s += `<circle cx="${x(last)}" cy="${y(weeks[last].total)}" r="4" fill="${css("--s-blue")}" stroke="${css("--surface")}" stroke-width="2"/>`;
  s += `<circle cx="${x(last)}" cy="${y(weeks[last].ql)}" r="4" fill="${css("--good")}" stroke="${css("--surface")}" stroke-width="2"/>`;
  s += `<line id="tr-ch" y1="${m.t}" y2="${m.t + ih}" stroke="${css("--axis")}" visibility="hidden"/>`;
  s += `<rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" id="tr-hit"/></svg>`;
  box.innerHTML = s;
  const tip = document.createElement("div");
  tip.className = "tip";
  box.appendChild(tip);
  const hit = box.querySelector("#tr-hit"), ch = box.querySelector("#tr-ch");
  const svg = box.querySelector("svg");
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(last, Math.round((px - m.l) / (iw / Math.max(last, 1)))));
    ch.setAttribute("x1", x(i)); ch.setAttribute("x2", x(i)); ch.setAttribute("visibility", "visible");
    tip.style.display = "block";
    tip.innerHTML = `<b>Week of ${weekLabel(weeks[i].week)}</b><br>Created: <b>${fmt(weeks[i].total)}</b><br>Qualified: <b>${fmt(weeks[i].ql)}</b>`;
    const bx = box.getBoundingClientRect();
    let tl = e.clientX - bx.left + 14;
    if (tl + 170 > bx.width) tl -= 190;
    tip.style.left = tl + "px"; tip.style.top = e.clientY - bx.top - 14 + "px";
  });
  hit.addEventListener("mouseleave", () => { ch.setAttribute("visibility", "hidden"); tip.style.display = "none"; });
}

function hBarChart(box, rows, opts) {
  // rows: [{label, segs:[{name,val,color}], suffix}]
  const W = Math.max(560, box.clientWidth), rowH = 32;
  const m = { t: 6, r: opts.rightPad ?? 64, l: opts.leftPad ?? 130, b: 24 };
  const H = m.t + rows.length * rowH + m.b, iw = W - m.l - m.r;
  const max = niceMax(Math.max(...rows.map((r) => r.segs.reduce((a, s) => a + s.val, 0))));
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(opts.label)}">`;
  for (let g = 0; g <= max; g += max / 5) {
    const gx = m.l + iw * g / max;
    s += `<line x1="${gx}" x2="${gx}" y1="${m.t}" y2="${H - m.b}" stroke="${css("--grid")}"/>`;
    s += `<text x="${gx}" y="${H - 6}" text-anchor="middle">${Math.round(g)}</text>`;
  }
  rows.forEach((r, ri) => {
    const yy = m.t + ri * rowH, bh = 18;
    let lab = r.label.length > 22 ? r.label.slice(0, 21) + "…" : r.label;
    s += `<text x="${m.l - 10}" y="${yy + bh / 2 + 4}" text-anchor="end" class="dl">${esc(lab)}</text>`;
    let cx = m.l;
    r.segs.forEach((seg, si) => {
      const w = iw * seg.val / max;
      if (w <= 0) return;
      const isLast = si === r.segs.length - 1 || r.segs.slice(si + 1).every((z) => z.val === 0);
      const bw = Math.max(w - 1, 0.5);
      s += isLast
        ? `<path d="M${cx},${yy} h${Math.max(bw - 4, 0)} q4,0 4,4 v${bh - 8} q0,4 -4,4 h${-Math.max(bw - 4, 0)} z" fill="${seg.color}" class="seg" data-row="${esc(r.label)}" data-seg="${esc(seg.name)}" data-v="${seg.val}"/>`
        : `<rect x="${cx}" y="${yy}" width="${bw}" height="${bh}" fill="${seg.color}" class="seg" data-row="${esc(r.label)}" data-seg="${esc(seg.name)}" data-v="${seg.val}"/>`;
      cx += w + 1;
    });
    if (r.suffix) s += `<text x="${cx + 7}" y="${yy + bh / 2 + 4}" class="dl-b">${esc(r.suffix)}</text>`;
  });
  s += `</svg>`;
  box.innerHTML = s;
  attachTip(box, box.querySelectorAll(".seg"),
    (el) => `<b>${el.dataset.row}</b> — ${el.dataset.seg}: <b>${fmt(el.dataset.v)}</b>`);
}

function drawSources() {
  const rows = data.sources.slice(0, 10).map((s) => ({
    label: s.name,
    suffix: `${s.ql_rate}% QL`,
    segs: [
      { name: "Qualified", val: s.ql, color: css("--good") },
      { name: "Open", val: s.open, color: css("--s-blue") },
      { name: "Lost", val: s.lost, color: css("--lost") },
    ],
  }));
  hBarChart($("sources"), rows, { label: "Leads by source", rightPad: 76 });
}

function drawLost() {
  const total = data.lost_reasons.reduce((a, r) => a + r.count, 0);
  const rows = data.lost_reasons.map((r, i) => ({
    label: r.reason,
    suffix: String(r.count),
    segs: [{
      name: `${((100 * r.count) / Math.max(total, 1)).toFixed(1)}% of lost`,
      val: r.count,
      color: i === 0 ? css("--critical") : css("--s-blue"),
    }],
  }));
  hBarChart($("lost"), rows, { label: "Lost leads by reason", leftPad: 180, rightPad: 56 });
}

/* ---------------- init ---------------- */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (data && !data.empty) { drawTrend(); drawSources(); drawLost(); } }, 150);
});
if (window.matchMedia)
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (data && !data.empty) { drawTrend(); drawSources(); drawLost(); }
  });

(async () => {
  const uploads = await refreshUploads();
  if (uploads.length) await loadDashboard(uploads[0].id);
  else {
    $("empty-state").classList.remove("hidden");
    $("upload-panel").classList.remove("hidden");
  }
})();
