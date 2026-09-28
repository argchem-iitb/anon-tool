"""
sheets_integration.py - Google Sheets integration for Drawing ID tracking.

Requires:
  - gspread + google-auth
  - A service_account.json file in the project root
  - The spreadsheet shared with the service account email as Editor
"""

import os
import re
import json
import time
from datetime import datetime

import gspread
from google.oauth2.service_account import Credentials

SPREADSHEET_ID = "1zBiHjVfG94fUG_Zxu-8uoo3F8-DEPrlyslidI5X3QP8"
SHEET_NAME = "Drawing ID"
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
SERVICE_ACCOUNT_FILE = os.path.join(os.path.dirname(__file__), "service_account.json")

_client = None  # lazy singleton


def _get_sheet():
    """Return the gspread Worksheet object, initializing the client once."""
    global _client
    if _client is None:
        # Prefer the JSON blob from an env var (Render secret); fall back to
        # the local service_account.json file for local development.
        sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
        if sa_json:
            info = json.loads(sa_json)
            creds = Credentials.from_service_account_info(info, scopes=SCOPES)
        else:
            creds = Credentials.from_service_account_file(
                SERVICE_ACCOUNT_FILE, scopes=SCOPES
            )
        _client = gspread.authorize(creds)
    spreadsheet = _client.open_by_key(SPREADSHEET_ID)
    return spreadsheet.worksheet(SHEET_NAME)


def generate_drawing_id():
    """Generate the next Drawing ID in format DIMMYY####.

    Reads column D (Assigned Part Name) to find the current max sequence
    for the current month/year prefix, then returns the next one.
    """
    now = datetime.now()
    mm = f"{now.month:02d}"
    yy = f"{now.year % 100:02d}"
    prefix = f"DI{mm}{yy}"  # e.g. "DI0326" for March 2026

    sheet = _get_sheet()
    assigned_col = sheet.col_values(4)  # Column D

    pattern = re.compile(rf"^{prefix}(\d{{4}})$")
    max_seq = 0
    for val in assigned_col:
        m = pattern.match(str(val).strip())
        if m:
            seq = int(m.group(1))
            if seq > max_seq:
                max_seq = seq

    next_seq = max_seq + 1
    return f"{prefix}{next_seq:04d}"


# ── Revisions ──
# A revision keeps its base Drawing ID and adds a letter suffix:
#   DI04260012 -> DI04260012-RevA -> DI04260012-RevB -> ...
# Letters follow the ASME Y14.35 drawing-revision convention: I, O, Q, S, X
# and Z are skipped (easily misread as 1, 0, 5, 2), and after Y come AA, AB...
# No dot in the suffix, so "DI04260012-RevA.pdf" has a single extension.
REV_ALPHABET = "ABCDEFGHJKLMNPRTUVWY"
_REV_RE = re.compile(r"^(?P<base>.+)-Rev(?P<rev>[A-Z]{1,3})$")


def split_revision(drawing_id):
    """'DI04260012-RevB' -> ('DI04260012', 'B'); 'DI04260012' -> ('DI04260012', '')."""
    s = str(drawing_id or "").strip()
    m = _REV_RE.match(s)
    if m:
        return m.group("base"), m.group("rev")
    return s, ""


def _rev_to_index(rev):
    """'A' -> 1, 'Y' -> 20, 'AA' -> 21. None for letters outside the convention."""
    n = 0
    for ch in rev:
        i = REV_ALPHABET.find(ch)
        if i < 0:
            return None
        n = n * len(REV_ALPHABET) + i + 1
    return n


def _index_to_rev(n):
    letters = ""
    while n > 0:
        n, r = divmod(n - 1, len(REV_ALPHABET))
        letters = REV_ALPHABET[r] + letters
    return letters


def next_revision_id(base_id, existing_ids):
    """The next free revision of base_id, given every Drawing ID in use."""
    base_id, _ = split_revision(base_id)
    highest = 0
    for did in existing_ids:
        base, rev = split_revision(did)
        if base == base_id and rev:
            highest = max(highest, _rev_to_index(rev) or 0)
    return f"{base_id}-Rev{_index_to_rev(highest + 1)}"


_rows_cache = {"at": 0.0, "rows": None}


def list_drawing_rows(max_age=60):
    """Every sheet row that carries a Drawing ID, as dicts with drawing_id,
    client, part_id and part_name.

    Cached for max_age seconds so search-as-you-type doesn't hit the Sheets
    API on every keystroke; max_age=0 forces a fresh read.
    """
    now = time.time()
    if _rows_cache["rows"] is not None and now - _rows_cache["at"] < max_age:
        return _rows_cache["rows"]
    rows = []
    for r in _get_sheet().get_all_values():
        r = list(r) + [""] * (8 - len(r))
        drawing_id = str(r[3]).strip()
        if not drawing_id or " " in drawing_id:  # blank, or the header row
            continue
        rows.append({
            "drawing_id": drawing_id,
            "client": str(r[1]).strip(),
            "part_id": str(r[5]).strip(),
            "part_name": str(r[6]).strip(),
        })
    _rows_cache.update(at=now, rows=rows)
    return rows


def append_drawing_row(
    drawing_id,
    company_name,
    original_part_id,
    part_name,
    quantity,
    material,
    status="Under Process",
):
    """Append a new row to the Drawing ID spreadsheet.

    Column layout:
      A: Order No (blank)
      B: Company Name
      C: Quotation (blank)
      D: Assigned Part Name (= Drawing ID)
      E: Quantity
      F: Part ID (original from drawing)
      G: Part Name if specified
      H: Material
      I: (empty)
      J: Status
      K: Vendor (blank - managed on sheet)
      L: Comments (blank - managed on sheet)
    """
    sheet = _get_sheet()
    row = [
        "",               # A: Order No
        company_name,     # B: Company Name
        "",               # C: Quotation
        drawing_id,       # D: Assigned Part Name
        str(quantity),    # E: Quantity
        original_part_id, # F: Part ID
        part_name,        # G: Part Name
        material,         # H: Material
        "",               # I: (empty)
        status,           # J: Status
        "",               # K: Vendor
        "",               # L: Comments
    ]
    # Use explicit row update instead of append_row to avoid table-range detection issues
    all_rows = sheet.get_all_values()  # Gets all rows including those with data in any column
    next_row = len(all_rows) + 1
    cell_range = f"A{next_row}:L{next_row}"
    sheet.update(cell_range, [row], value_input_option="USER_ENTERED")
    return row


def append_or_update_drawing_row(
    drawing_id,
    company_name,
    original_part_id,
    part_name,
    quantity,
    material,
    status="Under Process",
):
    """Idempotent write: if a row with this Drawing ID (column D) already exists,
    update only the tool-owned columns; otherwise append a new row.

    Reprocessing a reopened drawing must NOT create a duplicate row, and must NOT
    wipe columns a human manages on the sheet — Order No (A), Quotation (C),
    Vendor (K), Comments (L), and Status (J) are left untouched on update.
    """
    sheet = _get_sheet()

    row_idx = None
    for i, val in enumerate(sheet.col_values(4), start=1):  # column D
        if str(val).strip() == str(drawing_id).strip():
            row_idx = i
            break

    if row_idx is None:
        result = append_drawing_row(
            drawing_id, company_name, original_part_id,
            part_name, quantity, material, status,
        )
    else:
        # Update only B (company) and E:H (qty, part id, part name, material).
        sheet.batch_update(
            [
                {"range": f"B{row_idx}", "values": [[company_name]]},
                {"range": f"E{row_idx}:H{row_idx}",
                 "values": [[str(quantity), original_part_id, part_name, material]]},
            ],
            value_input_option="USER_ENTERED",
        )
        result = {"updated_row": row_idx}
    _rows_cache["rows"] = None  # drawing searches should see this write
    return result
