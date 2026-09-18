#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

SOURCE_URL = "https://www.europapress.es/noticias/"
OUTPUT = Path("feed.xml")
LATEST_JSON = Path("latest.json")
ARCHIVE_DIR = Path("archive")
STATE_FILE = Path("state.json")
TZ = ZoneInfo("Europe/Madrid")
RSS_MAX_ITEMS = 2000
LATEST_JSON_MAX_ITEMS = 5000
MAX_PAGES = 100
REQUEST_DELAY_SECONDS = 0.35
USER_AGENT = "Mozilla/5.0 (compatible; EuropaPressRSS/2.0; +https://github.com/)"


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def page_url(page_number: int) -> str:
    if page_number <= 1:
        return SOURCE_URL
    return urljoin(SOURCE_URL, f"p{page_number}/")


def fetch_page(session: requests.Session, page_number: int) -> str:
    # Unique cache-buster per page + explicit cache headers. This matters because
    # /noticias/ changes every few minutes and intermediary caches can lag.
    url = page_url(page_number)
    r = session.get(
        url,
        params={"_rss_ts": f"{int(time.time())}-{page_number}"},
        headers={
            "User-Agent": USER_AGENT,
            "Cache-Control": "no-cache, no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "Accept": "text/html,application/xhtml+xml",
        },
        timeout=30,
    )
    if r.status_code == 404:
        return ""
    r.raise_for_status()
    return r.text


def parse_page(page: str) -> list[dict]:
    """Parse one /noticias/ page without assigning a calendar date yet."""
    if not page:
        return []
    soup = BeautifulSoup(page, "html.parser")
    found: list[dict] = []

    for h2 in soup.find_all("h2"):
        a = h2.find("a", href=True)
        if not a:
            continue
        title = clean(a.get_text(" ", strip=True))
        href = urljoin(SOURCE_URL, a["href"])
        if not title or "europapress.es" not in href:
            continue

        timestamp = None
        section = None

        # The timestamp sits close to the headline in the current markup.
        for node in (h2.parent, getattr(h2.parent, "parent", None)):
            if not node:
                continue
            text = clean(node.get_text(" ", strip=True))
            mt = re.search(r"\b([01]?\d|2[0-3]):[0-5]\d\b", text)
            if mt:
                timestamp = mt.group(0)
                break
        if not timestamp:
            sib = h2.find_next(string=re.compile(r"^\s*([01]?\d|2[0-3]):[0-5]\d\s*$"))
            if sib:
                timestamp = clean(str(sib))
        if not timestamp:
            continue

        # Section is normally the short text immediately preceding the H2.
        prev = h2.find_previous(string=True)
        hops = 0
        while prev and hops < 10:
            t = clean(str(prev))
            if (
                t
                and t != title
                and not re.fullmatch(r"([01]?\d|2[0-3]):[0-5]\d", t)
                and len(t) <= 100
                and "Últimas noticias" not in t
                and "Filtrar" not in t
                and t not in {"Anterior", "Siguiente"}
            ):
                section = t
                break
            prev = prev.find_previous(string=True) if hasattr(prev, "find_previous") else None
            hops += 1

        guid = hashlib.sha256(href.encode("utf-8")).hexdigest()
        found.append(
            {
                "title": title,
                "link": href,
                "section": section or "Europa Press",
                "time": timestamp,
                "guid": guid,
            }
        )

    unique: list[dict] = []
    seen: set[str] = set()
    for item in found:
        if item["link"] in seen:
            continue
        seen.add(item["link"])
        unique.append(item)
    return unique


def fetch_all_current_pages() -> tuple[list[dict], int]:
    """Walk p1, p2, ... until Europa Press stops returning new headlines."""
    session = requests.Session()
    all_items: list[dict] = []
    seen_links: set[str] = set()
    pages_read = 0

    for page_number in range(1, MAX_PAGES + 1):
        html = fetch_page(session, page_number)
        parsed = parse_page(html)
        if not parsed:
            break

        new_items = [x for x in parsed if x["link"] not in seen_links]
        if not new_items:
            break

        all_items.extend(new_items)
        seen_links.update(x["link"] for x in new_items)
        pages_read += 1
        print(f"Página {page_number}: {len(new_items)} noticias nuevas en el recorrido")
        time.sleep(REQUEST_DELAY_SECONDS)
    else:
        print(
            f"ADVERTENCIA: se alcanzó MAX_PAGES={MAX_PAGES}; comprueba si Europa Press ha cambiado la paginación.",
            file=sys.stderr,
        )

    return all_items, pages_read


def assign_datetimes(items: list[dict], now: datetime) -> list[dict]:
    """Assign dates to reverse-chronological HH:MM items, handling midnight rollovers."""
    if not items:
        return []

    dated: list[dict] = []
    current_date = now.date()
    previous_dt: datetime | None = None

    for raw in items:
        h, m = map(int, raw["time"].split(":"))
        candidate = datetime.combine(current_date, datetime.min.time(), tzinfo=TZ).replace(hour=h, minute=m)

        # If the newest visible item is "in the future" by a meaningful amount,
        # it belongs to yesterday (e.g. run just after midnight and item is 23:59).
        if previous_dt is None and candidate > now + timedelta(hours=2):
            candidate -= timedelta(days=1)
            current_date = candidate.date()

        # Page order is newest -> oldest. A jump from 00:xx to 23:xx means the
        # list crossed midnight, so move subsequent entries back one day.
        if previous_dt is not None and candidate > previous_dt + timedelta(hours=2):
            candidate -= timedelta(days=1)
            current_date = candidate.date()

        # Defensive monotonicity: if markup/order changes slightly, keep chronology sane.
        while previous_dt is not None and candidate > previous_dt + timedelta(minutes=5):
            candidate -= timedelta(days=1)
            current_date = candidate.date()

        item = dict(raw)
        item.pop("time", None)
        item["published"] = candidate
        dated.append(item)
        previous_dt = candidate

    return dated


def serialize_item(item: dict) -> dict:
    return {
        "guid": item["guid"],
        "published": item["published"].isoformat(),
        "section": item["section"],
        "title": item["title"],
        "link": item["link"],
    }


def deserialize_item(item: dict) -> dict:
    return {
        "guid": item["guid"],
        "published": datetime.fromisoformat(item["published"]).astimezone(TZ),
        "section": item.get("section") or "Europa Press",
        "title": item.get("title") or "",
        "link": item["link"],
    }


def load_all_archive() -> list[dict]:
    if not ARCHIVE_DIR.exists():
        return []
    out: list[dict] = []
    for path in sorted(ARCHIVE_DIR.glob("*.json"), reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            out.extend(deserialize_item(x) for x in data)
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            print(f"ADVERTENCIA: no se pudo leer {path}: {exc}", file=sys.stderr)
    return out


def save_daily_archive(items: list[dict]) -> None:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    by_day: dict[str, list[dict]] = {}
    for item in items:
        day = item["published"].astimezone(TZ).date().isoformat()
        by_day.setdefault(day, []).append(item)

    for day, day_items in by_day.items():
        path = ARCHIVE_DIR / f"{day}.json"
        existing: list[dict] = []
        if path.exists():
            try:
                existing = [deserialize_item(x) for x in json.loads(path.read_text(encoding="utf-8"))]
            except Exception as exc:
                print(f"ADVERTENCIA: se reconstruirá {path}: {exc}", file=sys.stderr)

        merged = {x["link"]: x for x in existing}
        for x in day_items:
            merged[x["link"]] = x
        ordered = sorted(merged.values(), key=lambda x: x["published"], reverse=True)
        path.write_text(
            json.dumps([serialize_item(x) for x in ordered], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


def build_feed(items: list[dict]) -> None:
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Europa Press - Últimas noticias (RSS no oficial)"
    ET.SubElement(channel, "link").text = SOURCE_URL
    ET.SubElement(channel, "description").text = (
        "RSS no oficial generado automáticamente a partir de todas las páginas disponibles de Últimas noticias de Europa Press."
    )
    ET.SubElement(channel, "language").text = "es-es"
    ET.SubElement(channel, "lastBuildDate").text = format_datetime(datetime.now(TZ))
    ET.SubElement(channel, "ttl").text = "5"

    for x in items[:RSS_MAX_ITEMS]:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = x["title"]
        ET.SubElement(item, "link").text = x["link"]
        ET.SubElement(item, "guid", {"isPermaLink": "false"}).text = x["guid"]
        ET.SubElement(item, "category").text = x["section"]
        ET.SubElement(item, "pubDate").text = format_datetime(x["published"])
        ET.SubElement(item, "description").text = f"{x['section']} — {x['title']}"

    ET.indent(rss, space="  ")
    OUTPUT.write_bytes(ET.tostring(rss, encoding="utf-8", xml_declaration=True))


def save_latest_json(items: list[dict]) -> None:
    payload = {
        "source": SOURCE_URL,
        "generated_at": datetime.now(TZ).isoformat(),
        "count": min(len(items), LATEST_JSON_MAX_ITEMS),
        "items": [serialize_item(x) for x in items[:LATEST_JSON_MAX_ITEMS]],
    }
    LATEST_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def save_state(current_items: list[dict], pages_read: int, total_archive_items: int) -> None:
    newest = current_items[0] if current_items else None
    oldest = current_items[-1] if current_items else None
    state = {
        "generated_at": datetime.now(TZ).isoformat(),
        "pages_read": pages_read,
        "items_seen_in_current_crawl": len(current_items),
        "archive_items_total": total_archive_items,
        "newest": serialize_item(newest) if newest else None,
        "oldest_in_current_crawl": serialize_item(oldest) if oldest else None,
    }
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    raw_items, pages_read = fetch_all_current_pages()
    if not raw_items:
        print("ERROR: no se han podido extraer noticias; no se sobrescriben los datos.", file=sys.stderr)
        return 2

    current = assign_datetimes(raw_items, datetime.now(TZ))
    save_daily_archive(current)

    # Reload archive after merging current crawl, so feed/latest represent the full retained history.
    archive = load_all_archive()
    merged = {x["link"]: x for x in archive}
    all_items = sorted(merged.values(), key=lambda x: x["published"], reverse=True)

    build_feed(all_items)
    save_latest_json(all_items)
    save_state(current, pages_read, len(all_items))

    print(f"OK: {pages_read} páginas recorridas; {len(current)} noticias vistas en esta ejecución.")
    print(f"Archivo histórico: {len(all_items)} noticias conservadas sin límite temporal.")
    print(f"RSS: {min(len(all_items), RSS_MAX_ITEMS)} noticias recientes.")
    print(f"JSON reciente: {min(len(all_items), LATEST_JSON_MAX_ITEMS)} noticias recientes.")
    print(f"Más reciente: {current[0]['published'].strftime('%Y-%m-%d %H:%M')} — {current[0]['title']}")
    print(f"Más antigua del recorrido: {current[-1]['published'].strftime('%Y-%m-%d %H:%M')} — {current[-1]['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
