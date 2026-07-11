"""Standalone leads dashboard: upload a daily Excel/CSV lead dump, map columns,
publish the dashboard.

Run:  uvicorn main:app --reload --port 8100   (from leads-dashboard/backend)
"""
from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

import analytics
import db
import ingest

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
STATIC_DIR = Path(__file__).parent.parent / "static"

app = FastAPI(title="Leads Dashboard")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# Preview cache: token -> parsed file, pending commit. In-memory is fine for a
# single-process mini-app; previews are transient by design.
_previews: Dict[str, Dict[str, Any]] = {}


class CommitRequest(BaseModel):
    token: str
    mapping: Dict[str, Optional[str]]


@app.post("/api/uploads/preview")
async def preview_upload(file: UploadFile = File(...)) -> Dict[str, Any]:
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File exceeds 20 MB limit")
    try:
        df, sheet = ingest.read_table(data, file.filename or "upload")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    columns = [str(c) for c in df.columns]
    token = str(uuid.uuid4())
    if len(_previews) > 50:
        _previews.clear()
    _previews[token] = {"df": df, "filename": file.filename or "upload"}

    sample = df.head(5).fillna("").astype(str).to_dict(orient="records")
    return {
        "token": token,
        "filename": file.filename,
        "sheet": sheet,
        "row_count": len(df),
        "columns": columns,
        "suggested_mapping": ingest.suggest_mapping(columns),
        "fields": {
            f: {"label": spec["label"], "required": spec["required"]}
            for f, spec in ingest.CANONICAL_FIELDS.items()
        },
        "sample_rows": sample,
    }


@app.post("/api/uploads/commit")
def commit_upload(req: CommitRequest) -> Dict[str, Any]:
    preview = _previews.get(req.token)
    if not preview:
        raise HTTPException(404, "Preview expired — upload the file again")
    try:
        rows = ingest.normalize(preview["df"], req.mapping)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    upload = db.create_upload(preview["filename"], req.mapping, rows)
    del _previews[req.token]
    return upload


@app.get("/api/uploads")
def get_uploads() -> list:
    return db.list_uploads()


@app.delete("/api/uploads/{upload_id}")
def remove_upload(upload_id: str) -> Dict[str, bool]:
    if not db.delete_upload(upload_id):
        raise HTTPException(404, "Upload not found")
    return {"deleted": True}


@app.get("/api/dashboard")
def get_dashboard(upload_id: str = "latest") -> Dict[str, Any]:
    """upload_id: 'latest' (default), 'all' (every appended row), or an upload id."""
    if upload_id == "all":
        leads = db.fetch_leads(None)
    elif upload_id == "latest":
        latest = db.latest_upload_id()
        leads = db.fetch_leads(latest) if latest else []
    else:
        leads = db.fetch_leads(upload_id)
    if not leads:
        return {"empty": True}
    return {"empty": False, **analytics.compute_dashboard(leads)}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
