"""Minimal SpacetimeDB HTTP client (stdlib only).

Reads use ``POST /v1/database/:name/sql``; writes use
``POST /v1/database/:name/call/:reducer`` with a JSON array of arguments.
Works fully offline against a local ``spacetime start``.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

DEFAULT_HOST = os.environ.get("ARGUS_STDB_HOST", "http://127.0.0.1:3000")
DEFAULT_DB = os.environ.get("ARGUS_STDB_DB", "argus")


class ReducerError(RuntimeError):
    """A reducer rejected the call (e.g. a SenderError)."""


def _col_name(element: dict[str, Any], index: int) -> str:
    name = element.get("name")
    if isinstance(name, dict):  # SATS-JSON option: {"some": "x"} / {"none": []}
        name = name.get("some")
    return name if isinstance(name, str) else f"col{index}"


def _decode(value: Any) -> Any:
    # Timestamps arrive as {"__timestamp_micros_since_unix_epoch__": n}.
    if isinstance(value, dict) and len(value) == 1:
        (k, v), = value.items()
        if k.startswith("__") and k.endswith("__"):
            return v
    return value


def rows_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    elements = result.get("schema", {}).get("elements", [])
    names = [_col_name(e, i) for i, e in enumerate(elements)]
    return [{n: _decode(v) for n, v in zip(names, row)} for row in result.get("rows", [])]


@dataclass
class SpacetimeClient:
    host: str = DEFAULT_HOST
    database: str = DEFAULT_DB
    token: str | None = None
    timeout: float = 5.0
    _headers: dict[str, str] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        self.host = self.host.rstrip("/")
        if self.token:
            self._headers["Authorization"] = f"Bearer {self.token}"

    # ── transport ───────────────────────────────────────────────────────────
    def _post(self, path: str, body: bytes, content_type: str) -> Any:
        req = urllib.request.Request(
            f"{self.host}{path}",
            data=body,
            method="POST",
            headers={"Content-Type": content_type, **self._headers},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace").strip()
            raise ReducerError(f"{path}: HTTP {e.code}: {detail}") from None
        return json.loads(raw) if raw else None

    def login(self) -> None:
        """Obtain a stable identity token so audit entries name this process."""
        if self.token:
            return
        data = self._post("/v1/identity", b"", "application/json")
        if isinstance(data, dict) and data.get("token"):
            self.token = data["token"]
            self._headers["Authorization"] = f"Bearer {self.token}"

    # ── API ─────────────────────────────────────────────────────────────────
    def sql(self, query: str) -> list[list[dict[str, Any]]]:
        """Run one or more `;`-separated statements; returns rows per statement."""
        data = self._post(f"/v1/database/{self.database}/sql", query.encode(), "text/plain")
        return [rows_from_result(r) for r in (data or [])]

    def table(self, name: str) -> list[dict[str, Any]]:
        return self.sql(f"SELECT * FROM {name}")[0]

    def call(self, reducer: str, *args: Any) -> None:
        self._post(
            f"/v1/database/{self.database}/call/{reducer}",
            json.dumps(list(args)).encode(),
            "application/json",
        )

    def ping(self) -> bool:
        try:
            self.sql("SELECT * FROM sim_state")
            return True
        except (urllib.error.URLError, ReducerError, OSError):
            return False
