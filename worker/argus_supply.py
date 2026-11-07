"""Argus Supply worker: FDA import, inventory forecasts, and bounded proposals.

This process uses only the Python standard library. It has a SpacetimeDB service
identity, granted by a network admin. The service may import public data and
write forecasts/proposals; human managers alone reserve and move inventory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import random
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOG = logging.getLogger("argus.supply")
FDA_URL = "https://api.fda.gov/drug/shortages.json"
ROOT = Path(__file__).resolve().parents[1]
TOKEN_FILE = ROOT / ".argus-supply" / "service.json"
DEFAULT_HOST = os.environ.get("ARGUS_SUPPLY_DB_HOST", "http://127.0.0.1:3000")
DEFAULT_DB = os.environ.get("ARGUS_SUPPLY_DB_NAME", "argus-supply")
SYSTEM_CA = Path("/etc/ssl/cert.pem")
CA_FILE = os.environ.get("SSL_CERT_FILE") or (str(SYSTEM_CA) if SYSTEM_CA.is_file() else None)
FDA_SSL_CONTEXT = ssl.create_default_context(cafile=CA_FILE)


def _decode(value: Any) -> Any:
    if isinstance(value, dict) and len(value) == 1:
        key, val = next(iter(value.items()))
        if key.startswith("__") and key.endswith("__"):
            return val
    return value


def _rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    cols = []
    for i, element in enumerate(result.get("schema", {}).get("elements", [])):
        name = element.get("name", f"col{i}")
        if isinstance(name, dict):
            name = name.get("some", f"col{i}")
        cols.append(name)
    return [{name: _decode(value) for name, value in zip(cols, values)} for values in result.get("rows", [])]


class DatabaseError(RuntimeError):
    pass


class Spacetime:
    def __init__(self, host: str = DEFAULT_HOST, db: str = DEFAULT_DB, token_file: Path = TOKEN_FILE):
        self.host = host.rstrip("/")
        self.db = db
        self.token_file = token_file
        self.identity = ""
        self.token = ""

    def _post(self, path: str, body: bytes, content_type: str) -> Any:
        headers = {"Content-Type": content_type, "User-Agent": "argus-supply/1.0"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.host + path, body, headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise DatabaseError(f"HTTP {exc.code} {path}: {detail}") from None
        except urllib.error.URLError as exc:
            raise DatabaseError(f"Cannot reach SpacetimeDB at {self.host}: {exc.reason}") from None
        return json.loads(raw) if raw else None

    def login(self) -> str:
        if self.token_file.exists():
            saved = json.loads(self.token_file.read_text())
            self.token = saved["token"]
            self.identity = saved["identity"]
            return self.identity
        result = self._post("/v1/identity", b"", "application/json")
        if not isinstance(result, dict) or not result.get("identity") or not result.get("token"):
            raise DatabaseError("SpacetimeDB did not return an identity and token")
        self.identity = str(result["identity"])
        self.token = str(result["token"])
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump({"identity": self.identity, "token": self.token}, output)
        return self.identity

    def query(self, sql: str) -> list[list[dict[str, Any]]]:
        result = self._post(f"/v1/database/{self.db}/sql", sql.encode(), "text/plain")
        return [_rows(part) for part in result or []]

    def table(self, name: str) -> list[dict[str, Any]]:
        return self.query(f"SELECT * FROM {name}")[0]

    def call(self, reducer: str, *args: Any) -> None:
        self._post(f"/v1/database/{self.db}/call/{reducer}", json.dumps(list(args)).encode(), "application/json")

    def authorized(self) -> bool:
        return any(row.get("identity", "").lower() == self.identity.lower() and row.get("role") == "service"
                   for row in self.table("member"))


def fda_get(skip: int, limit: int = 1000) -> dict[str, Any]:
    url = FDA_URL + "?" + urllib.parse.urlencode({"limit": limit, "skip": skip})
    req = urllib.request.Request(url, headers={"User-Agent": "argus-supply/1.0 (operations research)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30, context=FDA_SSL_CONTEXT) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == 3:
                raise RuntimeError(f"FDA feed fetch failed at offset {skip}: {exc}") from exc
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def normalize_fda(record: dict[str, Any]) -> dict[str, str]:
    """Keep the actual source text; create a stable key for replayed imports."""
    source = "|".join(str(record.get(k, "")).strip().lower() for k in
                      ("package_ndc", "generic_name", "company_name", "presentation"))
    key = hashlib.sha256(source.encode()).hexdigest()[:24]
    openfda = record.get("openfda") or {}
    rxcui = openfda.get("rxcui") or []
    return {
        "key": key,
        "packageNdc": str(record.get("package_ndc", "")),
        "genericName": str(record.get("generic_name", "Unknown product")),
        "companyName": str(record.get("company_name", "")),
        "presentation": str(record.get("presentation", "")),
        "dosageForm": str(record.get("dosage_form", "")),
        "status": str(record.get("status", "Unknown")),
        "details": str(record.get("related_info", ""))[:1600],
        "updateDate": str(record.get("update_date", "")),
        "rxcui": str(rxcui[0]) if rxcui else "",
    }


def fetch_fda() -> tuple[str, list[dict[str, str]]]:
    first = fda_get(0)
    total = int(first.get("meta", {}).get("results", {}).get("total", 0))
    feed_date = str(first.get("meta", {}).get("last_updated", ""))
    if not feed_date or total < 1:
        raise RuntimeError("FDA response lacks a valid update date or record count")
    records = list(first.get("results", []))
    while len(records) < total:
        page = fda_get(len(records))
        batch = page.get("results", [])
        if not batch:
            raise RuntimeError("FDA pagination ended before the declared record count")
        records.extend(batch)
    if len(records) != total:
        raise RuntimeError("FDA pagination count changed during download; retry later")
    normalized = {row["key"]: row for row in (normalize_fda(record) for record in records)}
    return feed_date, list(normalized.values())


def sync_fda(db: Spacetime) -> int:
    feed_date, rows = fetch_fda()  # Never start a DB run before the full source is available.
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + str(os.getpid())
    db.call("begin_fda_sync", run_id)
    for offset in range(0, len(rows), 100):
        db.call("import_fda_batch", run_id, json.dumps(rows[offset:offset + 100], separators=(",", ":")))
    db.call("finish_fda_sync", run_id, feed_date)
    LOG.info("Imported %d FDA records; source updated %s", len(rows), feed_date)
    return len(rows)


def days_distribution(free: float, baseline: float, used: float, observed_days: float,
                      seed: str, draws: int = 1200) -> tuple[float, float, float, float]:
    """Gamma-Poisson demand posterior; return rate and p10/p50/p90 days of supply."""
    if free <= 0:
        return (max(0.0, baseline), 0.0, 0.0, 0.0)
    if baseline <= 0 and used <= 0:
        return (0.0, 0.0, 0.0, 0.0)  # Unknown, not an invented zero-demand forecast.
    prior_days = 7.0
    shape = max(0.5, baseline * prior_days) + used
    rate = prior_days + observed_days
    mean = shape / rate
    rng = random.Random(int(hashlib.sha256(seed.encode()).hexdigest()[:16], 16))
    samples = sorted(free / max(rng.gammavariate(shape, 1.0 / rate), 1e-6) for _ in range(draws))
    def pct(q: float) -> float:
        return round(samples[min(draws - 1, round((draws - 1) * q))], 1)
    return round(mean, 3), pct(.10), pct(.50), pct(.90)


def _event_time(value: Any) -> float:
    try:
        return float(value) / 1_000_000.0
    except (TypeError, ValueError):
        return 0.0


def compute_forecasts(db: Spacetime) -> list[dict[str, Any]]:
    inventory = db.table("inventory")
    events = db.table("stock_event")
    current = db.table("forecast")
    current_by_key = {row["key"]: row for row in current}
    now = time.time()
    out: list[dict[str, Any]] = []
    for item in inventory:
        previous = current_by_key.get(item["key"])
        if previous and int(previous["inventory_revision"]) == int(item["revision"]):
            out.append({**item, "risk": previous["risk"], "days_p10": previous["days_p10"],
                        "days_median": previous["days_median"], "days_p90": previous["days_p90"]})
            continue
        history = [event for event in events if event["inventory_key"] == item["key"]
                   and _event_time(event["at"]) >= now - 30 * 86400]
        use = sum(-float(event["delta"]) for event in history if event["kind"] == "use")
        first = min((_event_time(event["at"]) for event in history), default=now)
        observed = min(30.0, max(0.0, (now - first) / 86400.0))
        free = max(0.0, float(item["on_hand"]) - float(item["reserved"]))
        baseline = float(item["baseline_daily"])
        rate, p10, median, p90 = days_distribution(free, baseline, use, observed,
                                                    f"{item['key']}:{item['revision']}")
        risk = "critical" if free <= 0 else "unknown" if baseline <= 0 and use <= 0 else "critical" if p10 <= 7 else "watch" if p10 <= 21 else "stable"
        explanation = ("Enter a daily usage baseline or record usage to enable a forecast."
                       if risk == "unknown" else
                       f"{free:g} {item['unit']} unreserved; {use:g} used in the observed period; "
                       f"{baseline:g}/day baseline. Range reflects demand uncertainty, not delivery certainty.")
        db.call("write_forecast", item["key"], int(item["revision"]), rate, p10, median, p90, risk, explanation)
        out.append({**item, "risk": risk, "days_p10": p10, "days_median": median, "days_p90": p90})
    return out


def propose_transfers(db: Spacetime, projected: list[dict[str, Any]]) -> int:
    proposals = db.table("proposal")
    known_keys = {row["key"] for row in proposals}
    transfers = db.table("transfer")
    count = 0
    for dest in projected:
        if dest["risk"] != "critical" or float(dest["baseline_daily"]) <= 0:
            continue
        if any(row["dest_site_id"] == dest["site_id"] and row["ndc"] == dest["ndc"]
               and row["status"] not in ("cancelled", "received") for row in transfers):
            continue
        target = max(float(dest["safety_stock"]), float(dest["baseline_daily"]) * 21)
        deficit = max(0.0, target - (float(dest["on_hand"]) - float(dest["reserved"])))
        if deficit < 1:
            continue
        sources = [item for item in projected if item["ndc"] == dest["ndc"] and item["site_id"] != dest["site_id"]
                   and item["risk"] == "stable"]
        sources.sort(key=lambda row: float(row["days_p10"]), reverse=True)
        for source in sources:
            surplus = float(source["on_hand"]) - float(source["reserved"]) - float(source["safety_stock"])
            quantity = math.floor(min(deficit, surplus))
            if quantity < 1:
                continue
            key = hashlib.sha256(f"{source['key']}:{source['revision']}:{dest['key']}:{dest['revision']}".encode()).hexdigest()[:24]
            if key in known_keys:
                break
            reason = (f"Destination p10 supply {dest['days_p10']:g} days; source p10 supply "
                      f"{source['days_p10']:g} days. Draft only; source manager must approve a reservation.")
            try:
                db.call("propose_transfer", key, int(source["site_id"]), int(dest["site_id"]),
                        dest["ndc"], quantity, reason)
            except DatabaseError as exc:
                LOG.warning("Proposal skipped: %s", exc)
            else:
                count += 1
            break
    return count


def run_once(db: Spacetime, refresh_fda: bool = True) -> None:
    if refresh_fda:
        sync_fda(db)
    projected = compute_forecasts(db)
    count = propose_transfers(db, projected)
    LOG.info("Forecasted %d inventory items; drafted %d transfer proposals", len(projected), count)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="run one cycle and exit")
    parser.add_argument("--identity", action="store_true", help="print the worker identity and exit")
    parser.add_argument("--no-fda", action="store_true", help="skip FDA download for this run")
    parser.add_argument("--interval", type=int, default=30, help="seconds between forecast cycles")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = Spacetime()
    identity = db.login()
    if args.identity:
        print(identity)
        return
    LOG.info("Worker identity: %s", identity)
    last_fda = 0.0
    while True:
        try:
            if not db.authorized():
                LOG.warning("Grant service access to identity %s in the Network page", identity)
            else:
                due = not args.no_fda and time.time() - last_fda >= 24 * 3600
                run_once(db, refresh_fda=due)
                if due:
                    last_fda = time.time()
        except (DatabaseError, RuntimeError) as exc:
            LOG.error("Cycle failed: %s", exc)
            if args.once:
                raise SystemExit(1) from exc
        if args.once:
            break
        time.sleep(max(5, args.interval))


if __name__ == "__main__":
    main()
