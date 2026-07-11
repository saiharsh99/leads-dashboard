"""Compute dashboard metrics from normalized lead rows."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

SOURCE_ALIASES = {
    "ig": "Instagram", "instagram": "Instagram", "instagram_feed": "Instagram",
    "instagram_stories": "Instagram", "fb": "Facebook", "facebook": "Facebook",
    "facebook_mobile_feed": "Facebook", "facebook_mobile_reels": "Facebook",
    "google": "Google", "whatsapp": "WhatsApp", "website": "Website",
}

INVALID_REASON = "invalid enquiry"


def _source_name(raw: Optional[str]) -> str:
    if not raw:
        return "Unattributed"
    key = raw.strip().lower()
    return SOURCE_ALIASES.get(key, raw.strip())


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _rate(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def _group(leads: List[Dict[str, Any]], key_fn) -> Dict[str, List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for lead in leads:
        groups[key_fn(lead)].append(lead)
    return groups


def _outcome_stats(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    ql = sum(1 for r in rows if r["ql"] == "QL")
    lost = sum(1 for r in rows if r["ql"] == "Lost")
    return {
        "total": len(rows),
        "ql": ql,
        "lost": lost,
        "open": len(rows) - ql - lost,
        "ql_rate": _rate(ql, len(rows)),
        "invalid": sum(1 for r in rows
                       if (r.get("lost_reason") or "").strip().lower() == INVALID_REASON),
        "visits": sum(1 for r in rows if (r.get("site_visits") or 0) > 0),
    }


def compute_dashboard(leads: List[Dict[str, Any]], min_campaign_leads: int = 10) -> Dict[str, Any]:
    stats = _outcome_stats(leads)
    dates = [d for d in (_parse_dt(r["created_on"]) for r in leads) if d]

    # Weekly trend (weeks start Monday)
    weekly: List[Dict[str, Any]] = []
    if dates:
        by_week: Dict[str, Dict[str, int]] = defaultdict(lambda: {"total": 0, "ql": 0})
        for lead in leads:
            dt = _parse_dt(lead["created_on"])
            if not dt:
                continue
            week = (dt - timedelta(days=dt.weekday())).date().isoformat()
            by_week[week]["total"] += 1
            if lead["ql"] == "QL":
                by_week[week]["ql"] += 1
        weekly = [{"week": w, **v} for w, v in sorted(by_week.items())]

    sources = sorted(
        ({"name": name, **_outcome_stats(rows)}
         for name, rows in _group(leads, lambda r: _source_name(r.get("utm_source"))).items()),
        key=lambda s: -s["total"],
    )

    projects = sorted(
        ({"name": name, **_outcome_stats(rows)}
         for name, rows in _group(leads, lambda r: r.get("project") or "Unknown").items()),
        key=lambda s: -s["total"],
    )

    managers = []
    for name, rows in _group(leads, lambda r: r.get("manager") or "Unassigned").items():
        attempts = [r["attempts"] for r in rows if r.get("attempts") is not None]
        managers.append({
            "name": name, **_outcome_stats(rows),
            "avg_attempts": round(sum(attempts) / len(attempts), 1) if attempts else None,
        })
    managers.sort(key=lambda s: -s["total"])

    campaigns = sorted(
        ({"name": name, **st, "invalid_rate": _rate(st["invalid"], st["total"])}
         for name, rows in _group(leads, lambda r: r.get("utm_campaign") or "No campaign").items()
         if (st := _outcome_stats(rows))["total"] >= min_campaign_leads),
        key=lambda s: -s["total"],
    )

    lost_counter = Counter(
        (r.get("lost_reason") or "Not recorded") for r in leads if r["ql"] == "Lost"
    )
    top = lost_counter.most_common(9)
    other = sum(lost_counter.values()) - sum(c for _, c in top)
    lost_reasons = [{"reason": reason, "count": count} for reason, count in top]
    if other > 0:
        lost_reasons.append({"reason": "Other reasons", "count": other})

    return {
        "kpis": {
            **stats,
            "lost_rate": _rate(stats["lost"], stats["total"]),
            "open_rate": _rate(stats["open"], stats["total"]),
            "date_from": min(dates).date().isoformat() if dates else None,
            "date_to": max(dates).date().isoformat() if dates else None,
        },
        "weekly": weekly,
        "sources": sources,
        "projects": projects,
        "managers": managers,
        "campaigns": campaigns,
        "lost_reasons": lost_reasons,
    }
