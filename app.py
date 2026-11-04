"""Streamlit interface for the Hadoop-backed e-commerce analytics pipeline."""

from __future__ import annotations

import csv
import hashlib
import io
from datetime import date
from pathlib import Path
from typing import Any

import plotly.graph_objects as go
import streamlit as st

from src.hadoop.job_runner import environment_status
from src.config import load_settings
from src.utils.logging_config import configure_logging
from src.ingestion.validation import ValidationReport, validate_orders, validate_products
from src.orchestration import PipelineFailure, load_recent_runs, run_analysis

ROOT = Path(__file__).resolve().parent
SAMPLE_ORDERS = ROOT / "data" / "sample" / "orders.csv"
SAMPLE_PRODUCTS = ROOT / "data" / "sample" / "products.csv"
SETTINGS = load_settings()
configure_logging(SETTINGS.runs_directory / "application.log")
HADOOP = SETTINGS.hadoop_executable
JOB_JAR = SETTINGS.mapreduce_jar

st.set_page_config(page_title="E-Commerce Sales Analytics", page_icon="📊", layout="wide")
st.markdown(
    """
    <style>
    :root { --ink: #1d2a32; --muted: #66747c; --line: #dce3e5; --teal: #087e78; --coral: #d45d48; }
    .stApp { background-color: #f3f7f6; background-image: radial-gradient(#dce8e5 0.7px, transparent 0.7px); background-size: 18px 18px; }
    h1, h2, h3 { color: var(--ink); }
    [data-testid="stMetric"] { background: #ffffff; border: 1px solid var(--line); border-top: 3px solid var(--teal); padding: 12px 14px; border-radius: 6px; }
    [data-testid="stMetricValue"] { color: var(--ink); }
    [data-testid="stMetricLabel"] { color: var(--muted); }
    div[data-testid="stTabs"] button { color: var(--muted); }
    div[data-testid="stTabs"] button[aria-selected="true"] { color: var(--teal); border-color: var(--teal); }
    </style>
    """,
    unsafe_allow_html=True,
)


def money(cents: int) -> str:
    return f"${cents / 100:,.2f}"


def table_csv(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def report_errors(report: ValidationReport) -> list[dict[str, Any]]:
    return [{"Row": issue.row_number, "Issue": issue.message} for issue in report.issues]


def prepare_sources() -> tuple[bytes, bytes | None, str]:
    mode = st.sidebar.radio("Dataset", ("Bundled synthetic sample", "Upload CSV files"))
    if mode == "Bundled synthetic sample":
        return SAMPLE_ORDERS.read_bytes(), SAMPLE_PRODUCTS.read_bytes(), "Bundled synthetic sample"
    uploaded_orders = st.sidebar.file_uploader("Orders CSV", type=("csv",), key="orders_upload")
    uploaded_products = st.sidebar.file_uploader("Products CSV (optional)", type=("csv",), key="products_upload")
    if uploaded_orders is None:
        st.sidebar.info("Choose an orders CSV to begin.")
        return b"", None, "Upload"
    return uploaded_orders.getvalue(), uploaded_products.getvalue() if uploaded_products else None, uploaded_orders.name


def render_download(label: str, rows: list[dict[str, Any]], filename: str, key: str) -> None:
    if rows:
        st.download_button(label, table_csv(rows), file_name=filename, mime="text/csv", key=key)


st.title("E-Commerce Sales Analytics")
st.caption("Batch sales insights from validated CSV data, HDFS, and Java MapReduce.")

orders_bytes, products_bytes, source_label = prepare_sources()
environment = environment_status(HADOOP, JOB_JAR)
if environment["ready"]:
    st.sidebar.success("Hadoop CLI and project JAR detected")
else:
    missing = []
    if not environment["java_cli"]:
        missing.append("Java runtime")
    if not environment["hadoop_cli"]:
        missing.append("Hadoop CLI")
    if not environment["jar_compatible"]:
        missing.append("Java 8-11-compatible MapReduce JAR")
    st.sidebar.warning("Unavailable: " + " and ".join(missing) + ". No analytics are shown until a Hadoop run succeeds.")

orders_report: ValidationReport | None = None
products_report: ValidationReport | None = None
validation_error = ""
try:
    if orders_bytes:
        orders_report = validate_orders(orders_bytes)
        if products_bytes is not None:
            products_report = validate_products(products_bytes)
except (ValueError, OSError) as error:
    validation_error = str(error)

st.sidebar.markdown("#### Data quality")
if validation_error:
    st.sidebar.error(validation_error)
elif orders_report:
    st.sidebar.caption(
        f"Rows: {orders_report.total_rows:,} · Accepted: {orders_report.accepted_rows:,} · "
        f"Rejected: {orders_report.rejected_rows:,}"
    )
    if products_report:
        st.sidebar.caption(
            f"Product lookup: {products_report.accepted_rows} accepted, {products_report.rejected_rows} rejected"
        )
    if orders_report.issues:
        with st.sidebar.expander("Transaction validation issues", expanded=False):
            st.dataframe(report_errors(orders_report), hide_index=True, use_container_width=True)
    if products_report and products_report.issues:
        with st.sidebar.expander("Product lookup issues", expanded=False):
            st.dataframe(report_errors(products_report), hide_index=True, use_container_width=True)

filters: dict[str, Any] = {}
if orders_report and orders_report.clean_rows:
    clean_rows = orders_report.clean_rows
    available_dates = [date.fromisoformat(row["order_date"]) for row in clean_rows]
    minimum_date, maximum_date = min(available_dates), max(available_dates)
    selected_dates = st.sidebar.date_input(
        "Order date range",
        value=(minimum_date, maximum_date),
        min_value=minimum_date,
        max_value=maximum_date,
    )
    if isinstance(selected_dates, tuple) and len(selected_dates) == 2:
        filters["start_date"], filters["end_date"] = (selected_dates[0].isoformat(), selected_dates[1].isoformat())
    region_options = sorted({row["region"] for row in clean_rows if row["region"]})
    category_options = sorted({row["category"] for row in clean_rows if row["category"]})
    selected_region = st.sidebar.selectbox("Region", ["All regions", *region_options])
    selected_category = st.sidebar.selectbox("Category", ["All categories", *category_options])
    if selected_region != "All regions":
        filters["region"] = selected_region
    if selected_category != "All categories":
        filters["category"] = selected_category

source_fingerprint = hashlib.sha256(orders_bytes + (products_bytes or b"")).hexdigest()
active_context = (source_fingerprint, tuple(sorted(filters.items())))
if st.session_state.get("active_context") != active_context:
    st.session_state.pop("active_run", None)
    st.session_state["active_context"] = active_context

if st.sidebar.button("Run Hadoop MapReduce", type="primary", disabled=not bool(orders_report and orders_report.accepted_rows)):
    st.session_state.pop("active_run", None)
    st.session_state["latest_attempt"] = None
    try:
        with st.spinner("Uploading inputs to HDFS and running three Java MapReduce jobs…"):
            result = run_analysis(
                orders_bytes,
                products_bytes,
                hadoop=HADOOP,
                jar_path=JOB_JAR,
                runs_dir=SETTINGS.runs_directory,
                hdfs_root=SETTINGS.hdfs_root,
                timeout_seconds=SETTINGS.timeout_seconds,
                filters=filters,
            )
        st.session_state["active_run"] = result
        st.session_state["active_context"] = active_context
        st.session_state["latest_attempt"] = result
    except PipelineFailure as error:
        st.session_state.pop("active_run", None)
        st.session_state["latest_attempt"] = error.result

latest_attempt = st.session_state.get("latest_attempt")
if latest_attempt and latest_attempt.get("status") == "FAILED":
    st.error(f"Hadoop run {latest_attempt['run_id']} failed. {latest_attempt.get('error', '')}")

run = st.session_state.get("active_run")
if not run or run.get("status") != "SUCCEEDED":
    st.info(f"{source_label} is ready for validation. Analytics appear only after all MapReduce jobs succeed.")
    if latest_attempt and latest_attempt.get("status") == "FAILED":
        with st.expander("Run details"):
            st.json({
                key: latest_attempt.get(key)
                for key in ("run_id", "status", "started_at", "finished_at", "hdfs_paths", "jobs", "error")
            })
    elif recent_runs := load_recent_runs(SETTINGS.runs_directory, limit=1):
        previous = recent_runs[0]
        st.caption(
            f"Latest saved run: {previous['run_id']} · {previous['status']} · "
            f"started {previous.get('started_at', 'unknown time')} · "
            f"finished {previous.get('finished_at', 'unknown time')}. Previous metrics are not restored."
        )
        if previous.get("error"):
            st.warning(previous["error"])
else:
    aggregates = run["results"]["aggregates"]
    total = aggregates["total"][0]
    st.caption(
        f"Run {run['run_id']} · {run['selected_rows']:,} selected transaction lines · "
        f"HDFS {run['hdfs_paths']['input']}"
    )
    overview, products_tab, trends, comparisons, monitor = st.tabs(
        ("Overview", "Product Performance", "Sales Trends", "Regional & Category", "Data & Job Monitor")
    )

    with overview:
        kpis = st.columns(4)
        kpis[0].metric("Gross revenue", money(total["revenue_cents"]))
        kpis[1].metric("Units sold", f"{total['quantity']:,}")
        kpis[2].metric("Distinct orders", f"{total['order_count']:,}")
        kpis[3].metric("Average order value", money(total["average_order_value_cents"]))
        st.caption("Revenue = quantity × unit price. Average order value = total revenue ÷ distinct order IDs.")
        quality = run["validation"]["orders"]
        st.write(
            f"{quality['accepted_rows']:,} accepted of {quality['total_rows']:,} input rows; "
            f"{quality['rejected_rows']:,} rejected. Filters selected {run['selected_rows']:,} accepted lines."
        )
        render_download("Download totals CSV", aggregates["total"], "sales_totals.csv", "download_totals")

    with products_tab:
        revenue_rows = run["results"]["rankings"].get("revenue", [])[:10]
        quantity_rows = run["results"]["rankings"].get("quantity", [])[:10]
        names = {}
        for joined in run["results"]["joins"]["rows"]:
            names.setdefault(joined["product_id"], joined["product_name"] or joined["product_id"])
        left, right = st.columns(2)
        with left:
            st.subheader("Top 10 by revenue")
            revenue_table = [
                {"Rank": row["rank"], "Product": names.get(row["product_id"], row["product_id"]),
                 "Product ID": row["product_id"], "Revenue": money(row["revenue_cents"])}
                for row in revenue_rows
            ]
            if revenue_table:
                chart = go.Figure(go.Bar(x=[row["Product"] for row in revenue_table],
                                         y=[row["revenue_cents"] / 100 for row in revenue_rows],
                                         marker_color="#087e78"))
                chart.update_layout(height=330, margin=dict(l=10, r=10, t=10, b=10), yaxis_title="Revenue")
                st.plotly_chart(chart, use_container_width=True)
                st.dataframe(revenue_table, hide_index=True, use_container_width=True)
                render_download("Download revenue ranking", revenue_table, "top_products_revenue.csv", "download_revenue")
            else:
                st.info("No product ranking output was returned.")
        with right:
            st.subheader("Top 10 by units")
            quantity_table = [
                {"Rank": row["rank"], "Product": names.get(row["product_id"], row["product_id"]),
                 "Product ID": row["product_id"], "Units": row["quantity"]}
                for row in quantity_rows
            ]
            if quantity_table:
                st.dataframe(quantity_table, hide_index=True, use_container_width=True)
                render_download("Download quantity ranking", quantity_table, "top_products_quantity.csv", "download_quantity")
            else:
                st.info("No product ranking output was returned.")
        if run["has_profit"]:
            total_profit = next((row for row in run["results"]["joins"]["profit"] if row["product_id"] == "ALL"), None)
            if total_profit:
                st.metric("Gross profit", money(total_profit["profit_cents"]))
                st.caption("Profit = quantity × (unit price − unit cost), calculated by the Java product join job.")

    with trends:
        month_rows = sorted(aggregates.get("month", []), key=lambda row: row["key"])
        if month_rows:
            chart = go.Figure()
            chart.add_trace(go.Scatter(x=[row["key"] for row in month_rows],
                                       y=[row["revenue_cents"] / 100 for row in month_rows],
                                       mode="lines+markers", name="Revenue", line=dict(color="#087e78", width=3)))
            chart.add_trace(go.Scatter(x=[row["key"] for row in month_rows],
                                       y=[row["order_count"] for row in month_rows],
                                       mode="lines+markers", name="Distinct orders", yaxis="y2",
                                       line=dict(color="#d45d48", width=2)))
            chart.update_layout(height=390, margin=dict(l=10, r=10, t=20, b=10),
                                yaxis=dict(title="Revenue"), yaxis2=dict(title="Orders", overlaying="y", side="right"))
            st.plotly_chart(chart, use_container_width=True)
            monthly_table = [
                {"Month": row["key"], "Revenue": money(row["revenue_cents"]), "Units": row["quantity"],
                 "Distinct orders": row["order_count"]}
                for row in month_rows
            ]
            st.dataframe(monthly_table, hide_index=True, use_container_width=True)
            render_download("Download monthly trend", monthly_table, "monthly_sales.csv", "download_monthly")
        else:
            st.info("No monthly aggregate output was returned.")

    with comparisons:
        region_rows = sorted(aggregates.get("region", []), key=lambda row: row["revenue_cents"], reverse=True)
        category_rows = sorted(aggregates.get("category", []), key=lambda row: row["revenue_cents"], reverse=True)
        regions_column, categories_column = st.columns(2)
        with regions_column:
            st.subheader("Revenue by region")
            if region_rows:
                chart = go.Figure(go.Bar(x=[row["key"] for row in region_rows],
                                         y=[row["revenue_cents"] / 100 for row in region_rows],
                                         marker_color="#d45d48"))
                chart.update_layout(height=330, margin=dict(l=10, r=10, t=10, b=10))
                st.plotly_chart(chart, use_container_width=True)
                region_table = [{"Region": row["key"], "Revenue": money(row["revenue_cents"]), "Units": row["quantity"]} for row in region_rows]
                st.dataframe(region_table, hide_index=True, use_container_width=True)
                render_download("Download regions", region_table, "regional_sales.csv", "download_regions")
            else:
                st.info("No regional aggregate output was returned.")
        with categories_column:
            st.subheader("Revenue by category")
            if category_rows:
                chart = go.Figure(go.Pie(labels=[row["key"] for row in category_rows],
                                         values=[row["revenue_cents"] for row in category_rows], hole=0.45,
                                         marker_colors=["#087e78", "#d45d48", "#e0a52b", "#426b8a", "#6b8f71"]))
                chart.update_layout(height=330, margin=dict(l=10, r=10, t=10, b=10))
                st.plotly_chart(chart, use_container_width=True)
                category_table = [{"Category": row["key"], "Revenue": money(row["revenue_cents"]), "Units": row["quantity"]} for row in category_rows]
                st.dataframe(category_table, hide_index=True, use_container_width=True)
                render_download("Download categories", category_table, "category_sales.csv", "download_categories")
            else:
                st.info("No category aggregate output was returned.")

    with monitor:
        st.write(f"**Status:** {run['status']} · **Started:** {run['started_at']} · **Finished:** {run['finished_at']}")
        st.write(f"**HDFS input:** `{run['hdfs_paths']['input']}`")
        st.write(f"**Missing product lookup matches:** {run['missing_product_matches']}")
        st.dataframe(
            [{"Job": job["name"], "Status": job["status"], "Seconds": job["duration_seconds"], "Output": job["output_path"]}
             for job in run["jobs"]],
            hide_index=True,
            use_container_width=True,
        )
        for job in run["jobs"]:
            if job["status"] != "SUCCEEDED" or job["stderr"]:
                with st.expander(f"{job['name']} logs"):
                    st.code(job["stderr"] or job["stdout"] or "No logs captured.")
        st.write("HDFS outputs", run["hdfs_paths"])
        st.subheader("Recent runs")
        recent_runs = load_recent_runs(SETTINGS.runs_directory)
        if recent_runs:
            st.dataframe(
                [{"Run": item["run_id"], "Status": item["status"], "Finished": item.get("finished_at"), "Error": item.get("error", "")}
                 for item in recent_runs],
                hide_index=True,
                use_container_width=True,
            )
        else:
            st.caption("No saved runs are available.")