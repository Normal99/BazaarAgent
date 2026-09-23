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
// Feed: filters, sorting, and cards that justify their own ranking
// ---------------------------------------------------------------------------

const FILTER_KEY = "bazaar.filters"
const defaultFilters = () => ({ sort: "score", minScore: 0, maxPrice: null, seller: "alle", hideAuction: false, q: "" })

function loadFilters() {
  try {
    return { ...defaultFilters(), ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") }
  } catch {
    return defaultFilters()
  }
}
function saveFilters(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch {}
}

let filters = loadFilters()
let feedCache = null

const SORTS = {
  score: { label: "Best funn", fn: (a, b) => (b.score ?? 0) - (a.score ?? 0) },
  price: { label: "Lavest pris", fn: (a, b) => a.price - b.price },
  distance: { label: "Nærmest", fn: (a, b) => (a.trip?.roadKm ?? 1e9) - (b.trip?.roadKm ?? 1e9) },
  newest: { label: "Nyest", fn: (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) },
  mileage: { label: "Lavest km", fn: (a, b) => (a.mileage ?? 1e9) - (b.mileage ?? 1e9) },
}

function applyFilters(deals) {
  const q = filters.q.trim().toLowerCase()
  return deals
    .filter((d) => !d.disqualified)
    .filter((d) => (d.score ?? 0) >= filters.minScore)
    .filter((d) => (filters.maxPrice == null ? true : d.price <= filters.maxPrice))
    .filter((d) => (filters.seller === "alle" ? true : (d.dealerSegment ?? "").toLowerCase().startsWith(filters.seller)))
    .filter((d) => (filters.hideAuction ? d.listingType !== "auction" : true))
    .filter((d) => (q ? `${d.heading} ${d.make ?? ""} ${d.location ?? ""}`.toLowerCase().includes(q) : true))
    .sort(SORTS[filters.sort]?.fn ?? SORTS.score.fn)
}

function filterBar(total, shown) {
  const opts = Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${filters.sort === k ? " selected" : ""}>${v.label}</option>`).join("")
  const active = filters.minScore > 0 || filters.maxPrice != null || filters.seller !== "alle" || filters.hideAuction || filters.q
  return `<div class="filters">
    <div class="filter-row">
      <input id="f-q" class="search" type="search" placeholder="Søk merke, modell, sted…" value="${esc(filters.q)}">
      <select id="f-sort" class="select">${opts}</select>
      <button id="f-more" class="chip${active ? " on" : ""}" aria-expanded="false">Filter${active ? " •" : ""}</button>
    </div>
    <div class="filter-panel" id="f-panel" hidden>
      <label>Minste score <output id="f-score-out">${filters.minScore.toFixed(1)}</output>
        <input id="f-score" type="range" min="0" max="10" step="0.5" value="${filters.minScore}"></label>
      <label>Maks pris
        <input id="f-price" type="number" inputmode="numeric" placeholder="ingen grense" value="${filters.maxPrice ?? ""}"></label>
      <div class="seg" role="group" aria-label="Selger">
        ${["alle", "privat", "forhandler"].map((v) => `<button data-seller="${v}" class="${filters.seller === v ? "on" : ""}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join("")}
      </div>
      <label class="check"><input id="f-auction" type="checkbox"${filters.hideAuction ? " checked" : ""}> Skjul auksjoner</label>
      <button id="f-reset" class="ghost">Nullstill</button>
    </div>
    <p class="count">${shown} av ${total} annonser</p>
  </div>`
}

function wireFilters(rerender) {
  const $ = (id) => document.getElementById(id)
  const update = (patch) => { filters = { ...filters, ...patch }; saveFilters(filters); rerender() }

  $("f-sort").onchange = (e) => update({ sort: e.target.value })
  $("f-more").onclick = () => {
    const panel = $("f-panel")
    panel.hidden = !panel.hidden
    $("f-more").setAttribute("aria-expanded", String(!panel.hidden))
  }
  // Debounced so typing does not re-render on every keystroke.
  let timer
  $("f-q").oninput = (e) => {
    clearTimeout(timer)
    const value = e.target.value
    timer = setTimeout(() => update({ q: value }), 200)
  }
  const score = $("f-score")
  if (score) {
    score.oninput = (e) => { $("f-score-out").textContent = Number(e.target.value).toFixed(1) }
    score.onchange = (e) => update({ minScore: Number(e.target.value) })
  }
  const price = $("f-price")
  if (price) price.onchange = (e) => update({ maxPrice: e.target.value ? Number(e.target.value) : null })
  const auction = $("f-auction")
  if (auction) auction.onchange = (e) => update({ hideAuction: e.target.checked })
  for (const b of document.querySelectorAll("[data-seller]")) b.onclick = () => update({ seller: b.dataset.seller })
  const reset = $("f-reset")
  if (reset) reset.onclick = () => update(defaultFilters())
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

async function viewDeals({ watchOnly }) {
  title.textContent = watchOnly ? "Følger" : "Funn"
  if (!feedCache) feedCache = await api("/api/deals?limit=250")
  const pool = watchOnly ? feedCache.deals.filter((d) => d.watched) : feedCache.deals

  const render = () => {
    const deals = watchOnly ? pool.filter((d) => !d.disqualified) : applyFilters(pool)

    if (pool.length === 0) {
      main.innerHTML = watchOnly
        ? `<p class="empty">Ingen biler følges ennå.<br><span class="hint">Trykk stjernen på et funn for å følge prisen.</span></p>`
        : `<p class="empty">Ingenting scoret ennå.<br><span class="hint">Kjør <code>./bazaar score</code>.</span></p>`
      return
    }

    main.innerHTML =
      (watchOnly ? "" : filterBar(pool.length, deals.length)) +
      (deals.length === 0
        ? `<p class="empty">Ingen treff med disse filtrene.<br><span class="hint">Prøv å senke minste score eller heve maks pris.</span></p>`
        : `<div class="cards">${deals.map(card).join("")}</div>`)

    if (!watchOnly) wireFilters(render)
    wireCards(render)
  }
  render()
}

/** Card interactions: open the detail, or toggle watching without leaving the feed. */
function wireCards(rerender) {
  for (const el of main.querySelectorAll(".card")) {
    el.onclick = (e) => {
      if (e.target.closest("[data-watch]")) return
      location.hash = `#/deal/${el.dataset.id}`
    }
  }
  for (const b of main.querySelectorAll("[data-watch]")) {
    b.onclick = async (e) => {
      e.stopPropagation()
      const id = Number(b.dataset.watch)
      const { watched } = await fetch(`/api/watch/${id}`).then((r) => r.json())
      const row = feedCache?.deals.find((d) => d.adId === id)
      if (row) row.watched = watched
      b.classList.toggle("on", watched)
      b.textContent = watched ? "★" : "☆"
      b.setAttribute("aria-label", watched ? "Slutt å følge" : "Følg denne bilen")
    }
  }
}

/**
 * One listing in the feed.
 *
 * Ordered by what you decide on: price and how it compares to the market
 * first, then the facts that change whether it is worth a trip, then the
 * warnings. The score sits in the corner with its reasoning behind a tap,
 * because a ranking you cannot interrogate is one you end up ignoring.
 */
function card(d) {
  const badges = []
  if (d.haggleable) badges.push(`<span class="badge haggle">${kr(d.overBudgetBy)} over — forhandlebart</span>`)
  if (d.missingRequired > 0) badges.push(`<span class="badge over">mangler ${d.missingRequired} du må ha</span>`)
  else if (d.requirements?.length) {
    const met = d.requirements.filter((r) => r.status === "ja").length
    if (met > 0) badges.push(`<span class="badge under">${met}/${d.requirements.length} ønsker ✓</span>`)
  }
  // A repost means it did not sell last time — invisible on finn, and the
  // strongest thing you can walk into a negotiation knowing.
  if (d.relisted) badges.push('<span class="badge relist">lagt ut på nytt</span>')
  if (d.listingType === "auction") badges.push('<span class="badge low">auksjon — startbud</span>')
  if (d.confidence === "low") badges.push('<span class="badge low">usikkert anslag</span>')

  const delta =
    d.residualPct == null
      ? ""
      : d.residualPct >= 0
        ? `<span class="delta good">${pct(d.residualPct)} under marked</span>`
        : `<span class="delta bad">${pct(-d.residualPct)} over marked</span>`

  const facts = [
    d.year,
    d.mileage != null ? km(d.mileage) : null,
    d.dealerSegment,
    d.location,
    d.trip ? `${d.trip.roadKm} km unna` : null,
  ].filter(Boolean)

  return `<article class="card" data-id="${d.adId}" tabindex="0">
    <div class="card-media">
      ${d.thumb ? `<img src="${esc(d.thumb.replace("/dynamic/default/", "/dynamic/480w/"))}" alt="" loading="lazy" decoding="async">` : '<div class="noimg">ingen bilde</div>'}
      <button class="watch${d.watched ? " on" : ""}" data-watch="${d.adId}"
              aria-label="${d.watched ? "Slutt å følge" : "Følg denne bilen"}">${d.watched ? "★" : "☆"}</button>
      ${scoreChip(d)}
    </div>
    <div class="card-body">
      <h3>${esc(d.heading)}</h3>
      <div class="pricerow"><span class="price">${kr(d.price)}</span>${delta}</div>
      <p class="facts">${facts.map(esc).join(" · ")}</p>
      ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
    </div>
  </article>`
}

/** The score, with the reasoning that produced it available on the detail view. */
function scoreChip(d) {
  const score = d.score ?? 0
  const tone = score >= 8.5 ? "hot" : score >= 7 ? "warm" : "cool"
  return `<span class="score ${tone}" title="${esc((d.parts ?? []).map((p) => `${p.label} ${p.delta >= 0 ? "+" : ""}${p.delta.toFixed(1)}`).join("\n"))}">${score.toFixed(1)}</span>`
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
        ${d.listing.trip ? `<dt>Avstand</dt><dd>~${d.listing.trip.roadKm} km</dd>
        <dt>Reise tur/retur</dt><dd>${kr(d.listing.trip.costNok)} · ${d.listing.trip.hours.toFixed(1)} t</dd>` : ""}
        ${d.specs?.euControl ? `<dt>EU-kontroll</dt><dd>${esc(d.specs.euControl.text)}${d.specs.euControl.verified ? "" : " *"}</dd>` : ""}
      </dl>
      ${d.listing.trip ? `<p style="color:var(--text-muted);font-size:12px;margin:8px 0 0">Fra ${esc(d.listing.trip.from)}. ${esc(d.listing.trip.note)}</p>` : ""}
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

    ${v?.parts?.length ? `<div class="section">
      <h2>Hvorfor ${(v.score ?? 0).toFixed(1)}</h2>
      ${scoreBreakdown(v.parts)}
    </div>` : ""}

    ${d.relist ? `<div class="section">
      <h2>Lagt ut på nytt</h2>
      <p style="margin:0 0 8px">Samme bil lå ute for ${d.relist.daysBetween} dager siden til <strong>${kr(d.relist.previousPrice)}</strong>${
        d.listing.price < d.relist.previousPrice ? ` — nå ${kr(d.relist.previousPrice - d.listing.price)} lavere.` : "."
      }</p>
      <p style="margin:0;color:var(--text-muted);font-size:13px">Den ble ikke solgt forrige gang. Det er et av de sterkeste kortene du har i en forhandling, og det står ingen steder på FINN.</p>
    </div>` : ""}

    ${d.priceHistory?.length > 1 ? `<div class="section">
      <h2>Prishistorikk</h2>
      ${priceHistory(d.priceHistory)}
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

/**
 * What made the score what it is.
 *
 * Diverging bars from a centre line: everything above the line helped, below
 * hurt. The sign is in the number as well as the colour, so the reading never
 * depends on distinguishing green from red.
 */
function scoreBreakdown(parts) {
  const max = Math.max(1, ...parts.map((p) => Math.abs(p.delta)))
  return `<ul class="bars">${parts
    .map((p) => {
      const width = (Math.abs(p.delta) / max) * 50
      const positive = p.delta >= 0
      return `<li>
        <span class="bar-label">${esc(p.label)}</span>
        <span class="bar-track">
          <span class="bar ${positive ? "pos" : "neg"}" style="width:${width.toFixed(1)}%;${positive ? "left:50%" : `left:${(50 - width).toFixed(1)}%`}"></span>
          <span class="bar-zero"></span>
        </span>
        <span class="bar-val ${positive ? "pos" : "neg"}">${positive ? "+" : "\u2212"}${Math.abs(p.delta).toFixed(1)}</span>
      </li>`
    })
    .join("")}</ul>`
}

/** Price over time. A seller already cutting is telling you where their floor is. */
function priceHistory(history) {
  const prices = history.map((h) => h.price)
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const first = prices[0]
  const last = prices[prices.length - 1]
  const drop = first - last

  const W = 600, H = 120, pad = 8
  const x = (i) => pad + (i / Math.max(1, history.length - 1)) * (W - pad * 2)
  const y = (v) => H - pad - ((v - lo) / Math.max(1, hi - lo)) * (H - pad * 2)
  const path = history.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h.price).toFixed(1)}`).join("")

  return `<p style="margin:0 0 10px">${
    drop > 0
      ? `Satt ned <strong>${kr(drop)}</strong> siden ${new Date(history[0].observed_at).toLocaleDateString("nb-NO")}.`
      : drop < 0
        ? `Satt opp ${kr(-drop)} siden ${new Date(history[0].observed_at).toLocaleDateString("nb-NO")}.`
        : "Uendret pris."
  }</p>
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Prisutvikling: ${prices.map((p) => kr(p)).join(", ")}">
    <path d="${path}" fill="none" stroke="var(--series-2)" stroke-width="2" stroke-linejoin="round"/>
    ${history.map((h, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(h.price).toFixed(1)}" r="4" fill="var(--series-2)" stroke="var(--surface-1)" stroke-width="2"><title>${new Date(h.observed_at).toLocaleDateString("nb-NO")}: ${kr(h.price)}</title></circle>`).join("")}
  </svg>
  <table class="data"><thead><tr><th>Dato</th><th>Pris</th></tr></thead><tbody>
    ${history.map((h) => `<tr><td>${new Date(h.observed_at).toLocaleDateString("nb-NO")}</td><td>${kr(h.price)}</td></tr>`).join("")}
  </tbody></table>`
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
    ${await homeSection()}
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

  const toggle = document.getElementById("toggledist")
  if (toggle) toggle.onclick = async () => {
    const home = await api("/api/home")
    await fetch("/api/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scoreDistance: !home.scoreDistance }),
    })
    route()
  }

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

// Distance is always shown; whether it moves the ranking is a preference, so
// it lives next to the searches rather than buried in a config file.
async function homeSection() {
  const home = await api("/api/home")
  if (!home) return `<div class="section"><h2>Hjemme</h2>
    <p style="margin:0;color:var(--text-muted);font-size:14px">Ikke satt — avstand telles ikke.
    Kjør <code>./bazaar home "Skien"</code>.</p></div>`
  return `<div class="section">
    <h2>Hjemme</h2>
    <dl class="figures">
      <dt>Sted</dt><dd>${esc(home.label)}</dd>
      <dt>Avstand i scoren</dt><dd>${home.scoreDistance ? (home.weight === 1 ? "ja" : `ja (vekt ${home.weight})`) : "nei"}</dd>
    </dl>
    <button class="copy" id="toggledist">${home.scoreDistance ? "Slå av avstand i scoren" : "Slå på avstand i scoren"}</button>
    <p style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">Avstand vises uansett — dette styrer bare om den påvirker rangeringen. Kjør <code>./bazaar score</code> etterpå.</p>
  </div>`
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
