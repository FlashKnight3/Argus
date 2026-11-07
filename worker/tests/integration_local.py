"""Exercise the published module on a disposable argus-supply-verify database.

Run after `spacetime publish argus-supply-verify ...`. This test deliberately
uses sample inventory only in that verification database, never in the app DB.
"""
import tempfile
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from argus_supply import DatabaseError, Spacetime, compute_forecasts, propose_transfers, sync_fda


def row(db, table, **fields):
    return next(item for item in db.table(table) if all(item.get(k) == v for k, v in fields.items()))


def main():
    db_name = os.environ.get("ARGUS_VERIFY_DB", "argus-supply-verify")
    with tempfile.TemporaryDirectory(prefix="argus-supply-verify-") as tmp:
        owner = Spacetime(db=db_name, token_file=Path(tmp) / "owner.json")
        service = Spacetime(db=db_name, token_file=Path(tmp) / "service.json")
        owner.login(); service.login()
        if owner.table("member"):
            raise RuntimeError("Verification database already has members; publish a fresh test database")
        owner.call("bootstrap_network", "Verification Admin", "Source Pharmacy", "Test region")
        owner.call("create_site", "Destination Pharmacy", "Test region", "")
        owner.call("grant_member", service.identity, "Verification Worker", "service", 0)
        assert service.authorized()
        print("Importing the complete current FDA feed into the verification database…", flush=True)
        imported = sync_fda(service)
        assert imported > 100
        assert row(owner, "sync_state", id=1)["status"] == "complete"
        assert len(owner.table("shortage")) == imported

        code = "0228255106"
        owner.call("upsert_inventory", 1, code, "Verification product", "vials", 500, 1, 20, "")
        owner.call("upsert_inventory", 2, code, "Verification product", "vials", 3, 5, 20, "")
        owner.call("record_stock", f"1:{code}", "use", 2, "verification usage")
        projected = compute_forecasts(service)
        assert len(projected) == 2
        assert row(service, "forecast", key=f"2:{code}")["risk"] == "critical"
        assert propose_transfers(service, projected) == 1
        proposal = row(owner, "proposal", status="pending")
        try:
            service.call("approve_transfer", 1)
        except DatabaseError:
            pass
        else:
            raise AssertionError("Service identity approved stock movement")
        owner.call("upsert_inventory", 2, code, "Verification product", "boxes", 3, 5, 20, "")
        try:
            owner.call("accept_proposal", proposal["key"])
        except DatabaseError:
            pass
        else:
            raise AssertionError("Mismatched source/destination units were accepted")
        owner.call("upsert_inventory", 2, code, "Verification product", "vials", 3, 5, 20, "")
        owner.call("accept_proposal", proposal["key"])
        transfer = row(owner, "transfer", status="requested")
        owner.call("approve_transfer", transfer["id"])
        source = row(owner, "inventory", key=f"1:{code}")
        assert source["reserved"] == transfer["quantity"]
        owner.call("ship_transfer", transfer["id"])
        owner.call("receive_transfer", transfer["id"])
        assert row(owner, "transfer", id=transfer["id"])["status"] == "received"
        dest = row(owner, "inventory", key=f"2:{code}")
        assert dest["on_hand"] == 3 + transfer["quantity"]
        assert row(owner, "inventory", key=f"1:{code}")["reserved"] == 0
        owner.call("create_transfer", 1, 2, code, 1, "receipt unit verification")
        second = max(owner.table("transfer"), key=lambda item: item["id"])
        owner.call("approve_transfer", second["id"])
        owner.call("ship_transfer", second["id"])
        owner.call("upsert_inventory", 2, code, "Verification product", "boxes", dest["on_hand"], 5, 20, "")
        try:
            owner.call("receive_transfer", second["id"])
        except DatabaseError:
            pass
        else:
            raise AssertionError("Receipt accepted a changed destination unit")
        owner.call("upsert_inventory", 2, code, "Verification product", "vials", dest["on_hand"], 5, 20, "")
        owner.call("receive_transfer", second["id"])
        assert row(owner, "inventory", key=f"2:{code}")["on_hand"] == dest["on_hand"] + 1
        print(f"PASS: {imported} real FDA records, forecasts, agent draft, human approval, ship/receipt, unit guards")


if __name__ == "__main__":
    main()
