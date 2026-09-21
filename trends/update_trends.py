import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
RECENT = ROOT / "recent.json"
MADRID = ZoneInfo("Europe/Madrid")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

SOURCES = {
    "trends24": "https://trends24.in/spain/",
    "getdaytrends": "https://getdaytrends.com/es/spain/",
    "tweets24": "https://tweets24.com/trending-on-twitter-in-spain",
    "superx": "https://superx.so/twitter-trends/spain",
    "twtdata": "https://twtdata.com/twitter-trends/spain/",
    "snaplytics": "https://twitter-trends.snaplytics.io/spain/",
    "fowtools": "https://fowtools.com/x-trends/spain",
    "cyberkendra": "https://trends.cyberkendra.com/spain/",
    "globaltwittertrends": "https://globaltwittertrends.com/spain/",
    "trendswe": "https://trendswe.com/twitter/spain/",
    "twitter_trending": "https://www.twitter-trending.com/spain/es",
}

PARSERS = {}

def clean(text):
    return re.sub(r"\s+", " ", (text or "")).strip()

def canonical(text):
    text = clean(text)
    text = re.sub(r"\s+(?:N/?A|Less than 10k tweets|\d+(?:[.,]\d+)?[KMB]?\s*(?:tweets|posts)?)$", "", text, flags=re.I)
    return text.strip(" -·|\t")

def unique(values):
    out, seen = [], set()
    for value in values:
        value = canonical(value)
        key = value.casefold()
        if not value or key in seen or len(value) > 120:
            continue
        if value.lower() in {"trend", "trending", "keyword", "hashtag", "topic", "spain", "españa"}:
            continue
        seen.add(key)
        out.append(value)
    return out

def get(url):
    r = requests.get(
        url,
        headers=HEADERS,
        timeout=30,
        params={"_": int(datetime.now().timestamp())},
    )
    r.raise_for_status()
    return r.content.decode("utf-8", errors="replace")

def parse_trends24(html):
    soup = BeautifulSoup(html, "html.parser")
    for selector in (".trend-card__list li a", ".trend-card li a", ".trend-card ol li a"):
        vals = unique(a.get_text(" ", strip=True) for a in soup.select(selector))
        if len(vals) >= 10:
            return vals[:50]
    card = soup.select_one(".trend-card")
    if card:
        vals = unique(a.get_text(" ", strip=True) for a in card.find_all("a"))
        if len(vals) >= 10:
            return vals[:50]
    return []

def parse_ranked_tables(soup):
    best = []
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = tr.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            first = clean(cells[0].get_text(" ", strip=True)).lstrip("#").rstrip(".)")
            m = re.match(r"^(\d{1,2})$", first)
            if not m or not (1 <= int(m.group(1)) <= 50):
                continue
            name = canonical(cells[1].get_text(" ", strip=True))
            if name:
                rows.append(name)
        rows = unique(rows)
        if len(rows) > len(best):
            best = rows
    return best[:50]

def parse_getdaytrends(html):
    return parse_ranked_tables(BeautifulSoup(html, "html.parser"))

def parse_tweets24(html):
    soup = BeautifulSoup(html, "html.parser")
    text = clean(soup.get_text(" ", strip=True))
    marker = "Live Twitter Trending Topics in Spain"
    if marker in text:
        text = text.split(marker, 1)[1]
    parts = re.split(r"\s+(?=\d{1,2}\s+)", text)
    vals = []
    for part in parts:
        m = re.match(r"(\d{1,2})\s+(.+?)(?:\s+Explore why|\s+##|$)", part)
        if m and 1 <= int(m.group(1)) <= 50:
            vals.append(clean(m.group(2)))
    return unique(vals)[:50]

def parse_numbered_blocks(soup):
    vals = []
    for node in soup.find_all(["li", "p", "div", "span", "a", "h2", "h3"]):
        text = clean(node.get_text(" ", strip=True))
        m = re.match(r"^#?(\d{1,2})[.)\s:-]+(.+)$", text)
        if not m or not (1 <= int(m.group(1)) <= 50):
            continue
        name = canonical(m.group(2))
        name = re.split(r"\s+(?:Politics|Football|Sports|Music|Fashion|Video games)\b", name, maxsplit=1, flags=re.I)[0]
        if name:
            vals.append(name)
    return unique(vals)[:50]

def parse_generic(html):
    soup = BeautifulSoup(html, "html.parser")
    vals = parse_ranked_tables(soup)
    if len(vals) >= 10:
        return vals
    vals = parse_numbered_blocks(soup)
    if len(vals) >= 10:
        return vals
    best = []
    for ol in soup.find_all("ol"):
        vals = unique(li.get_text(" ", strip=True) for li in ol.find_all("li", recursive=False))
        if len(vals) > len(best):
            best = vals
    return best[:50] if len(best) >= 10 else []

PARSERS.update({
    "trends24": parse_trends24,
    "getdaytrends": parse_getdaytrends,
    "tweets24": parse_tweets24,
})

def parse_declared_time(value, fetched_at):
    if not value:
        return None
    v = clean(value)
    m = re.search(r"(\d+)\s+(minute|minutes|hour|hours)\s+ago", v, flags=re.I)
    if m:
        n = int(m.group(1))
        delta = timedelta(minutes=n) if m.group(2).lower().startswith("minute") else timedelta(hours=n)
        return fetched_at - delta
    normalized = re.sub(r"\bat\b", "", v, flags=re.I)
    normalized = clean(normalized)
    tz = timezone.utc if "UTC" in normalized.upper() else MADRID
    normalized = re.sub(r"\s+UTC\b", "", normalized, flags=re.I)
    for fmt in (
        "%B %d, %Y %I:%M %p",
        "%B %d, %Y %H:%M",
        "%b %d, %Y %H:%M",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(normalized, fmt).replace(tzinfo=tz)
            return dt.astimezone(MADRID)
        except ValueError:
            pass
    return None

def extract_update_hint(html, fetched_at):
    soup = BeautifulSoup(html, "html.parser")
    text = clean(soup.get_text(" ", strip=True))
    candidates = []
    patterns = [
        r"(?:Last\s+)?Updated\s*:?\s*([^|]{0,90}?)(?=\s{2,}|\b(?:Rank|Trending|Current|Top)\b|$)",
        r"Trending now\s*[—-]\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+UTC)",
        r"Today\s*[·-]\s*(\d{4}-\d{2}-\d{2})",
        r"updated\s+(\d+\s+(?:minute|minutes|hour|hours)\s+ago)",
    ]
    for pat in patterns:
        m = re.search(pat, text, flags=re.I)
        if m:
            candidates.append(clean(m.group(1)))
    hint = candidates[0] if candidates else None
    declared = parse_declared_time(hint, fetched_at) if hint else None
    age = None
    if declared:
        age = max(0, round((fetched_at - declared).total_seconds() / 60, 1))
    return hint, declared, age

def fingerprint(trends):
    body = "\n".join(x.casefold() for x in trends[:20])
    return hashlib.sha1(body.encode("utf-8")).hexdigest()[:12] if body else None

def fetch_source(name):
    fetched_at = datetime.now(MADRID)
    try:
        html = get(SOURCES[name])
        parser = PARSERS.get(name, parse_generic)
        trends = parser(html)
        hint, declared, age = extract_update_hint(html, fetched_at)
        ok = len(trends) >= 10
        if age is None:
            freshness = "unknown"
        elif age <= 90:
            freshness = "fresh"
        elif age <= 180:
            freshness = "aging"
        else:
            freshness = "stale"
        return {
            "ok": ok,
            "trends": trends,
            "error": None if ok else f"Solo {len(trends)} tendencias parseadas",
            "fetched_at": fetched_at.isoformat(timespec="seconds"),
            "update_hint": hint,
            "declared_at": declared.isoformat(timespec="seconds") if declared else None,
            "age_minutes": age,
            "freshness": freshness,
            "fingerprint": fingerprint(trends),
        }
    except Exception as e:
        return {
            "ok": False,
            "trends": [],
            "error": f"{type(e).__name__}: {e}",
            "fetched_at": fetched_at.isoformat(timespec="seconds"),
            "update_hint": None,
            "declared_at": None,
            "age_minutes": None,
            "freshness": "error",
            "fingerprint": None,
        }

def previous_top10():
    try:
        return json.loads(RECENT.read_text(encoding="utf-8")).get("top10", [])
    except Exception:
        return []

def overlap_score(a, b):
    aa = [x.casefold() for x in a[:20]]
    bb = [x.casefold() for x in b[:20]]
    sa, sb = set(aa), set(bb)
    if not sa or not sb:
        return 0.0
    jaccard = len(sa & sb) / len(sa | sb)
    rank_bonus = 0.0
    for item in sa & sb:
        rank_bonus += max(0, 10 - abs(aa.index(item) - bb.index(item))) / 10
    rank_bonus /= max(1, len(sa | sb))
    return jaccard + 0.35 * rank_bonus

def choose_consensus(source_data):
    usable = {
        name: data
        for name, data in source_data.items()
        if data["ok"] and data["freshness"] != "stale"
    }
    if not usable:
        usable = {name: data for name, data in source_data.items() if data["ok"]}
    if not usable:
        raise RuntimeError("No se pudo obtener un Top 10 válido de ninguna fuente")

    scores = {}
    for name, data in usable.items():
        score = 0.0
        for other_name, other in usable.items():
            if other_name == name:
                continue
            score += overlap_score(data["trends"], other["trends"])
        if data["freshness"] == "fresh":
            score += 0.5
        elif data["freshness"] == "aging":
            score += 0.15
        scores[name] = round(score, 4)
    chosen_name = max(scores, key=scores.get)
    return chosen_name, usable[chosen_name]["trends"][:10], scores

def duplicate_groups(source_data):
    groups = {}
    for name, data in source_data.items():
        fp = data.get("fingerprint")
        if data.get("ok") and fp:
            groups.setdefault(fp, []).append(name)
    return [names for names in groups.values() if len(names) > 1]

def main():
    now = datetime.now(MADRID)
    previous = previous_top10()
    source_data = {name: fetch_source(name) for name in SOURCES}

    chosen_name, top10, consensus_scores = choose_consensus(source_data)
    unchanged = [x.casefold() for x in top10] == [x.casefold() for x in previous]

    valid = [name for name, d in source_data.items() if d["ok"]]
    non_stale = [name for name, d in source_data.items() if d["ok"] and d["freshness"] != "stale"]
    fresh = [name for name, d in source_data.items() if d["ok"] and d["freshness"] == "fresh"]
    stale = [name for name, d in source_data.items() if d["ok"] and d["freshness"] == "stale"]
    duplicates = duplicate_groups(source_data)

    if len(non_stale) >= 6:
        reliability = "high"
    elif len(non_stale) >= 3:
        reliability = "medium"
    else:
        reliability = "low"

    payload = {
        "project": "TTendencias",
        "country": "ES",
        "captured_at": now.isoformat(timespec="seconds"),
        "primary_source": chosen_name,
        "selection_method": "freshness-aware multi-source consensus",
        "reliability": reliability,
        "source_summary": {
            "configured": len(SOURCES),
            "valid": len(valid),
            "non_stale": len(non_stale),
            "fresh": len(fresh),
            "stale": stale,
            "duplicate_groups": duplicates,
        },
        "consensus_scores": consensus_scores,
        "top10": top10,
        "items": [{"rank": i + 1, "name": name} for i, name in enumerate(top10)],
        "unchanged_from_previous": unchanged,
        "sources": source_data,
    }
    RECENT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"TTendencias: {chosen_name}; reliability={reliability}; "
        f"valid={len(valid)}/{len(SOURCES)}; non_stale={len(non_stale)}; "
        f"Top 10: {', '.join(top10)}"
    )

if __name__ == "__main__":
    main()
