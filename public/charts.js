// Chart cards for azure_chart results: Azure logs / metrics drawn as SVG lines, bars or a table,
// with hover read-outs, Copy image (PNG to paste into Zendesk / Teams) and Copy CSV.
// Cards are plain HTML from chartCards(); they fill themselves in (fetch + draw) when they appear,
// so the chat can re-render as often as it likes.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Reference categorical palette (dataviz skill), fixed order. Light theme only, like the app.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const INK = { text: '#16181d', muted: '#646b78', grid: '#eceef2', axis: '#c9ced6', surface: '#ffffff' };
const FONT = '"Segoe UI", system-ui, sans-serif';

const cache = new Map();   // id → chart data (or a pending Promise)
const views = new Map();   // id → 'chart' | 'table' (kept across re-renders)
const drawn = new WeakMap(); // card element → { id, width, view } last drawn

// ---------- Formatting ----------
const compact = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return String(Math.round(v));
  return String(+v.toPrecision(3));
};
function fmt(v, unit) {
  if (v == null || Number.isNaN(v)) return '–';
  switch (unit) {
    case 'Seconds': return Math.abs(v) < 1 ? `${+(v * 1000).toPrecision(3)} ms` : Math.abs(v) < 120 ? `${+v.toPrecision(3)} s` : `${+(v / 60).toPrecision(3)} min`;
    case 'MilliSeconds': case 'Milliseconds': return Math.abs(v) < 1000 ? `${+v.toPrecision(3)} ms` : fmt(v / 1000, 'Seconds');
    case 'Bytes': case 'BytesPerSecond': {
      const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let x = v;
      while (Math.abs(x) >= 1024 && i < u.length - 1) { x /= 1024; i++; }
      return `${+x.toPrecision(3)} ${u[i]}${unit === 'BytesPerSecond' ? '/s' : ''}`;
    }
    case 'Percent': return `${+v.toPrecision(3)}%`;
    case 'CountPerSecond': return `${compact(v)}/s`;
    default: return compact(v);
  }
}
/** Y-axis labels in one unit for the whole axis (picked from its largest value), never "100 s" next to "2.5 min". */
function axisScale(unit, max) {
  const num = (v) => String(+v.toPrecision(4));
  const ms = unit === 'MilliSeconds' || unit === 'Milliseconds';
  if (unit === 'Seconds' || ms) {
    const sec = ms ? max / 1000 : max;
    const [d, suf] = sec < 1 ? [0.001, 'ms'] : sec < 120 ? [1, 's'] : [60, 'min'];
    const div = ms ? d * 1000 : d;
    return { div, label: (v) => (v === 0 ? '0' : `${num(v / div)} ${suf}`) };
  }
  if (unit === 'Bytes' || unit === 'BytesPerSecond') {
    const i = Math.max(0, Math.min(4, Math.floor(Math.log(max || 1) / Math.log(1024))));
    return { div: 1024 ** i, label: (v) => (v === 0 ? '0' : `${num(v / 1024 ** i)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}${unit === 'BytesPerSecond' ? '/s' : ''}`) };
  }
  if (unit === 'Percent') return { div: 1, label: (v) => `${num(v)}%` };
  return { div: 1, label: (v) => compact(v) };
}
const AGG_SHORT ={ Average: 'Avg', Total: 'Sum', Maximum: 'Max', Minimum: 'Min', Count: 'Count' };
const tzLabel = () => { const o = -new Date().getTimezoneOffset(); return `UTC${o >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(o) / 60)).padStart(2, '0')}:${String(Math.abs(o) % 60).padStart(2, '0')}`; };
const utc = (iso) => (typeof iso === 'string' ? iso.replace('T', ' ').replace(/(\.\d{3})\d*/, '$1').replace(/Z$/, '') : iso);
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- Scales ----------
function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(+v.toPrecision(12));
  if (out.at(-1) < max) out.push(+(out.at(-1) + step).toPrecision(12));
  return out;
}
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const STEPS = [MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
function timeTicks(t0, t1, maxTicks) {
  const step = STEPS.find((s) => (t1 - t0) / s <= maxTicks) || STEPS.at(-1);
  const off = new Date(t0).getTimezoneOffset() * MIN; // local alignment (midnight, whole hours)
  const ticks = [];
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1; t += step) ticks.push(t);
  const multiDay = t1 - t0 > DAY * 1.5;
  const label = (t) => {
    const d = new Date(t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    if (step >= DAY || (multiDay && midnight)) return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  return ticks.map((t) => ({ t, label: label(t) }));
}

// ---------- Layout: one panel per unit (never two y-scales on one chart) ----------
function panelsOf(c) {
  const groups = new Map();
  c.series.forEach((s, i) => {
    const k = s.unit || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...s, color: SERIES[i % SERIES.length] });
  });
  return [...groups.entries()].map(([unit, series]) => ({ unit: unit || null, series }));
}
const legendValue = (s) => {
  if (s.overall != null) return s.overall;
  const v = s.points.map((p) => p[1]).filter((x) => x != null);
  if (!v.length) return null;
  if (s.aggregation === 'Total' || s.aggregation === 'Count' || !s.aggregation) return s.aggregation ? v.reduce((a, b) => a + b, 0) : Math.max(...v);
  if (s.aggregation === 'Maximum') return Math.max(...v);
  if (s.aggregation === 'Minimum') return Math.min(...v);
  return v.reduce((a, b) => a + b, 0) / v.length;
};
const seriesLabel = (s) => `${s.name}${s.aggregation ? ` (${AGG_SHORT[s.aggregation] || s.aggregation})` : ''}${s.resource ? ` · ${s.resource}` : ''}`;
const legendNote = (s) => (s.aggregation ? '' : ' max');

/** The chart as SVG. `geo` gets the plot geometry for the hover layer. */
function lineSvg(c, width, { header = false, geo = null } = {}) {
  const panels = panelsOf(c);
  const ml = 58, mr = 18, plotH = 170, gapX = 22, legendRow = 20, panelGap = 16;
  const t0 = c.timespan?.start ?? Math.min(...c.series.flatMap((s) => s.points.map((p) => p[0])));
  const t1 = c.timespan?.end ?? Math.max(...c.series.flatMap((s) => s.points.map((p) => p[0])));
  const plotW = width - ml - mr;
  const x = (t) => ml + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const ticks = timeTicks(t0, t1, Math.max(3, Math.floor(plotW / 90)));
  let y0 = header ? 64 : 10;
  let out = '';
  const legendCols = Math.max(1, Math.floor(width / 330));
  if (geo) Object.assign(geo, { ml, plotW, t0, t1, panels: [] });
  panels.forEach((p, pi) => {
    const vals = p.series.flatMap((s) => s.points.map((q) => q[1])).filter((v) => v != null);
    const minV = Math.min(0, ...vals);
    const ax = axisScale(p.unit, Math.max(...vals.map(Math.abs), 0));
    const yt = niceTicks((Math.max(...vals, 0) - minV) / ax.div, 4).map((v) => v * ax.div + minV);
    // Several panels: each gets a small title above its plot
    if (panels.length > 1) {
      out += `<text x="${ml}" y="${y0 + 12}" font-size="12" font-weight="600" fill="${INK.text}">${esc(p.series.length <= 2 ? p.series.map((s) => s.name).join(' · ') : (p.unit || 'Value'))}</text>`;
    }
    const pTop = y0 + (panels.length > 1 ? 24 : 6), bottom = pTop + plotH;
    const py = (v) => bottom - ((v - yt[0]) / (yt.at(-1) - yt[0] || 1)) * plotH;
    for (const v of yt) {
      out += `<line x1="${ml}" x2="${width - mr}" y1="${py(v)}" y2="${py(v)}" stroke="${v === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`;
      out += `<text x="${ml - 8}" y="${py(v) + 4}" font-size="11" fill="${INK.muted}" text-anchor="end">${esc(ax.label(v))}</text>`;
    }
    for (const tk of ticks) out += `<text x="${x(tk.t)}" y="${bottom + 15}" font-size="11" fill="${INK.muted}" text-anchor="middle">${esc(tk.label)}</text>`;
    for (const s of p.series) {
      let d = ''; let pen = false;
      for (const [t, v] of s.points) {
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${py(v).toFixed(1)}`;
        pen = true;
      }
      out += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.points.length > 400 ? 1.5 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (s.points.filter((q) => q[1] != null).length === 1) {
        const q = s.points.find((qq) => qq[1] != null);
        out += `<circle cx="${x(q[0])}" cy="${py(q[1])}" r="4" fill="${s.color}"/>`;
      }
    }
    if (geo) geo.panels.push({ top: pTop, bottom, unit: p.unit, series: p.series, yMin: yt[0], yMax: yt.at(-1) });
    // Legend: swatch, name, value over the range (in text ink, not the series colour)
    let ly = bottom + gapX + 8;
    p.series.forEach((s, i) => {
      const col = i % legendCols, row = Math.floor(i / legendCols);
      const lx = ml + col * ((width - ml) / legendCols);
      const yy = ly + row * legendRow;
      const v = legendValue(s);
      out += `<rect x="${lx}" y="${yy - 9}" width="10" height="10" rx="2" fill="${s.color}"/>`;
      out += `<text x="${lx + 16}" y="${yy}" font-size="12" fill="${INK.muted}">${esc(trunc(seriesLabel(s), 44))} <tspan fill="${INK.text}" font-weight="600">${esc(fmt(v, s.unit))}${legendNote(s)}</tspan></text>`;
    });
    y0 = ly + Math.ceil(p.series.length / legendCols) * legendRow + panelGap + (pi < panels.length - 1 && panels.length > 1 ? 10 : 0);
  });
  const h = y0 - panelGap + 6;
  const head = header ? headerSvg(c, width) : '';
  const foot = `<text x="${width - mr}" y="${h - 4}" font-size="10" fill="${INK.muted}" text-anchor="end">${esc(tzLabel())}</text>`;
  return svgWrap(width, h + 8, head + out + foot);
}

function barSvg(c, width, { header = false } = {}) {
  const top = header ? 64 : 10, rowH = 24, labelW = Math.min(260, width * 0.36);
  const max = Math.max(...c.bars.map((b) => b.value), 0) || 1;
  const barMax = width - labelW - 90;
  let out = `<text x="${labelW + 8}" y="${top + 2}" font-size="11" fill="${INK.muted}">${esc(c.barLabel || '')}</text>`;
  c.bars.forEach((b, i) => {
    const yy = top + 12 + i * rowH;
    const w = Math.max(2, (b.value / max) * barMax);
    out += `<text x="${labelW}" y="${yy + 15}" font-size="12" fill="${INK.text}" text-anchor="end">${esc(trunc(b.label, Math.floor(labelW / 7)))}</text>`;
    out += `<rect x="${labelW + 8}" y="${yy + 3}" width="${w}" height="${rowH - 8}" rx="4" fill="${SERIES[0]}"><title>${esc(b.label)}: ${b.value.toLocaleString()}</title></rect>`;
    out += `<text x="${labelW + 14 + w}" y="${yy + 15}" font-size="12" fill="${INK.text}">${esc(compact(b.value))}</text>`;
  });
  const h = top + 12 + c.bars.length * rowH + 10;
  return svgWrap(width, h, (header ? headerSvg(c, width) : '') + out);
}

/** The table as SVG text, for Copy image (the page shows an HTML table). */
function tableSvg(c, width) {
  const t = c.table, maxRows = 60, rowH = 22, top = 74, pad = 10;
  const charW = 6.6;
  const fixed = t.columns.map((col) => (col.type === 'datetime' ? 190 : col.type === 'string' ? 0 : 100));
  const flex = t.columns.filter((col, i) => !fixed[i]).length;
  const rest = Math.max(120, width - fixed.reduce((a, b) => a + b, 0) - pad * 2);
  const widths = fixed.map((w) => w || rest / Math.max(1, flex));
  let out = headerSvg(c, width);
  let xx = pad;
  t.columns.forEach((col, i) => { out += `<text x="${xx + 6}" y="${top}" font-size="12" font-weight="600" fill="${INK.text}">${esc(col.name)}${col.type === 'datetime' ? ' [UTC]' : ''}</text>`; xx += widths[i]; });
  out += `<line x1="${pad}" x2="${width - pad}" y1="${top + 7}" y2="${top + 7}" stroke="${INK.axis}"/>`;
  t.rows.slice(0, maxRows).forEach((r, ri) => {
    const yy = top + 7 + (ri + 1) * rowH;
    if (ri % 2) out += `<rect x="${pad}" y="${yy - rowH + 5}" width="${width - pad * 2}" height="${rowH}" fill="#f6f7f9"/>`;
    let cx = pad;
    r.forEach((v, i) => {
      out += `<text x="${cx + 6}" y="${yy}" font-size="12" fill="${INK.text}">${esc(trunc(cellText(v, t.columns[i]), Math.floor((widths[i] - 12) / charW)))}</text>`;
      cx += widths[i];
    });
  });
  const shown = Math.min(maxRows, t.rows.length);
  let h = top + 7 + shown * rowH + 14;
  if (t.total > shown) { out += `<text x="${pad + 6}" y="${h}" font-size="11" fill="${INK.muted}">… ${t.total - shown} more rows</text>`; h += 10; }
  return svgWrap(width, h + 8, out);
}

function headerSvg(c, width) {
  return `<text x="18" y="28" font-size="16" font-weight="600" fill="${INK.text}">${esc(trunc(c.title, Math.floor((width - 36) / 8.5)))}</text>
    <text x="18" y="48" font-size="12" fill="${INK.muted}">${esc(trunc(subtitle(c), Math.floor((width - 36) / 6.4)))}</text>`;
}
const svgWrap = (w, h, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family='${FONT}'><rect width="${w}" height="${h}" fill="${INK.surface}"/>${inner}</svg>`;
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s; };
function cellText(v, col) {
  if (v == null) return '';
  if (col.type === 'datetime') return utc(v);
  if (typeof v === 'number') return col.unit ? fmt(v, col.unit) : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
function subtitle(c) {
  const range = c.timespan?.label || (c.timespan ? `${when(c.timespan.start)} – ${when(c.timespan.end)}` : '');
  return [c.resourceName, range, c.intervalLabel && `${c.intervalLabel} grain`, c.table && `${c.table.total.toLocaleString()} row${c.table.total === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

// ---------- Card HTML ----------
export function chartCards(ids = []) {
  return ids.map((id) => `<div class="chart-card" data-chart="${esc(id)}">
    <div class="chart-head"><div class="chart-titles"><div class="chart-title">📈 Loading chart…</div><div class="chart-sub"></div></div><div class="chart-tools"></div></div>
    <div class="chart-body"></div><div class="chart-foot"></div></div>`).join('');
}

function tableHtml(c) {
  const t = c.table, limit = 500;
  return `<div class="chart-table-wrap"><table class="chart-table"><thead><tr>${t.columns.map((col) => `<th>${esc(col.name)}${col.type === 'datetime' ? ' <span class="sub">[UTC]</span>' : ''}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.slice(0, limit).map((r) => `<tr>${r.map((v, i) => { const s = cellText(v, t.columns[i]); return `<td class="${typeof v === 'number' ? 'num' : ''}" title="${esc(s.length > 60 ? s.slice(0, 2000) : '')}">${esc(s)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
    ${t.total > Math.min(limit, t.rows.length) || t.total > t.rows.length ? `<div class="sub chart-more">Showing ${Math.min(limit, t.rows.length).toLocaleString()} of ${t.total.toLocaleString()} rows${t.total > t.rows.length ? ` (mon.ai keeps the first ${t.rows.length.toLocaleString()})` : ''}. Copy CSV has ${t.rows.length.toLocaleString()}.</div>` : ''}`;
}

const hasChart = (c) => (c.view === 'bar' && c.bars?.length) || (c.series?.length && c.series.some((s) => s.points.some((p) => p[1] != null)));

function fill(card) {
  const id = card.dataset.chart;
  const c = cache.get(id);
  if (!c) {
    cache.set(id, fetch(`/api/charts/${id}`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || r.statusText); return d; })
      .then((d) => { cache.set(id, d); document.querySelectorAll(`.chart-card[data-chart="${id}"]`).forEach((el) => fill(el)); })
      .catch((e) => { cache.set(id, { error: e.message }); document.querySelectorAll(`.chart-card[data-chart="${id}"]`).forEach((el) => fill(el)); }));
    return;
  }
  if (c instanceof Promise) return;
  if (c.error) { card.querySelector('.chart-title').textContent = `📈 Chart unavailable: ${c.error}`; card.dataset.ready = '1'; return; }
  const view = views.get(id) || (hasChart(c) && c.view !== 'table' ? 'chart' : 'table');
  const width = Math.max(320, Math.round(card.querySelector('.chart-body').clientWidth || 900));
  const last = drawn.get(card);
  if (last && last.view === view && Math.abs(last.width - width) < 8) return;
  drawn.set(card, { id, width, view });
  card.dataset.ready = '1';
  card.querySelector('.chart-title').textContent = c.title;
  card.querySelector('.chart-sub').textContent = subtitle(c) + (view === 'chart' && c.series?.length ? ` · ${tzLabel()}` : '');
  card.querySelector('.chart-tools').innerHTML = `
    ${hasChart(c) ? `<span class="seg small"><button type="button" data-chart-view="chart" class="${view === 'chart' ? 'active' : ''}">Chart</button><button type="button" data-chart-view="table" class="${view === 'table' ? 'active' : ''}">Table</button></span>` : ''}
    <button type="button" class="btn small" data-chart-image title="Copy the ${view} as a PNG image, to paste into Zendesk, Teams or an email">🖼 Copy image</button>
    <button type="button" class="btn small" data-chart-csv title="Copy the data as CSV (paste into Excel)">Copy CSV</button>
    ${c.portalUrl ? `<a class="btn small" href="${esc(c.portalUrl)}" target="_blank" rel="noopener" title="Open the original query in the Azure portal">Portal ↗</a>` : ''}`;
  const body = card.querySelector('.chart-body');
  if (view === 'table') body.innerHTML = tableHtml(c);
  else if (c.view === 'bar') body.innerHTML = barSvg(c, width);
  else {
    const geo = {};
    body.innerHTML = `<div class="chart-plot">${lineSvg(c, width, { geo })}<div class="chart-hover" hidden><div class="chart-cross"></div><div class="chart-tip"></div></div></div>`;
    body.querySelector('.chart-plot')._geo = geo;
  }
  const svg = body.querySelector('svg');
  if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); svg.style.width = '100%'; svg.style.height = 'auto'; }
  const what = c.kind === 'logs' ? `<details><summary>KQL query</summary><pre class="mono">${esc(c.query)}</pre></details>`
    : `<details><summary>Metrics</summary><pre class="mono">${esc([...(c.metrics || []).map((m) => `${m.namespace ? `${m.namespace} · ` : ''}${m.name} (${m.aggregation || 'Average'})`), c.filter && `filter: ${c.filter}`, `resource: ${c.resource}`].filter(Boolean).join('\n'))}</pre></details>`;
  card.querySelector('.chart-foot').innerHTML = `${what}${c.seriesDropped ? `<span class="sub">${c.seriesDropped} smaller series not drawn (top 8 kept).</span>` : ''}`;
}

// Cards fill themselves in whenever they appear (chat re-renders) and redraw on resize.
const ro = new ResizeObserver((entries) => { for (const e of entries) { const card = e.target.closest('.chart-card'); if (card) fill(card); } });
const seen = new WeakSet();
function scan() {
  for (const card of document.querySelectorAll('.chart-card')) {
    if (!seen.has(card)) { seen.add(card); ro.observe(card.querySelector('.chart-body')); }
    if (!card.dataset.ready) fill(card);
  }
}
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });

// ---------- Hover read-out (crosshair + values of every series at that time) ----------
document.addEventListener('mousemove', (e) => {
  const plot = e.target.closest?.('.chart-plot');
  document.querySelectorAll('.chart-plot .chart-hover:not([hidden])').forEach((h) => { if (h.parentElement !== plot) h.hidden = true; });
  if (!plot?._geo?.panels) return;
  const g = plot._geo;
  const svg = plot.querySelector('svg');
  const r = svg.getBoundingClientRect();
  const k = r.width / svg.viewBox.baseVal.width;
  const vx = (e.clientX - r.left) / k;
  const hover = plot.querySelector('.chart-hover');
  if (vx < g.ml || vx > g.ml + g.plotW) { hover.hidden = true; return; }
  const t = g.t0 + ((vx - g.ml) / g.plotW) * (g.t1 - g.t0);
  // nearest timestamp among all series
  let best = null;
  for (const p of g.panels) for (const s of p.series) for (const q of s.points) if (q[1] != null && (best == null || Math.abs(q[0] - t) < Math.abs(best - t))) best = q[0];
  if (best == null) { hover.hidden = true; return; }
  const bx = (g.ml + ((best - g.t0) / (g.t1 - g.t0 || 1)) * g.plotW) * k;
  hover.hidden = false;
  const cross = hover.querySelector('.chart-cross');
  cross.style.left = `${bx}px`;
  cross.style.top = `${g.panels[0].top * k}px`;
  cross.style.height = `${(g.panels.at(-1).bottom - g.panels[0].top) * k}px`;
  const rows = g.panels.flatMap((p) => p.series.map((s) => {
    const q = s.points.find((qq) => qq[0] === best);
    return `<div class="tip-row"><span class="sw" style="background:${s.color}"></span><span class="tn">${esc(trunc(seriesLabel(s), 40))}</span><b>${esc(fmt(q?.[1], s.unit))}</b></div>`;
  }));
  const tip = hover.querySelector('.chart-tip');
  tip.innerHTML = `<div class="tip-time">${esc(when(best))}</div>${rows.join('')}`;
  const left = bx + 14 + tip.offsetWidth > r.width ? bx - 14 - tip.offsetWidth : bx + 14;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, (e.clientY - r.top) - tip.offsetHeight / 2)}px`;
});

// ---------- Buttons ----------
async function svgToPng(svgText, scale = 2) {
  const m = svgText.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const w = +m[1], h = +m[2];
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Could not make the image'))), 'image/png'));
}
/** PNG of a loaded chart as it would be copied (chart or table view). */
export async function chartImage(id, view = 'chart') { const c = cache.get(id); return svgToPng(exportSvg(c, view)); }
function exportSvg(c, view) {
  if (view === 'table') return tableSvg(c, 1200);
  return c.view === 'bar' ? barSvg(c, 1000, { header: true }) : lineSvg(c, 1100, { header: true });
}
function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1800);
}
function csvOf(c) {
  const q = (v) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [c.table.columns.map((x) => q(x.name)), ...c.table.rows.map((r) => r.map(q))].map((r) => r.join(',')).join('\r\n');
}

document.addEventListener('click', async (e) => {
  const card = e.target.closest('.chart-card');
  if (!card) return;
  const id = card.dataset.chart;
  const c = cache.get(id);
  const v = e.target.closest('[data-chart-view]');
  if (v) { views.set(id, v.dataset.chartView); drawn.delete(card); fill(card); return; }
  if (!c || c instanceof Promise || c.error) return;
  const imgBtn = e.target.closest('[data-chart-image]');
  if (imgBtn) {
    const view = drawn.get(card)?.view || 'chart';
    const blob = svgToPng(exportSvg(c, view));
    try {
      if (!window.isSecureContext || !window.ClipboardItem) throw new Error('no clipboard');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash(imgBtn, '✓ Copied: paste it');
    } catch {
      // http:// or the browser refused: download it instead
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await blob);
      a.download = `${(c.resourceName || 'chart').replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      flash(imgBtn, '✓ Downloaded PNG');
    }
    return;
  }
  const csvBtn = e.target.closest('[data-chart-csv]');
  if (csvBtn) {
    const text = csvOf(c);
    try { await navigator.clipboard.writeText(text); flash(csvBtn, '✓ Copied'); } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select();
      flash(csvBtn, document.execCommand('copy') ? '✓ Copied' : 'Copy failed'); ta.remove();
    }
    return;
  }
  const td = e.target.closest('.chart-table td');
  if (td) td.parentElement.classList.toggle('open'); // click a row to wrap its long text
});
