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
