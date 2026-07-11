"""End-to-end tests: upload preview → mapping → commit → dashboard."""
import io
import sys
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEADS_DB_PATH", str(tmp_path / "test.db"))
    for mod in ("db", "ingest", "analytics", "main"):
        sys.modules.pop(mod, None)
    import db as db_module
    db_module.DB_PATH = tmp_path / "test.db"
    import main
    return TestClient(main.app)


def sample_xlsx() -> bytes:
    df = pd.DataFrame({
        "Sl No": [1, 2, 3, 4],
        "Opportunity Name": ["A - P1", "B - P1", "C - P2", "D - P2"],
        "Manager (User Name)": ["Riya", "Riya", "Sam", "Sam"],
        "Created On": ["2026-07-01 10:00", "2026-07-02 11:00", "2026-07-08 12:00", 0],
        "QL": ["QL", "Lost", "Open", "Lost"],
        "No. of Site Visits": [1, 0, 0, 0],
        "UTM Source - Name": ["ig", "fb", "ig", 0],
        "UTM Source - UTM Campaign": ["Camp1"] * 4,
        "Reason for Lost": [0, "Invalid Enquiry", 0, "Not Interested"],
        "Number of Attempts": [3, 5, 0, 2],
        "Project Name": ["P1", "P1", "P2", "P2"],
    })
    buf = io.BytesIO()
    df.to_excel(buf, index=False)
    return buf.getvalue()


def do_upload(client, data=None, name="dump.xlsx"):
    res = client.post("/api/uploads/preview",
                      files={"file": (name, data or sample_xlsx(),
                                      "application/octet-stream")})
    assert res.status_code == 200, res.text
    return res.json()


def test_preview_suggests_mapping(client):
    p = do_upload(client)
    m = p["suggested_mapping"]
    assert m["created_on"] == "Created On"
    assert m["ql"] == "QL"
    assert m["utm_source"] == "UTM Source - Name"
    assert m["project"] == "Project Name"
    assert m["manager"] == "Manager (User Name)"
    assert p["row_count"] == 4


def test_commit_and_dashboard(client):
    p = do_upload(client)
    res = client.post("/api/uploads/commit",
                      json={"token": p["token"], "mapping": p["suggested_mapping"]})
    assert res.status_code == 200, res.text
    assert res.json()["row_count"] == 4

    dash = client.get("/api/dashboard").json()
    assert dash["empty"] is False
    k = dash["kpis"]
    assert k["total"] == 4 and k["ql"] == 1 and k["lost"] == 2 and k["open"] == 1
    assert k["ql_rate"] == 25.0
    assert k["invalid"] == 1 and k["visits"] == 1
    assert len(dash["weekly"]) == 2  # two ISO weeks
    src_names = {s["name"] for s in dash["sources"]}
    assert {"Instagram", "Facebook", "Unattributed"} <= src_names
    assert {p["name"] for p in dash["projects"]} == {"P1", "P2"}


def test_missing_required_mapping_rejected(client):
    p = do_upload(client)
    mapping = dict(p["suggested_mapping"], created_on=None)
    res = client.post("/api/uploads/commit", json={"token": p["token"], "mapping": mapping})
    assert res.status_code == 400
    assert "Created date" in res.json()["detail"]


def test_csv_and_append_model(client):
    csv = b"Created On,Lead Status\n2026-07-01,Qualified\n2026-07-02,Closed - Lost\n"
    p = do_upload(client, data=csv, name="dump.csv")
    m = p["suggested_mapping"]
    assert m["created_on"] == "Created On" and m["ql"] == "Lead Status"
    client.post("/api/uploads/commit", json={"token": p["token"], "mapping": m})

    p2 = do_upload(client)
    client.post("/api/uploads/commit",
                json={"token": p2["token"], "mapping": p2["suggested_mapping"]})

    assert len(client.get("/api/uploads").json()) == 2
    assert client.get("/api/dashboard?upload_id=all").json()["kpis"]["total"] == 6
    assert client.get("/api/dashboard?upload_id=latest").json()["kpis"]["total"] == 4


def test_ql_bucketing(client):
    csv = (b"Created On,Lead Status\n"
           b"2026-07-01,Qualified/Interested\n"
           b"2026-07-01,Closed - Lost\n"
           b"2026-07-01,Followup\n")
    p = do_upload(client, data=csv, name="s.csv")
    client.post("/api/uploads/commit",
                json={"token": p["token"], "mapping": p["suggested_mapping"]})
    k = client.get("/api/dashboard").json()["kpis"]
    assert (k["ql"], k["lost"], k["open"]) == (1, 1, 1)


def test_delete_upload(client):
    p = do_upload(client)
    up = client.post("/api/uploads/commit",
                     json={"token": p["token"], "mapping": p["suggested_mapping"]}).json()
    assert client.delete(f"/api/uploads/{up['id']}").status_code == 200
    assert client.get("/api/dashboard").json()["empty"] is True


def test_unsupported_file_rejected(client):
    res = client.post("/api/uploads/preview",
                      files={"file": ("dump.pdf", b"%PDF", "application/pdf")})
    assert res.status_code == 400
