(() => {
  "use strict";

  const BLUE = "#2563eb", BLUE_LIGHT = "#93c5fd", ORANGE = "#f59e0b", ORANGE_LIGHT = "#fcd34d";
  const CAT_PAL = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899"];
  const GRID = "rgba(15,23,42,.08)";
  const REQUIRED = ["order_id", "order_date", "product_id", "quantity", "unit_price", "region", "category"];

  const view = document.getElementById("view");
  const exportsRegistry = {};
  const state = { sample: null, custom: null, customName: "" };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (cents) => "₹" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => Number(n).toLocaleString("en-US");

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const header = rows.shift().map((h) => h.trim());
    return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
  }

  function toCSV(rows) {
    if (!rows.length) return "";
    const head = Object.keys(rows[0]);
    const cell = (v) => { v = String(v ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [head.join(","), ...rows.map((r) => head.map((k) => cell(r[k])).join(","))].join("\n");
  }

  function validateOrders(rows) {
    if (!rows.length) throw new Error("The orders file has no data rows.");
    const missing = REQUIRED.filter((c) => !(c in rows[0]));
    if (missing.length) throw new Error("Missing required column(s): " + missing.join(", "));
    const clean = [], issues = [];
    rows.forEach((r, i) => {
      const qty = Number(r.quantity), price = Number(r.unit_price);
      let msg = "";
      if (!r.order_id) msg = "order_id is empty";
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.order_date) || Number.isNaN(Date.parse(r.order_date))) msg = "order_date must be YYYY-MM-DD";
      else if (!r.product_id) msg = "product_id is empty";
      else if (!Number.isInteger(qty) || qty <= 0) msg = "quantity must be a positive whole number";
      else if (r.unit_price === "" || !Number.isFinite(price) || price < 0) msg = "unit_price must be a non-negative number";
      else if (!r.region) msg = "region is empty";
      else if (!r.category) msg = "category is empty";
      if (msg) issues.push({ row: i + 2, message: msg });
      else clean.push({ ...r, quantity: qty, unit_price: price, cents: Math.round(price * 100), customer_id: r.customer_id || "CUST-UNKNOWN" });
    });
    return { clean, issues, total: rows.length };
  }

  function buildProducts(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!r.product_id) continue;
      const cost = r.unit_cost === undefined || r.unit_cost === "" ? null : Number(r.unit_cost);
      map.set(r.product_id, { name: r.product_name || r.product_id, cost: Number.isFinite(cost) ? Math.round(cost * 100) : null });
    }
    return map;
  }

  function analyze(orders, products) {
    const groups = { month: new Map(), region: new Map(), category: new Map(), product: new Map(), customer: new Map() };
    const all = { revenue: 0, quantity: 0, orders: new Set() };
    let profit = 0, hasCost = false;
    const add = (map, key, o, rev) => {
      let g = map.get(key);
      if (!g) { g = { key, revenue: 0, quantity: 0, orders: new Set(), profit: 0, regions: new Set() }; map.set(key, g); }
      g.revenue += rev; g.quantity += o.quantity; g.orders.add(o.order_id); g.regions.add(o.region);
      return g;
    };
    for (const o of orders) {
      const rev = o.cents * o.quantity;
      all.revenue += rev; all.quantity += o.quantity; all.orders.add(o.order_id);
      add(groups.month, o.order_date.slice(0, 7), o, rev);
      add(groups.region, o.region, o, rev);
      add(groups.category, o.category, o, rev);
      add(groups.customer, o.customer_id, o, rev);
      const pg = add(groups.product, o.product_id, o, rev);
      const p = products.get(o.product_id);
      if (p && p.cost !== null) { const pr = o.quantity * (o.cents - p.cost); pg.profit += pr; profit += pr; hasCost = true; }
    }
    const finish = (map) => [...map.values()].map((g) => ({
      key: g.key, revenue: g.revenue, quantity: g.quantity, orderCount: g.orders.size, profit: g.profit,
      regions: [...g.regions].sort(), aov: g.orders.size ? Math.round(g.revenue / g.orders.size) : 0,
    }));
    return {
      orders,
      total: { revenue: all.revenue, quantity: all.quantity, orderCount: all.orders.size, aov: all.orders.size ? Math.round(all.revenue / all.orders.size) : 0 },
      month: finish(groups.month).sort((a, b) => a.key.localeCompare(b.key)),
      region: finish(groups.region).sort((a, b) => b.revenue - a.revenue),
      category: finish(groups.category).sort((a, b) => b.revenue - a.revenue),
      product: finish(groups.product).sort((a, b) => b.revenue - a.revenue),
      customer: finish(groups.customer).sort((a, b) => b.revenue - a.revenue),
      profit, hasCost, products,
    };
  }

  const dataset = () => state.custom || state.sample;
  const pname = (d, id) => (d.products.get(id) || {}).name || id;

  function plot(id, data, layout) {
    Plotly.newPlot(id, data, {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, system-ui, sans-serif", color: "#0f172a" }, ...layout,
    }, { displayModeBar: false, responsive: true });
  }

  function table(rows, cols, key) {
    if (key) exportsRegistry[key] = rows.map((r) => Object.fromEntries(cols.map((c) => [c.h, c.raw ? c.raw(r) : c.f(r)])));
    const head = cols.map((c) => `<th class="${c.n ? "num" : ""}">${esc(c.h)}</th>`).join("");
    const body = rows.map((r) => "<tr>" + cols.map((c) => `<td class="${(c.n ? "num " : "") + (c.cls || "")}">${esc(c.f(r))}</td>`).join("") + "</tr>").join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
      (key ? `<div class="toolbar"><button class="ghost" data-export="${key}">Export CSV</button></div>` : "");
  }

  const kpi = (label, value, sub) => `<div class="card kpi"><div class="l">${label}</div><div class="v">${value}</div>${sub ? `<span class="pill">${sub}</span>` : ""}</div>`;
  const header = (title, sub) => `<div class="page-title">${title}</div><div class="page-sub">${sub}</div>`;
  const notice = () => state.custom ? `<div class="notice">Analyzing your uploaded dataset: <b>${esc(state.customName)}</b> (${num(state.custom.orders.length)} valid lines). Reset it in Settings.</div>` : "";

  // ---------- pages ----------
  const pages = {
    dashboard(d) {
      const t = d.total;
      const margin = d.hasCost && t.revenue ? Math.round((d.profit / t.revenue) * 100) : null;
      const byOrder = new Map();
      for (const o of d.orders) {
        const r = byOrder.get(o.order_id) || { id: o.order_id, date: o.order_date, region: o.region, qty: 0, amount: 0 };
        r.qty += o.quantity; r.amount += o.cents * o.quantity; byOrder.set(o.order_id, r);
      }
      const recent = [...byOrder.values()].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 8);

      view.innerHTML = header("Dashboard", "Sales overview computed from the validated order lines") + notice() +
        `<div class="grid g4">
          ${kpi("Gross revenue", money(t.revenue), "All regions")}
          ${kpi("Avg order value", money(t.aov), "Per distinct order")}
          ${kpi("Distinct orders", num(t.orderCount), num(t.quantity) + " units sold")}
          ${d.hasCost ? kpi("Gross profit", money(d.profit), margin + "% margin") : kpi("Gross profit", "n/a", "Upload products CSV")}
        </div>
        <div class="grid g-wide">
          <div class="card"><div id="c-month" style="height:340px"></div></div>
          <div class="card"><div id="c-gauge" style="height:290px"></div>
            <div class="legend"><span><i style="background:#fecaca"></i>Low (&lt;40%)</span><span><i style="background:#fde68a"></i>Medium</span><span><i style="background:#bbf7d0"></i>Good (&gt;70%)</span></div></div>
        </div>
        <div class="grid g-heat">
          <div class="card"><h3>Monthly Activity</h3><div id="c-heat" style="height:300px"></div></div>
          <div class="card"><h3>Recent Transactions</h3>${table(recent, [
            { h: "Order ID", f: (r) => r.id }, { h: "Date", f: (r) => r.date }, { h: "Region", f: (r) => r.region },
            { h: "Units", f: (r) => r.qty, n: 1 }, { h: "Amount", f: (r) => money(r.amount), n: 1, cls: "amt" },
          ])}</div>
        </div>`;

      const months = d.month.map((m) => m.key);
      const maxRev = Math.max(...d.month.map((m) => m.revenue));
      plot("c-month", [
        { type: "bar", x: months, y: d.month.map((m) => m.revenue / 100), name: "Revenue (bars, left axis)",
          marker: { color: d.month.map((m) => (m.revenue === maxRev ? BLUE : BLUE_LIGHT)) }, hovertemplate: "<b>%{x}</b><br>Revenue: ₹%{y:,.2f}<extra></extra>" },
        { type: "scatter", mode: "lines+markers", x: months, y: d.month.map((m) => m.orderCount), name: "Orders (line, right axis)", yaxis: "y2",
          line: { color: ORANGE, width: 3 }, marker: { size: 8, color: ORANGE }, hovertemplate: "<b>%{x}</b><br>Orders: %{y}<extra></extra>" },
      ], {
        title: { text: `<b>Transaction Activity</b><br><span style="font-size:22px">${money(t.revenue)}</span> <span style="font-size:12px;color:#64748b">Total Revenue</span>`, x: 0, y: 0.97, yanchor: "top", font: { size: 14 } },
        margin: { l: 60, r: 50, t: 85, b: 50 }, bargap: 0.3, hovermode: "x unified",
        xaxis: { type: "date", tickformat: "%b %Y", hoverformat: "%b %Y", title: "Month" },
        yaxis: { gridcolor: GRID, tickprefix: "₹", title: "Revenue (₹)" },
        yaxis2: { overlaying: "y", side: "right", showgrid: false, title: "Orders" },
        legend: { orientation: "h", y: 1.0, yanchor: "bottom", x: 0.5, xanchor: "center" },
      });

      plot("c-gauge", [{
        type: "indicator", mode: "gauge+number", value: margin ?? 0, domain: { x: [0, 1], y: [0, 0.78] },
        number: { suffix: margin === null ? "" : "%", font: { size: 38 } },
        gauge: {
          axis: { range: [0, 100], nticks: 6 }, bar: { color: BLUE, thickness: 0.3 }, bgcolor: "white", borderwidth: 0,
          steps: [{ range: [0, 40], color: "#fecaca" }, { range: [40, 70], color: "#fde68a" }, { range: [70, 100], color: "#bbf7d0" }],
          threshold: { line: { color: "#0f172a", width: 3 }, thickness: 0.8, value: margin ?? 0 },
        },
      }], { title: { text: "<b>Sales Performance</b><br><span style='font-size:11px;color:#64748b'>Profit Margin</span>", x: 0, y: 0.97, yanchor: "top", font: { size: 14 } }, margin: { l: 20, r: 20, t: 70, b: 0 } });

      const regions = d.region.map((r) => r.key).sort();
      const z = regions.map((reg) => months.map((m) => d.orders.filter((o) => o.region === reg && o.order_date.startsWith(m)).reduce((s, o) => s + o.quantity, 0)));
      plot("c-heat", [{
        type: "heatmap", z, x: months, y: regions, xgap: 3, ygap: 3,
        colorscale: [[0, "#eff6ff"], [0.4, "#93c5fd"], [0.75, "#3b82f6"], [1, "#1e3a8a"]],
        colorbar: { title: "Units", thickness: 10 }, hovertemplate: "<b>%{y}</b> %{x}<br>Units: %{z}<extra></extra>",
      }], { margin: { l: 70, r: 10, t: 5, b: 60 }, xaxis: { type: "category", tickangle: -45, title: "Month", nticks: 14 } });
    },

    products(d) {
      const top = d.product.slice(0, 10);
      view.innerHTML = header("Products", "Product performance ranked by revenue and units") + notice() +
        `<div class="grid g3">${d.product.slice(0, 3).map((p, i) => `<div class="card top-card"><span class="badge">Rank #${i + 1}</span>
          <div class="name">${esc(pname(d, p.key))}</div><div class="amt">${money(p.revenue)}</div>
          <div class="meta">${num(p.quantity)} units · ${p.orderCount} orders</div></div>`).join("")}</div>
        <div class="grid g2">
          <div class="card"><h3>Top 10 by Revenue</h3><div id="c-top" style="height:380px"></div></div>
          <div class="card"><h3>Revenue by Category</h3><div id="c-cat" style="height:380px"></div></div>
        </div>
        <div class="card"><h3>Full Product Table</h3>${table(d.product, [
          { h: "Rank", f: (r) => d.product.indexOf(r) + 1, n: 1 }, { h: "Product", f: (r) => pname(d, r.key) }, { h: "ID", f: (r) => r.key },
          { h: "Revenue", f: (r) => money(r.revenue), raw: (r) => (r.revenue / 100).toFixed(2), n: 1 }, { h: "Units", f: (r) => r.quantity, n: 1 },
          { h: "Orders", f: (r) => r.orderCount, n: 1 }, { h: "Profit", f: (r) => (d.hasCost ? money(r.profit) : "n/a"), raw: (r) => (d.hasCost ? (r.profit / 100).toFixed(2) : ""), n: 1 },
        ], "products.csv")}</div>`;

      plot("c-top", [{
        type: "bar", orientation: "h", y: top.map((p) => pname(d, p.key)), x: top.map((p) => p.revenue / 100),
        marker: { color: top.map((_, i) => (i === 0 ? BLUE : BLUE_LIGHT)) }, text: top.map((p) => money(p.revenue)), textposition: "outside", cliponaxis: false,
        hovertemplate: "<b>%{y}</b><br>₹%{x:,.2f}<extra></extra>",
      }], { margin: { l: 10, r: 70, t: 5, b: 40 }, bargap: 0.3, xaxis: { gridcolor: GRID, tickprefix: "₹", title: "Revenue (₹)" }, yaxis: { autorange: "reversed", automargin: true } });
      plot("c-cat", [{
        type: "pie", labels: d.category.map((c) => c.key), values: d.category.map((c) => c.revenue), hole: 0.5, sort: false,
        marker: { colors: CAT_PAL, line: { color: "white", width: 2 } }, textinfo: "label+percent", textposition: "outside",
        hovertemplate: "<b>%{label}</b><br>₹%{value:,}<br>%{percent}<extra></extra>",
      }], { margin: { l: 30, r: 30, t: 20, b: 20 }, showlegend: false });
    },

    orders(d, month = "All") {
      const months = [...new Set(d.orders.map((o) => o.order_date.slice(0, 7)))].sort();
      const rows = month === "All" ? d.orders : d.orders.filter((o) => o.order_date.startsWith(month));
      const rev = rows.reduce((s, o) => s + o.cents * o.quantity, 0);
      view.innerHTML = header("Orders", "All validated transaction lines from the active dataset") + notice() +
        `<div class="grid g3">${kpi("Revenue", money(rev))}${kpi("Units sold", num(rows.reduce((s, o) => s + o.quantity, 0)))}${kpi("Distinct orders", num(new Set(rows.map((o) => o.order_id)).size))}</div>
        <div class="card"><div class="field"><label for="month-filter">Filter by month</label>
          <select id="month-filter"><option>All</option>${months.map((m) => `<option ${m === month ? "selected" : ""}>${m}</option>`).join("")}</select></div>
        ${table(rows, [
          { h: "Order ID", f: (o) => o.order_id }, { h: "Date", f: (o) => o.order_date }, { h: "Product", f: (o) => pname(d, o.product_id) },
          { h: "Category", f: (o) => o.category }, { h: "Region", f: (o) => o.region }, { h: "Qty", f: (o) => o.quantity, n: 1 },
          { h: "Unit Price", f: (o) => "₹" + o.unit_price.toFixed(2), raw: (o) => o.unit_price.toFixed(2), n: 1 },
          { h: "Line Total", f: (o) => money(o.cents * o.quantity), raw: (o) => ((o.cents * o.quantity) / 100).toFixed(2), n: 1, cls: "amt" },
        ], "orders.csv")}</div>`;
      document.getElementById("month-filter").addEventListener("change", (e) => pages.orders(d, e.target.value));
    },

    customers(d) {
      const c = d.customer, n = c.length;
      const avgRev = n ? Math.round(c.reduce((s, x) => s + x.revenue, 0) / n) : 0;
      const avgOrd = n ? c.reduce((s, x) => s + x.orderCount, 0) / n : 0;
      const top = c.slice(0, 10);
      view.innerHTML = header("Customers", "Customer insights derived from order transactions") + notice() +
        `<div class="grid g3">${kpi("Total customers", num(n))}${kpi("Avg revenue / customer", money(avgRev))}${kpi("Avg orders / customer", avgOrd.toFixed(1))}</div>
        <div class="grid g2">
          <div class="card"><h3>Orders per Customer</h3><div id="c-hist" style="height:300px"></div></div>
          <div class="card"><h3>Top 10 Customers by Revenue</h3><div id="c-topc" style="height:340px"></div></div>
        </div>
        <div class="card">${table(c, [
          { h: "Customer ID", f: (r) => r.key }, { h: "Orders", f: (r) => r.orderCount, n: 1 }, { h: "Units", f: (r) => r.quantity, n: 1 },
          { h: "Revenue", f: (r) => money(r.revenue), raw: (r) => (r.revenue / 100).toFixed(2), n: 1, cls: "amt" }, { h: "Regions", f: (r) => r.regions.join(", ") },
        ], "customers.csv")}</div>`;

      plot("c-hist", [{ type: "histogram", x: c.map((x) => x.orderCount), marker: { color: BLUE }, texttemplate: "%{y}", textposition: "outside", hovertemplate: "%{x} orders: %{y} customers<extra></extra>" }],
        { margin: { l: 50, r: 10, t: 20, b: 50 }, bargap: 0.15, xaxis: { title: "Orders placed per customer", dtick: 1 }, yaxis: { gridcolor: GRID, title: "Number of customers" } });
      plot("c-topc", [{
        type: "bar", orientation: "h", y: top.map((x) => x.key), x: top.map((x) => x.revenue / 100),
        marker: { color: top.map((_, i) => (i === 0 ? ORANGE : ORANGE_LIGHT)) }, text: top.map((x) => money(x.revenue)), textposition: "outside", cliponaxis: false,
        hovertemplate: "<b>%{y}</b><br>₹%{x:,.2f}<extra></extra>",
      }], { margin: { l: 10, r: 70, t: 10, b: 40 }, bargap: 0.3, xaxis: { gridcolor: GRID, tickprefix: "₹", title: "Revenue (₹)" }, yaxis: { autorange: "reversed", automargin: true } });
    },

    analytics(d, tab = "trends") {
      const tabs = [["trends", "Sales Trends"], ["regional", "Regional"], ["pipeline", "Pipeline"]];
      let body = "";
      if (tab === "trends") {
        body = `<div class="card"><div id="c-trend" style="height:380px"></div></div><div class="card" style="margin-top:16px">${table(d.month, [
          { h: "Month", f: (r) => r.key }, { h: "Revenue", f: (r) => money(r.revenue), raw: (r) => (r.revenue / 100).toFixed(2), n: 1 }, { h: "Units", f: (r) => r.quantity, n: 1 },
          { h: "Orders", f: (r) => r.orderCount, n: 1 }, { h: "Avg Order Value", f: (r) => money(r.aov), raw: (r) => (r.aov / 100).toFixed(2), n: 1 },
        ], "monthly_sales.csv")}</div>`;
      } else if (tab === "regional") {
        body = `<div class="grid g2"><div class="card"><h3>Revenue by Region</h3><div id="c-reg" style="height:340px"></div></div>
          <div class="card"><h3>Revenue by Category</h3><div id="c-cat2" style="height:340px"></div></div></div>`;
      } else {
        body = `<div class="card"><h3>Hadoop Pipeline (original project)</h3><div id="c-sankey" style="height:320px"></div></div>
          <div class="card" style="margin-top:16px"><h3>MapReduce Jobs</h3>${table([
            { job: "SalesAggregation.java", out: "PRODUCT, CATEGORY, REGION, MONTH, TOTAL", what: "revenue, quantity, distinct order IDs" },
            { job: "ProductRanking.java", out: "Revenue-sorted product_id", what: "Global rank (single reducer for determinism)" },
            { job: "ProductJoin.java", out: "product_id", what: "product_name, profit (when unit_cost present)" },
          ], [{ h: "Job", f: (r) => r.job }, { h: "Output keys", f: (r) => r.out }, { h: "Computed", f: (r) => r.what }])}</div>
          <p class="muted" style="font-size:.8rem">This web version recomputes the same aggregates in your browser. The Hadoop jobs themselves live in <code>hadoop-jobs/</code>.</p>`;
      }
      view.innerHTML = header("Analytics", "Trends, regional breakdowns and the project pipeline") + notice() +
        `<div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}</div>` + body;
      view.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => pages.analytics(d, b.dataset.tab)));

      if (tab === "trends") {
        const m = d.month.map((x) => x.key);
        plot("c-trend", [
          { type: "scatter", mode: "lines+markers", x: m, y: d.month.map((x) => x.revenue / 100), name: "Revenue (₹, left axis)", fill: "tozeroy", fillcolor: "rgba(37,99,235,.12)",
            line: { color: BLUE, width: 3 }, marker: { size: 8, color: BLUE }, hovertemplate: "Revenue: ₹%{y:,.2f}<extra></extra>" },
          { type: "scatter", mode: "lines+markers", x: m, y: d.month.map((x) => x.quantity), name: "Units sold (right axis)", yaxis: "y2",
            line: { color: ORANGE, width: 3 }, marker: { size: 8, color: ORANGE }, hovertemplate: "Units: %{y}<extra></extra>" },
        ], { margin: { l: 60, r: 50, t: 30, b: 50 }, hovermode: "x unified", xaxis: { type: "date", tickformat: "%b %Y", hoverformat: "%b %Y", title: "Month" },
          yaxis: { gridcolor: GRID, tickprefix: "₹", title: "Revenue (₹)" }, yaxis2: { overlaying: "y", side: "right", showgrid: false, title: "Units sold" },
          legend: { orientation: "h", y: 1.1 } });
      } else if (tab === "regional") {
        const bar = (rows) => [{ type: "bar", x: rows.map((r) => r.key), y: rows.map((r) => r.revenue / 100), marker: { color: CAT_PAL }, text: rows.map((r) => money(r.revenue)),
          textposition: "outside", cliponaxis: false, hovertemplate: "<b>%{x}</b><br>₹%{y:,.2f}<extra></extra>" }];
        const lay = (x) => ({ margin: { l: 60, r: 10, t: 20, b: 50 }, bargap: 0.4, xaxis: { title: x }, yaxis: { gridcolor: GRID, tickprefix: "₹", title: "Revenue (₹)" } });
        plot("c-reg", bar(d.region), lay("Region"));
        plot("c-cat2", bar(d.category), lay("Category"));
      } else {
        plot("c-sankey", [{
          type: "sankey", arrangement: "snap", pad: 20, thickness: 28,
          node: { label: ["CSV Input", "Validation", "HDFS", "SalesAggregation", "ProductRanking", "ProductJoin", "Output Reader", "Dashboard"],
            color: ["#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8", "#f59e0b", "#10b981", "#8b5cf6"] },
          link: { source: [0, 1, 2, 2, 2, 3, 4, 5, 6], target: [1, 2, 3, 4, 5, 6, 6, 6, 7], value: [3, 3, 1, 1, 1, 1, 1, 1, 3], color: Array(9).fill("rgba(59,130,246,.25)") },
        }], { margin: { l: 0, r: 0, t: 10, b: 10 }, font: { size: 12 } });
      }
    },

    settings() {
      view.innerHTML = header("Settings &amp; Data Ingestion", "Analyze your own sales data. Files are processed in your browser and are never uploaded.") +
        `<div class="grid g-wide">
          <div class="card"><h3>Upload Custom Sales Data</h3>
            <div class="field"><label for="f-orders">Orders CSV (required)</label><input type="file" id="f-orders" accept=".csv,text/csv"></div>
            <div class="field"><label for="f-products">Products CSV (optional — adds product names and profit)</label><input type="file" id="f-products" accept=".csv,text/csv"></div>
            <div class="toolbar"><button id="btn-analyze">Analyze dataset</button><button id="btn-reset" class="ghost" ${state.custom ? "" : "disabled"}>Reset to sample data</button></div>
            <div id="upload-msg" style="margin-top:16px"></div>
          </div>
          <div class="card"><h3>Expected format</h3>
            <p class="muted" style="font-size:.82rem;line-height:1.7"><b>orders.csv</b> columns:<br><code>order_id</code> <code>order_date</code> (YYYY-MM-DD) <code>product_id</code> <code>quantity</code> <code>unit_price</code> <code>region</code> <code>category</code> and optional <code>customer_id</code>.<br><br>
            <b>products.csv</b> columns:<br><code>product_id</code> <code>product_name</code> <code>unit_cost</code>.</p></div>
        </div>`;

      const msg = document.getElementById("upload-msg");
      document.getElementById("btn-reset").addEventListener("click", () => { state.custom = null; state.customName = ""; updateSidebar(); pages.settings(); });
      document.getElementById("btn-analyze").addEventListener("click", async () => {
        const of = document.getElementById("f-orders").files[0], pf = document.getElementById("f-products").files[0];
        if (!of) { msg.innerHTML = `<div class="notice err">Choose an orders CSV first.</div>`; return; }
        try {
          const report = validateOrders(parseCSV(await of.text()));
          if (!report.clean.length) throw new Error("No valid rows were found. First issue: " + (report.issues[0] ? `row ${report.issues[0].row}: ${report.issues[0].message}` : "unknown"));
          const products = pf ? buildProducts(parseCSV(await pf.text())) : new Map();
          state.custom = analyze(report.clean, products); state.customName = of.name; updateSidebar();
          const shown = report.issues.slice(0, 10).map((i) => `<li>Row ${i.row}: ${esc(i.message)}</li>`).join("");
          msg.innerHTML = `<div class="notice">Loaded <b>${num(report.clean.length)}</b> of ${num(report.total)} rows (${num(report.issues.length)} rejected).
            ${shown ? `<ul>${shown}</ul>` : ""}<div class="toolbar"><a class="btn" href="#dashboard" style="text-decoration:none">View dashboard</a></div></div>`;
          document.getElementById("btn-reset").disabled = false;
        } catch (e) { msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
      });
    },
  };

  // ---------- app shell ----------
  function updateSidebar() {
    const d = dataset();
    document.getElementById("dataset-box").innerHTML = state.custom
      ? `<div class="t">Active Dataset</div><div class="s">Custom: ${esc(state.customName)}<br>${num(d.total.orderCount)} orders analyzed</div>`
      : `<div class="t">Sample Dataset</div><div class="s">${d ? num(d.total.orderCount) : 0} orders<br>Bundled demo data</div>`;
  }

  function render() {
    const page = (location.hash || "#dashboard").slice(1);
    const name = pages[page] ? page : "dashboard";
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === name));
    if (!dataset()) return;
    pages[name](dataset());
    window.scrollTo(0, 0);
  }

  view.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-export]");
    if (!btn) return;
    const rows = exportsRegistry[btn.dataset.export] || [];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toCSV(rows)], { type: "text/csv" }));
    a.download = btn.dataset.export;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  window.addEventListener("hashchange", render);

  Promise.all(["data/orders.csv", "data/products.csv"].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); })))
    .then(([o, p]) => {
      const report = validateOrders(parseCSV(o));
      state.sample = analyze(report.clean, buildProducts(parseCSV(p)));
      updateSidebar();
      render();
    })
    .catch((e) => { view.innerHTML = `<div class="notice err">Could not load the sample data: ${esc(e.message)}</div>`; });
})();
