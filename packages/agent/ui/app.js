// Plain ES modules, no build step and no framework — the same choice AgentMark
// makes for its UI. The whole app is small enough that a router, a fetch and
// some template literals do the job.

const main = document.getElementById("main")
const title = document.getElementById("title")
const back = document.getElementById("back")
const tabs = document.getElementById("tabs")

const kr = (n) => (n == null ? "—" : `${Math.round(n).toLocaleString("nb-NO")} kr`)
const km = (n) => (n == null ? "—" : `${Math.round(n).toLocaleString("nb-NO")} km`)
const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(0)} %`)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const api = (path) => fetch(path).then((r) => r.json())

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const themeBtn = document.getElementById("theme")
try {
  const saved = localStorage.getItem("theme")
  if (saved) document.documentElement.dataset.theme = saved
} catch {}
themeBtn.onclick = () => {
  const dark = getComputedStyle(document.body).backgroundColor === "rgb(15, 17, 21)"
  const next = dark ? "light" : "dark"
  document.documentElement.dataset.theme = next
  try { localStorage.setItem("theme", next) } catch {}
  if (location.hash.startsWith("#/deal/")) route() // redraw the chart in new colors
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

tabs.onclick = (e) => {
  const button = e.target.closest("button[data-view]")
  if (button) location.hash = `#/${button.dataset.view}`
}
back.onclick = () => history.back()
addEventListener("hashchange", route)

async function route() {
  const hash = location.hash || "#/deals"
  const [, view, arg] = hash.split("/")
  back.hidden = view !== "deal"
  for (const b of tabs.children) b.classList.toggle("active", b.dataset.view === view)
  main.innerHTML = '<p class="empty">Laster…</p>'

  try {
    if (view === "deal") return await viewDeal(Number(arg))
    if (view === "watch") return await viewDeals({ watchOnly: true })
    if (view === "searches") return await viewSearches()
    if (view === "health") return await viewHealth()
    return await viewDeals({})
  } catch (error) {
    main.innerHTML = `<p class="empty">Noe gikk galt: ${esc(error.message)}</p>`
  }
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

async function viewDeals({ watchOnly }) {
  title.textContent = watchOnly ? "Følger" : "Funn"
  const data = await api("/api/deals?limit=60")
  let deals = data.deals.filter((d) => !d.disqualified)
  if (watchOnly) {
    const watched = await api("/api/deals?limit=200")
    deals = watched.deals.filter((d) => d.watched)
  }
  if (deals.length === 0) {
    main.innerHTML = `<p class="empty">${watchOnly ? "Ingen biler følges ennå." : "Ingenting scoret ennå. Kjør <code>./bazaar score</code>."}</p>`
    return
  }
  main.innerHTML = `<div class="cards">${deals.map(card).join("")}</div>`
  for (const el of main.querySelectorAll(".card")) el.onclick = () => (location.hash = `#/deal/${el.dataset.id}`)
}

function card(d) {
  const badges = []
  if (d.residualPct != null)
    badges.push(
      d.residualPct >= 0
        ? `<span class="badge under">${pct(d.residualPct)} under marked</span>`
        : `<span class="badge over">${pct(-d.residualPct)} over marked</span>`,
    )
  // The case the whole project exists for gets its own badge.
  if (d.haggleable) badges.push(`<span class="badge haggle">${kr(d.overBudgetBy)} over — forhandlebart</span>`)
  // A car missing something you said you must have is not a deal at all, so it
  // is called out before price, not after.
  if (d.missingRequired > 0) badges.push(`<span class="badge over">mangler ${d.missingRequired} du må ha</span>`)
  else if (d.requirements?.length) {
    const met = d.requirements.filter((r) => r.status === "ja").length
    if (met > 0) badges.push(`<span class="badge under">${met}/${d.requirements.length} ønsker ✓</span>`)
  }
  if (d.confidence === "low") badges.push('<span class="badge low">usikkert anslag</span>')

  return `<button class="card" data-id="${d.adId}">
    <div class="card-row">
      ${d.thumb ? `<img src="${esc(d.thumb.replace("/dynamic/default/", "/dynamic/480w/"))}" alt="" loading="lazy">` : ""}
      <div class="card-body">
        <span class="score ${d.score >= 8 ? "hot" : ""}">${(d.score ?? 0).toFixed(1)}</span>
        <h3>${esc(d.heading)}</h3>
        <div class="meta">${d.year ?? "—"} · ${km(d.mileage)} · ${esc(d.dealerSegment ?? "")} · ${esc(d.location ?? "")}</div>
        <div class="price">${kr(d.price)}</div>
        ${badges.join("")}
      </div>
    </div>
  </button>`
}

// ---------------------------------------------------------------------------
// Deal detail
// ---------------------------------------------------------------------------

async function viewDeal(adId) {
  const d = await api(`/api/deal/${adId}`)
  if (d.error) { main.innerHTML = `<p class="empty">${esc(d.error)}</p>`; return }
  title.textContent = d.listing.heading

  const v = d.valuation
  const p = d.plan
  const a = d.analysis

  main.innerHTML = `
    ${d.listing.images.length ? `<div class="section"><div class="gallery">${d.listing.images.slice(0, 12)
      .map((u) => `<img src="${esc(u.replace("/dynamic/default/", "/dynamic/640w/"))}" alt="" loading="lazy">`).join("")}</div></div>` : ""}

    <div class="section">
      <h2>Bilen</h2>
      <dl class="figures">
        <dt>Prisantydning</dt><dd>${kr(d.listing.price)}</dd>
        ${p?.omregFee ? `<dt>Omregistrering</dt><dd>${kr(p.omregFee)}</dd><dt>Totalt</dt><dd>${kr(p.totalCost)}</dd>` : ""}
        <dt>Årsmodell</dt><dd>${d.listing.year ?? "—"}</dd>
        <dt>Kilometerstand</dt><dd>${km(d.listing.mileage)}</dd>
        <dt>Selger</dt><dd>${esc(d.listing.dealerSegment ?? "—")}</dd>
        <dt>Sted</dt><dd>${esc(d.listing.location ?? "—")}</dd>
        ${d.specs?.euControl ? `<dt>EU-kontroll</dt><dd>${esc(d.specs.euControl.text)}${d.specs.euControl.verified ? "" : " *"}</dd>` : ""}
      </dl>
      ${d.specs?.euControl && !d.specs.euControl.verified ? '<p class="meta" style="color:var(--text-muted);font-size:12px;margin:8px 0 0">* beregnet fra første registrering, ikke bekreftet mot registeret</p>' : ""}
      <a class="copy" style="display:block;text-align:center;text-decoration:none" href="${esc(d.listing.url)}" target="_blank" rel="noopener">Åpne på FINN</a>
    </div>

    ${v ? `<div class="section">
      <h2>Verdivurdering</h2>
      <dl class="figures">
        <dt>Markedsverdi</dt><dd>${kr(v.fairValue)}</dd>
        <dt>Mot prisantydning</dt><dd>${v.residualPct >= 0 ? pct(v.residualPct) + " under" : pct(-v.residualPct) + " over"}</dd>
        <dt>Sammenligningsbiler</dt><dd>${v.compCount}</dd>
        <dt>Sikkerhet</dt><dd>${esc(v.confidence ?? "—")}</dd>
      </dl>
      ${v.confidence === "low" ? '<p style="color:var(--warn);font-size:13px;margin:10px 0 0">Få eller ulike sammenligningsbiler — bruk tallet som pekepinn, ikke som argument.</p>' : ""}
    </div>` : ""}

    ${v?.requirements?.length ? `<div class="section">
      <h2>Ønskene dine</h2>
      <ul class="findings">
        ${v.requirements.map((r) => {
          const icon = r.status === "ja" ? '<span class="dot green"></span>' : r.status === "nei" ? '<span class="dot red"></span>' : '<span class="dot maybe"></span>'
          const label = r.status === "ja" ? "" : r.status === "nei" ? " — ikke funnet" : " — ikke bekreftet, spør selger"
          return `<li>${icon}<strong>${esc(r.requirement)}</strong>${r.required ? ' <span class="badge low">må ha</span>' : ""}${esc(label)}
            ${r.evidence ? `<span class="ev">${esc(r.evidence)}${r.source ? ` (${esc(r.source)})` : ""}</span>` : ""}</li>`
        }).join("")}
      </ul>
    </div>` : ""}

    ${d.comps.length ? `<div class="section">
      <h2>Mot markedet</h2>
      <div class="legend">
        <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--series-1)"></circle></svg> Sammenlignbare (${d.comps.length})</span>
        <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--series-2)"></circle></svg> Denne bilen</span>
      </div>
      <div class="chart-wrap" id="chart"></div>
      <details><summary>Vis som tabell</summary>
        <table class="data"><thead><tr><th>År</th><th>Km</th><th>Pris</th></tr></thead><tbody>
        ${d.comps.slice().sort((x, y) => x.price - y.price).map((c) => `<tr><td>${c.year}</td><td>${km(c.km)}</td><td>${kr(c.price)}</td></tr>`).join("")}
        </tbody></table>
      </details>
    </div>` : ""}

    ${p ? `<div class="section">
      <h2>Prutplan</h2>
      <dl class="figures">
        <dt>Markedsverdi</dt><dd>${kr(p.fairValue)}</dd>
        <dt>Forsvarlig etter funn</dt><dd>${kr(p.defensibleValue)}</dd>
        <dt class="">Gå fra ved</dt><dd>${kr(p.walkAway)}</dd>
      </dl>
      <dl class="figures strong" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
        <dt>Målpris</dt><dd>${kr(p.target)}</dd>
      </dl>
      ${p.budget ? `<p style="margin:10px 0 0;font-size:14px;color:${p.haggleableIntoBudget ? "var(--good)" : p.overBudgetBy ? "var(--bad)" : "var(--text-secondary)"}">
        ${p.haggleableIntoBudget ? `${kr(p.overBudgetBy)} over budsjett, men innen rekkevidde.` : p.overBudgetBy ? `${kr(p.overBudgetBy)} over budsjett — krever ${pct(p.requiredDiscountPct)} avslag, bare ${pct(p.supportedDiscountPct)} er forsvarlig.` : "Innenfor budsjett."}</p>` : ""}
      <ul class="rationale">${p.rationale.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <button class="copy" id="copy">Kopier argumentene</button>
    </div>` : ""}

    ${a ? `<div class="section">
      <h2>Funn i annonse og bilder</h2>
      ${a.summary ? `<p style="margin:0 0 10px;color:var(--text-secondary)">${esc(a.summary)}</p>` : ""}
      <ul class="findings">
        ${a.redFlags.map((f) => finding(f, "red", a.imagesUsed)).join("")}
        ${a.greenFlags.map((f) => finding(f, "green", a.imagesUsed)).join("")}
      </ul>
      <p style="color:var(--text-muted);font-size:12px;margin:10px 0 0">Lest av ${esc(a.provider)}. Sjekk alltid bildefunn selv før du tar dem opp med selger.</p>
    </div>` : ""}
  `

  if (d.comps.length) drawScatter(document.getElementById("chart"), d)

  const copy = document.getElementById("copy")
  if (copy) copy.onclick = () => {
    navigator.clipboard.writeText(p.rationale.join("\n")).then(() => (copy.textContent = "Kopiert ✓"))
  }
}

// A visual claim links to the photo it came from — imageIndex points into the
// images the model actually saw, not the listing's full album.
function finding(f, kind, imagesUsed) {
  const photo = f.source === "bilde" && f.imageIndex != null && imagesUsed[f.imageIndex]
  return `<li><span class="dot ${kind}"></span>${esc(f.claim)}
    <span class="ev">${esc(f.evidence)}</span>
    ${photo ? `<a href="${esc(photo.replace("/dynamic/640w/", "/dynamic/1280w/"))}" target="_blank" rel="noopener">Se bildet →</a>` : ""}</li>`
}

// ---------------------------------------------------------------------------
// Scatter: price against mileage, this car against its comparables
// ---------------------------------------------------------------------------

function drawScatter(root, d) {
  const W = 680, H = 320, M = { t: 12, r: 14, b: 38, l: 62 }
  const pts = d.comps.map((c) => ({ ...c, me: false }))
  const me = { km: d.listing.mileage, price: d.listing.price, me: true, adId: d.listing.adId }

  const xs = [...pts.map((p) => p.km), me.km]
  const ys = [...pts.map((p) => p.price), me.price, ...d.trend.map((t) => t.price)]
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1
  const y0 = Math.min(...ys), y1 = Math.max(...ys) || 1
  const padY = (y1 - y0) * 0.08 || 1
  const sx = (v) => M.l + ((v - x0) / (x1 - x0 || 1)) * (W - M.l - M.r)
  const sy = (v) => H - M.b - ((v - (y0 - padY)) / (y1 + padY - (y0 - padY) || 1)) * (H - M.t - M.b)

  const ticks = (lo, hi, n) => {
    const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / n)))
    const s = [1, 2, 2.5, 5, 10].map((m) => m * step).find((m) => (hi - lo) / m <= n) ?? step
    const out = []
    for (let v = Math.ceil(lo / s) * s; v <= hi; v += s) out.push(v)
    return out
  }

  const trendPath = d.trend.length
    ? `<path d="${d.trend.map((t, i) => `${i ? "L" : "M"}${sx(t.km).toFixed(1)},${sy(t.price).toFixed(1)}`).join("")}"
         fill="none" stroke="var(--series-1)" stroke-width="2" stroke-opacity=".45" stroke-dasharray="5 4"/>`
    : ""

  root.innerHTML = `
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
       aria-label="Pris mot kilometerstand for ${d.comps.length} sammenlignbare biler, med denne bilen uthevet">
    ${ticks(y0 - padY, y1 + padY, 5).map((v) => `
      <line x1="${M.l}" x2="${W - M.r}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"
            stroke="var(--border)" stroke-width="1"/>
      <text x="${M.l - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end"
            font-size="11" fill="var(--text-muted)">${Math.round(v / 1000)}k</text>`).join("")}
    ${ticks(x0, x1, 5).map((v) => `
      <text x="${sx(v).toFixed(1)}" y="${H - M.b + 18}" text-anchor="middle"
            font-size="11" fill="var(--text-muted)">${Math.round(v / 1000)}k</text>`).join("")}
    <text x="${(W / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" font-size="11" fill="var(--text-muted)">kilometerstand</text>
    <text x="14" y="${(H / 2).toFixed(0)}" text-anchor="middle" font-size="11" fill="var(--text-muted)"
          transform="rotate(-90 14 ${(H / 2).toFixed(0)})">pris (kr)</text>

    ${trendPath}

    ${pts.map((p) => `<circle class="pt" data-km="${p.km}" data-price="${p.price}" data-year="${p.year}" data-id="${p.adId}"
        cx="${sx(p.km).toFixed(1)}" cy="${sy(p.price).toFixed(1)}" r="5"
        fill="var(--series-1)" fill-opacity=".75" stroke="var(--surface-1)" stroke-width="2"/>`).join("")}

    <circle class="pt me" data-km="${me.km}" data-price="${me.price}" data-year="${d.listing.year}"
        cx="${sx(me.km).toFixed(1)}" cy="${sy(me.price).toFixed(1)}" r="8"
        fill="var(--series-2)" stroke="var(--surface-1)" stroke-width="2.5"/>
    <text x="${(sx(me.km) + 13).toFixed(1)}" y="${(sy(me.price) + 4).toFixed(1)}"
        font-size="12" font-weight="600" fill="var(--text-primary)">Denne</text>
  </svg>
  <div class="tooltip" id="tip"></div>`

  // Hover layer. An SVG chart in a page is interactive by default; a bare
  // scatter with no way to identify a point is a chart you can only squint at.
  const tip = root.querySelector("#tip")
  const svg = root.querySelector("svg")
  for (const c of root.querySelectorAll(".pt")) {
    const show = (e) => {
      const r = root.getBoundingClientRect()
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top
      tip.textContent = `${c.dataset.year} · ${km(+c.dataset.km)} · ${kr(+c.dataset.price)}${c.classList.contains("me") ? " (denne)" : ""}`
      tip.style.left = `${Math.min(Math.max(cx - 60, 0), r.width - 150)}px`
      tip.style.top = `${Math.max(cy - 42, 0)}px`
      tip.classList.add("on")
    }
    c.addEventListener("pointerenter", show)
    c.addEventListener("pointermove", show)
    c.addEventListener("pointerleave", () => tip.classList.remove("on"))
    if (c.dataset.id && !c.classList.contains("me")) {
      c.style.cursor = "pointer"
      c.addEventListener("click", () => (location.hash = `#/deal/${c.dataset.id}`))
    }
  }
  svg.addEventListener("pointerleave", () => tip.classList.remove("on"))
}

// ---------------------------------------------------------------------------
// Searches & health
// ---------------------------------------------------------------------------

async function viewSearches() {
  title.textContent = "Søk"
  const rows = await api("/api/searches")
  main.innerHTML = `
    ${rows.map((s) => `<div class="section">
      <h2>${esc(s.name)}</h2>
      <p style="word-break:break-all;font-size:13px;color:var(--text-muted);margin:0">${esc(s.url)}</p>
      <dl class="figures" style="margin-top:8px">
        <dt>Budsjett</dt><dd>${s.budget_nok ? kr(s.budget_nok) : "—"}</dd>
        <dt>Varselgrense</dt><dd>${s.min_score}</dd>
        <dt>Ønsker</dt><dd>${s.requirements?.length ? s.requirements.map((r) => esc(r.text) + (r.required ? "!" : "")).join(", ") : "—"}</dd>
        <dt>Sist sjekket</dt><dd>${s.last_swept ? new Date(s.last_swept).toLocaleString("nb-NO") : "aldri"}</dd>
      </dl>
    </div>`).join("")}
    <div class="section">
      <h2>Legg til søk</h2>
      <form class="add" id="addf">
        <input name="name" placeholder="Navn, f.eks. «Golf under 150k»" required>
        <input name="url" placeholder="Lim inn URL-en fra et lagret søk på finn.no" required>
        <input name="budget" type="number" placeholder="Budsjett i kroner (valgfritt)">
        <input name="want" placeholder="Ønsker: skinn!, hengerfeste, ryggekamera">
        <p style="margin:0;font-size:12px;color:var(--text-muted)">Skill med komma. Sett <strong>!</strong> etter noe du må ha — biler uten det rangeres ned.</p>
        <button>Legg til</button>
      </form>
    </div>`

  document.getElementById("addf").onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    const res = await fetch("/api/searches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), url: f.get("url"), budget: f.get("budget") ? Number(f.get("budget")) : undefined, want: f.get("want") || undefined }),
    }).then((r) => r.json())
    if (res.error) alert(res.error)
    else route()
  }
}

async function viewHealth() {
  title.textContent = "Status"
  const h = await api("/api/health")
  const conf = Object.fromEntries(h.confidence.map((r) => [r.c ?? "?", r.n]))
  main.innerHTML = `
    <div class="section">
      <h2>Datagrunnlag</h2>
      <dl class="figures">
        <dt>Aktive annonser</dt><dd>${h.listings}</dd>
        <dt>Avsluttet</dt><dd>${h.delisted}</dd>
        <dt>Verdivurdert</dt><dd>${h.valued}</dd>
        <dt>Analysert med bilder</dt><dd>${h.analysed}</dd>
      </dl>
    </div>
    <div class="section">
      <h2>Sikkerhet i anslagene</h2>
      <dl class="figures">
        <dt>Høy</dt><dd>${conf.high ?? 0}</dd>
        <dt>Middels</dt><dd>${conf.medium ?? 0}</dd>
        <dt>Lav</dt><dd>${conf.low ?? 0}</dd>
      </dl>
      <p style="color:var(--text-muted);font-size:12px;margin:8px 0 0">Målt på ekte data: høy ≈ 2,7 % medianavvik, lav ≈ 16,9 %.</p>
    </div>
    <div class="section">
      <h2>Språkmodell</h2>
      <table class="data"><thead><tr><th>Oppgave</th><th>Leverandør</th><th>Kall</th><th>OK</th><th>Eskalert</th><th>ms</th></tr></thead>
      <tbody>${h.llm.map((r) => `<tr><td>${esc(r.task)}</td><td>${esc(r.provider)}</td><td>${r.calls}</td><td>${r.ok}</td><td>${r.escalations}</td><td>${r.p50_ms}</td></tr>`).join("") || '<tr><td colspan="6">Ingen kall ennå</td></tr>'}</tbody></table>
    </div>
    <div class="section">
      <h2>Største modellgrupper</h2>
      <table class="data"><thead><tr><th>Modell</th><th>Antall</th></tr></thead>
      <tbody>${h.topModels.map((m) => `<tr><td>${esc(m.make)} ${esc(m.series ?? "")}</td><td>${m.n}</td></tr>`).join("")}</tbody></table>
    </div>`
}

route()
