"""Field Twin Violet weekly inventory report.

Runs from GitHub every Friday morning. For every person with anything in Violet it builds a PDF from what is
already in the system: stock on hand by section and location, what changed this week, and week over week trends
rebuilt from the full history. The PDF goes into that person's own folder in the violet-photos bucket and the
week's totals go into violet_reports, so the app lists every report and later reports can compare against it.

Needs SUPABASE_ACCESS_TOKEN (the account token saved as a GitHub secret). Set ONLY_OWNER to build one person's
report, and OUT_DIR to also keep a local copy of each PDF.
"""
import datetime as dt
import json
import os
import sys
import urllib.request
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.linecharts import HorizontalLineChart
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

REF = os.environ.get("SUPABASE_REF", "zasyjjoypkpvyqdueums")
TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
BUCKET = "violet-photos"
TZ = ZoneInfo("America/Los_Angeles")
WEEKS = 8

BLUE = colors.HexColor("#1f5fbf")
LIGHT = colors.HexColor("#e8f0fb")
RULE = colors.HexColor("#b9cbe6")
GREY = colors.HexColor("#5b6b80")

VERB = {"received": "Added", "moved": "Moved", "installed": "Installed", "pulled": "Pulled failed",
        "returned": "Sent back", "written_off": "Used up or tossed", "checked": "Tested"}
SECTIONS = [("Company parts", lambda c: c["kind"] == "part" and c["company"]),
            ("Other parts", lambda c: c["kind"] == "part" and not c["company"]),
            ("Tools", lambda c: c["kind"] == "tool"),
            ("Consumables", lambda c: c["kind"] == "consumable")]


def api(method, url, body=None, headers=None, raw=False):
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    h = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "User-Agent": "field-twin-violet-report"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        out = r.read()
    return json.loads(out) if out and not raw else out


def sql(query):
    return api("POST", f"https://api.supabase.com/v1/projects/{REF}/database/query", {"query": query})


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def bucket(c):
    return "bad" if c in ("damaged", "failed") else "good"


def stock(events, holders, until=None):
    """Mirror of the app's math. Returns {(catalog_id, holder_id): {"good": n, "bad": n}}."""
    q = defaultdict(lambda: {"good": 0.0, "bad": 0.0})
    serials = {}
    for e in events:
        if until and e["at"] > until:
            break
        n = float(e["qty"] or 0)
        sn = (e["serial"] or "").strip().upper()
        if sn:
            if e["type"] == "checked":
                if sn in serials:
                    serials[sn]["cond"] = bucket(e["condition"])
                continue
            st = {"cat": e["catalog_id"], "holder": e["to_holder"] if e["to_holder"] and e["type"] not in ("installed", "written_off") else None,
                  "cond": bucket(e["condition"])}
            serials[sn] = st
            continue
        if e["type"] == "checked":
            h = e["to_holder"] or e["from_holder"]
            if h:
                q[(e["catalog_id"], h)][bucket(e["from_condition"] or "good")] -= n
                q[(e["catalog_id"], h)][bucket(e["condition"])] += n
            continue
        if e["from_holder"]:
            q[(e["catalog_id"], e["from_holder"])][bucket(e["condition"])] -= n
        if e["to_holder"]:
            q[(e["catalog_id"], e["to_holder"])][bucket(e["condition"])] += n
    for st in serials.values():
        if st["holder"]:
            q[(st["cat"], st["holder"])][st["cond"]] += 1
    return q


def totals(q, cat, holders):
    """Units and distinct items on hand per section. On hand means working and not in a return box."""
    out = {}
    for name, f in SECTIONS:
        units, items = 0.0, set()
        for (cid, h), v in q.items():
            c = cat.get(cid)
            if not c or not f(c) or holders.get(h, {}).get("kind") == "return":
                continue
            if v["good"] > 1e-9:
                units += v["good"]
                items.add(cid)
        out[name] = {"items": len(items), "units": units}
    out["all"] = {"items": sum(v["items"] for v in out.values()), "units": sum(v["units"] for v in out.values())}
    return out


def num(n):
    n = round(n, 2)
    return str(int(n)) if n == int(n) else str(n)


def delta(n):
    n = round(n, 2)
    if n == 0:
        return "no change"
    return ("up " if n > 0 else "down ") + num(abs(n))


def table(data, widths, right_from=None):
    t = Table(data, colWidths=widths, repeatRows=1)
    style = [("BACKGROUND", (0, 0), (-1, 0), BLUE), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
             ("FONTSIZE", (0, 0), (-1, -1), 8.5), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
             ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("GRID", (0, 0), (-1, -1), 0.25, RULE)]
    if right_from is not None:
        style.append(("ALIGN", (right_from, 0), (-1, -1), "RIGHT"))
    t.setStyle(TableStyle(style))
    return t


def chart(labels, units, entries):
    d = Drawing(540, 190)
    lc = HorizontalLineChart()
    lc.x, lc.y, lc.width, lc.height = 40, 30, 220, 130
    lc.data = [units]
    lc.categoryAxis.categoryNames = labels
    lc.categoryAxis.labels.fontSize = 6.5
    lc.categoryAxis.labels.angle = 35
    lc.categoryAxis.labels.boxAnchor = "ne"
    lc.valueAxis.valueMin = 0
    lc.valueAxis.labels.fontSize = 7
    lc.lines[0].strokeColor = BLUE
    lc.lines[0].strokeWidth = 2
    d.add(lc)
    d.add(String(40, 172, "Units on hand at the end of each week", fontSize=8.5, fillColor=GREY))
    bc = VerticalBarChart()
    bc.x, bc.y, bc.width, bc.height = 310, 30, 220, 130
    bc.data = [entries]
    bc.categoryAxis.categoryNames = labels
    bc.categoryAxis.labels.fontSize = 6.5
    bc.categoryAxis.labels.angle = 35
    bc.categoryAxis.labels.boxAnchor = "ne"
    bc.valueAxis.valueMin = 0
    bc.valueAxis.labels.fontSize = 7
    bc.bars[0].fillColor = BLUE
    bc.bars[0].strokeColor = None
    d.add(bc)
    d.add(String(310, 172, "Entries logged each week", fontSize=8.5, fillColor=GREY))
    return d


def build(owner, email, holders_all, cat_all, ev_all, prior, now, path):
    holders = {h["id"]: h for h in holders_all if h["owner"] == owner}
    cat = {c["id"]: c for c in cat_all if c["owner"] == owner}
    events = [e for e in ev_all if e["owner"] == owner]
    hname = lambda h: holders.get(h, {}).get("name", "Unknown location")

    week_start = now - dt.timedelta(days=7)
    q_now = stock(events, holders)
    q_last = stock(events, holders, week_start)
    t_now, t_last = totals(q_now, cat, holders), totals(q_last, cat, holders)
    week_ev = [e for e in events if e["at"] > week_start]

    weeks = []
    for i in range(WEEKS - 1, -1, -1):
        end = now - dt.timedelta(days=7 * i)
        start = end - dt.timedelta(days=7)
        weeks.append({"label": end.astimezone(TZ).strftime("%b %d"),
                      "units": totals(stock(events, holders, end), cat, holders)["all"]["units"],
                      "entries": sum(1 for e in events if start < e["at"] <= end)})
    first = next((i for i, w in enumerate(weeks) if w["units"] or w["entries"]), len(weeks) - 1)
    weeks = weeks[first:]

    ss = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=ss["Title"], textColor=BLUE, fontSize=20)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], textColor=BLUE)
    body = ss["BodyText"]
    small = ParagraphStyle("s", parent=body, fontSize=8.5, leading=10.5)
    muted = ParagraphStyle("m", parent=body, textColor=GREY, fontSize=9)

    local = now.astimezone(TZ)
    story = [Paragraph("Field Twin Violet weekly inventory", h1),
             Paragraph(f"{email or 'Violet account'}. Week ending {local.strftime('%A, %B %d, %Y')}, built from the live Violet account.", body),
             Spacer(1, 6)]

    story.append(Paragraph("This week at a glance", h2))
    rows = [["Section", "Items", "Units on hand", "Change from last week"]]
    for name, _ in SECTIONS + [("All", None)]:
        k = "all" if name == "All" else name
        rows.append([name, num(t_now[k]["items"]), num(t_now[k]["units"]), delta(t_now[k]["units"] - t_last[k]["units"])])
    story.append(table(rows, [200, 70, 110, 150], 1))

    kinds = Counter(e["type"] for e in week_ev)
    days = len({e["at"].astimezone(TZ).date() for e in week_ev})
    story.append(Spacer(1, 6))
    if week_ev:
        parts = ", ".join(f"{VERB.get(k, k).lower()} {v}" for k, v in kinds.most_common())
        story.append(Paragraph(f"Entries logged this week: {len(week_ev)}, on {days} of the last seven days. By action: {parts}.", body))
    else:
        story.append(Paragraph("No entries were logged this week.", body))

    story.append(Paragraph("Trends", h2))
    if len(weeks) > 1:
        story.append(chart([w["label"] for w in weeks], [w["units"] for w in weeks], [w["entries"] for w in weeks]))
    rows = [["Week ending", "Units on hand", "Change", "Entries logged"]]
    prev = None
    for w in weeks:
        rows.append([w["label"], num(w["units"]), "" if prev is None else delta(w["units"] - prev), str(w["entries"])])
        prev = w["units"]
    story.append(table(rows, [140, 110, 120, 110], 1))

    story.append(Paragraph("This week's entries", h2))
    if week_ev:
        rows = [["When", "Action", "Item", "Qty", "From", "To"]]
        for e in sorted(week_ev, key=lambda e: e["at"], reverse=True)[:80]:
            c = cat.get(e["catalog_id"], {})
            rows.append([e["at"].astimezone(TZ).strftime("%a %b %d"), VERB.get(e["type"], e["type"]),
                         Paragraph(c.get("name", "Removed item") + (f" (serial {e['serial']})" if e["serial"] else ""), small),
                         num(float(e["qty"] or 0)), Paragraph(hname(e["from_holder"]) if e["from_holder"] else "", small),
                         Paragraph(hname(e["to_holder"]) if e["to_holder"] else (f"locker {e['locker_id']}" if e["locker_id"] else ""), small)])
        story.append(table(rows, [62, 72, 210, 34, 76, 76], 3))
        if len(week_ev) > 80:
            story.append(Paragraph("Showing the newest eighty entries.", muted))
    else:
        story.append(Paragraph("Nothing logged this week.", body))

    bad = [(cat[cid], h, v["bad"]) for (cid, h), v in q_now.items() if v["bad"] > 1e-9 and cid in cat]
    if bad:
        story.append(Paragraph("Not working", h2))
        rows = [["Item", "Location", "Count"]] + [[Paragraph(c["name"], small), hname(h), num(n)] for c, h, n in sorted(bad, key=lambda r: r[0]["name"].lower())]
        story.append(table(rows, [300, 140, 60], 2))

    have = Counter()
    for (cid, h), v in q_now.items():
        if holders.get(h, {}).get("kind") != "return":
            have[cid] += v["good"]
    low = [(c, have[c["id"]]) for c in cat.values() if float(c.get("min_qty") or 0) > 0 and have[c["id"]] < float(c["min_qty"])]
    if low:
        story.append(Paragraph("Running low", h2))
        rows = [["Item", "On hand", "Keep at least"]] + [[Paragraph(c["name"], small), num(n), num(float(c["min_qty"]))] for c, n in sorted(low, key=lambda r: r[0]["name"].lower())]
        story.append(table(rows, [320, 90, 90], 1))

    for name, f in SECTIONS:
        rows = [(cat[cid], hname(h), v["good"]) for (cid, h), v in q_now.items()
                if cid in cat and f(cat[cid]) and v["good"] > 1e-9 and holders.get(h, {}).get("kind") != "return"]
        story.append(Paragraph(name + (" for " + ", ".join(sorted({c["customer"] for c, _, _ in rows if c["customer"]})) if name == "Company parts" and rows else ""), h2))
        if not rows:
            story.append(Paragraph("Nothing on hand.", body))
            continue
        rows.sort(key=lambda r: (r[0]["name"].lower(), r[1]))
        data = [["Item", "Part number", "Old number", "Location", "On hand"]]
        for c, h, n in rows:
            data.append([Paragraph(c["name"], small), c["part_number"] or "", c["model"] if c["kind"] == "part" else "", h, num(n)])
        story.append(table(data, [230, 80, 72, 72, 46], 4))

    SimpleDocTemplate(path, pagesize=letter, leftMargin=36, rightMargin=36, topMargin=40, bottomMargin=40,
                      title="Field Twin Violet weekly inventory").build(story)
    summary = {k: {"items": v["items"], "units": v["units"]} for k, v in t_now.items()}
    summary["entries_week"] = len(week_ev)
    summary["active_days"] = days
    summary["by_action"] = dict(kinds)
    return summary


def main():
    now = dt.datetime.now(dt.timezone.utc)
    only = os.environ.get("ONLY_OWNER", "").strip()
    out_dir = os.environ.get("OUT_DIR", "").strip()
    holders = sql("select id, owner, name, kind from violet_holders")
    cat = sql("select id, owner, kind, name, part_number, model, company, customer, min_qty from violet_catalog")
    ev = sql("""select id, owner, type, catalog_id, serial, qty, condition, from_holder, to_holder, locker_id,
                coalesce(extracted->>'from_condition', '') as from_condition, happened_at, created_at
                from violet_events order by happened_at, created_at""")
    users = {u["id"]: u["email"] for u in sql("select id::text, email from auth.users")}
    for e in ev:
        e["at"] = dt.datetime.fromisoformat((e["happened_at"] or e["created_at"]).replace("Z", "+00:00"))
        if e["at"].tzinfo is None:
            e["at"] = e["at"].replace(tzinfo=dt.timezone.utc)
    ev.sort(key=lambda e: (e["at"], e["created_at"] or ""))
    keys = api("GET", f"https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true")
    service = next(k["api_key"] for k in keys if k.get("name") == "service_role")
    owners = sorted({x["owner"] for x in holders + cat + ev})
    week_of = now.astimezone(TZ).date().isoformat()
    for owner in owners:
        if only and owner != only:
            continue
        fname = f"field-twin-violet-report-v1-{week_of}.pdf"
        local = os.path.join(out_dir or "/tmp", fname if not out_dir else f"{owner[:8]}-{fname}")
        summary = build(owner, users.get(owner, ""), holders, cat, ev, None, now, local)
        obj = f"{owner}/reports/{fname}"
        with open(local, "rb") as f:
            pdf = f.read()
        req = urllib.request.Request(f"https://{REF}.supabase.co/storage/v1/object/{BUCKET}/{obj}", data=pdf, method="POST",
                                     headers={"Authorization": "Bearer " + service, "apikey": service, "Content-Type": "application/pdf", "x-upsert": "true"})
        urllib.request.urlopen(req, timeout=60).read()
        sql(f"""insert into violet_reports (owner, week_of, path, summary) values ({lit(owner)}, {lit(week_of)}, {lit(obj)}, {lit(json.dumps(summary))}::jsonb)
                on conflict (owner, week_of) do update set path = excluded.path, summary = excluded.summary, created_at = now()""")
        print(f"report saved for {owner[:8]}: {summary['all']['units']} units, {summary['entries_week']} entries this week")


if __name__ == "__main__":
    sys.exit(main())
