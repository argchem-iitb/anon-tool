import os
import json
import shutil
import uuid
import math

import fitz
import google.generativeai as genai
from flask import (
    Flask, request, jsonify, render_template,
    redirect, url_for, send_file, Response,
)
from werkzeug.utils import secure_filename

from pii_patterns import scan_pii
from sheets_integration import generate_drawing_id, append_drawing_row


def _log(msg):
    """Encoding-safe print for Windows cp1252 consoles."""
    try:
        print(str(msg))
    except UnicodeEncodeError:
        print(str(msg).encode('ascii', 'replace').decode('ascii'))

app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
app.config["OUTPUT_FOLDER"] = os.path.join(os.path.dirname(__file__), "output")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

RENDER_DPI = 150
SCALE = RENDER_DPI / 72.0

# Ensure storage dirs exist at import time (gunicorn imports the module,
# so this must not live only under __main__).
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["OUTPUT_FOLDER"], exist_ok=True)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

# file_id -> {"filename": str, "path": str}
FILE_REGISTRY = {}

# Cache scan results for AI analysis: file_id -> blocks list
SCAN_CACHE = {}


# ──────────────────────────── helpers ──────────────────────────

def _join_spans(spans):
    """Join spans within a line, adding spaces only where there's a real gap."""
    if not spans:
        return ""
    parts = [spans[0]["text"]]
    for i in range(1, len(spans)):
        prev_end = spans[i - 1]["bbox"][2]  # x1 of previous span
        curr_start = spans[i]["bbox"][0]    # x0 of current span
        gap = curr_start - prev_end
        # Add space only when there's a meaningful positional gap
        if gap > 1.0:
            parts.append(" ")
        parts.append(spans[i]["text"])
    return "".join(parts).strip()


def _extract_blocks(filepath):
    """Extract all text lines and embedded images from PDF.

    Uses get_text('dict') for line-level granularity so that title-block
    cells are individual items even when the PDF merges them into one
    large text block.
    """
    doc = fitz.open(filepath)
    total_pages = len(doc)
    page_dims = {}
    blocks = []

    for page_num in range(total_pages):
        page = doc[page_num]
        rect = page.rect
        page_dims[str(page_num)] = {
            "width_pt": rect.width,
            "height_pt": rect.height,
        }

        idx = 0

        # --- Text: extract at line level for fine granularity ---
        page_dict = page.get_text("dict")
        for b in page_dict["blocks"]:
            if b["type"] != 0:       # skip image blocks from dict
                continue
            for line in b["lines"]:
                text = _join_spans(line["spans"])
                if not text:
                    continue
                bbox = line["bbox"]
                bbox_pt = [bbox[0], bbox[1], bbox[2], bbox[3]]
                bbox_px = [round(c * SCALE, 2) for c in bbox_pt]
                block_id = f"p{page_num}_b{idx}"
                blocks.append({
                    "id": block_id,
                    "page": page_num,
                    "bbox_pt": bbox_pt,
                    "bbox_px": bbox_px,
                    "text": text,
                    "is_image": False,
                    "pii_flags": scan_pii(text),
                })
                idx += 1

        # --- Vector logos: clusters of colored filled paths ---
        try:
            colored_rects = []
            for d in page.get_drawings():
                fill = d.get("fill")
                if not fill or len(fill) < 3:
                    continue
                r, g, b = fill[0], fill[1], fill[2]
                # skip black / white / grayscale fills (technical drawing strokes)
                if max(abs(r - g), abs(g - b), abs(r - b)) < 0.08:
                    continue
                rect = d.get("rect")
                if rect is None or rect.is_empty or rect.is_infinite:
                    continue
                w, h = rect.width, rect.height
                if w < 0.3 or h < 0.3 or w > 200 or h > 200:
                    continue
                colored_rects.append(rect)

            # cluster nearby colored rects (within 8pt) into bounding regions
            clusters = []
            for r in colored_rects:
                placed = False
                for c in clusters:
                    if (r.x0 < c.x1 + 8 and r.x1 > c.x0 - 8 and
                        r.y0 < c.y1 + 8 and r.y1 > c.y0 - 8):
                        c.include_rect(r)
                        placed = True
                        break
                if not placed:
                    clusters.append(fitz.Rect(r))

            for c in clusters:
                # require enough density to be a logo (>=4 colored shapes), reasonable size
                if c.width < 8 or c.height < 8 or c.width > 180 or c.height > 180:
                    continue
                count = sum(1 for r in colored_rects if c.contains(r))
                if count < 4:
                    continue
                bbox_pt = [c.x0, c.y0, c.x1, c.y1]
                bbox_px = [round(v * SCALE, 2) for v in bbox_pt]
                blocks.append({
                    "id": f"p{page_num}_b{idx}",
                    "page": page_num,
                    "bbox_pt": bbox_pt,
                    "bbox_px": bbox_px,
                    "text": "[LOGO]",
                    "is_image": True,
                    "pii_flags": [],
                })
                idx += 1
        except Exception as _e:
            _log(f"[LOGO] vector scan failed p{page_num}: {_e}")

        # --- Embedded images (logos, stamps, etc.) ---
        for img_info in page.get_images(full=True):
            xref = img_info[0]
            try:
                rects = page.get_image_rects(xref)
            except Exception:
                continue
            for r in rects:
                if r.is_empty or r.is_infinite:
                    continue
                bbox_pt = [r.x0, r.y0, r.x1, r.y1]
                bbox_px = [round(c * SCALE, 2) for c in bbox_pt]
                block_id = f"p{page_num}_b{idx}"
                blocks.append({
                    "id": block_id,
                    "page": page_num,
                    "bbox_pt": bbox_pt,
                    "bbox_px": bbox_px,
                    "text": "[IMAGE]",
                    "is_image": True,
                    "pii_flags": [],
                })
                idx += 1

    doc.close()
    return total_pages, page_dims, blocks


def _build_context_objects(blocks, radius_pt=100):
    """For each block, find neighboring text within radius_pt and build context objects."""
    context_objects = []

    for block in blocks:
        cx = (block["bbox_pt"][0] + block["bbox_pt"][2]) / 2
        cy = (block["bbox_pt"][1] + block["bbox_pt"][3]) / 2

        neighbors = []
        for other in blocks:
            if other["id"] == block["id"] or other["page"] != block["page"]:
                continue
            ox = (other["bbox_pt"][0] + other["bbox_pt"][2]) / 2
            oy = (other["bbox_pt"][1] + other["bbox_pt"][3]) / 2
            dist = math.sqrt((cx - ox) ** 2 + (cy - oy) ** 2)
            if dist <= radius_pt:
                neighbors.append(other["text"])

        obj = {
            "id": block["id"],
            "text": block["text"],
            "nearby_labels": neighbors,
        }
        if block.get("is_image"):
            obj["is_image"] = True
        context_objects.append(obj)

    return context_objects


def _call_gemini(context_objects):
    """Send context objects to Gemini and get REMOVE/KEEP decisions."""
    system_prompt = """You are an expert at identifying sensitive information in engineering PDF drawings for a CNC machining shop.

The goal: remove ONLY client-identifying information while KEEPING all manufacturing/process data that the shop needs for production.

For each text block, decide whether it should be REMOVED (redacted) or KEPT visible.

REMOVE — client-identifying information only:
- Company names, organization names, department names, company logos/branding text
- The VALUE of the drawing title (e.g. "SHAFT-E (SDLTH_V2)") — but KEEP the label "TITLE" itself
- The VALUE of drawing/part numbers (e.g. "IF00006703") — but KEEP the label "DRG. NO." itself
- Personal names, signatures, initials (drawn by, checked by, approved by values)
- Email addresses, phone numbers, fax numbers
- Addresses, locations
- Dates (drawn date, revision date, approval date — NOT dimensions)
- Revision history content, ECO numbers, revision detail values
- Confidentiality/IP notices, company-specific form numbers, QMS references
- "FIRST ANGLE PROJECTION" or "THIRD ANGLE PROJECTION" symbols/text

KEEP — manufacturing and process data (even inside the title block):
- Material specifications (e.g. "Aluminium 6061-T6", "SS 304", "Inconel 718") — ALWAYS KEEP
- Heat treatment values (e.g. "N.A.", "Hardened", "Annealed") — ALWAYS KEEP
- Surface treatment/finish values (e.g. "Anodising", "Zinc Plating", "Passivation") — ALWAYS KEEP
- Weight values: raw weight, finish weight, volume (e.g. "1.37+0.3/-0", "1.7", "0.51") — ALWAYS KEEP
- Unit labels (gms, cc, kg, mm) — ALWAYS KEEP
- Title block LABELS/HEADERS: TITLE, DRG. NO., MATERIAL, HEAT TREATMENT, SURF. TREATMENT, RAW WT., MAX. FINISH WT., VOL., SCALE, SHEET, REV., ZONE — KEEP all labels
- Scale values (e.g. "2:1", "1:1") — KEEP
- Sheet info (e.g. "1 of 1") — KEEP
- Dimensions, measurements, tolerances, GD&T callouts
- Technical notes, manufacturing instructions
- View labels ("SECTION A-A", "DETAIL B")
- Drawing border grid labels (A-F, 1-8)
- General notes ("DEBURR AND BREAK SHARP EDGES", "UNLESS OTHERWISE SPECIFIED", "DO NOT SCALE")
- Industry standards (ASTM, ISO, MIL-SPEC)

CRITICAL RULE: If a text block contains manufacturing process data (material, treatment, weight, finish), ALWAYS KEEP it — even if it's inside the title block.

You will receive a JSON array of objects, each with "id", "text", and "nearby_labels" (text from blocks within 100 pixels, for context).
Some objects have "is_image": true — these are embedded images (likely company logos). REMOVE images near company names or title blocks. KEEP images that are technical diagrams.

Return ONLY a JSON array of objects, each with:
- "id": the block ID
- "action": "remove" or "keep"
- "reason": a short explanation (under 15 words)

Return valid JSON only, no markdown fences, no extra text."""

    payload = json.dumps(context_objects, ensure_ascii=False)

    model = genai.GenerativeModel("gemini-2.5-flash")
    response = model.generate_content(
        [system_prompt + "\n\nHere are the text blocks to analyze:\n" + payload],
        generation_config=genai.types.GenerationConfig(
            temperature=0.1,
            max_output_tokens=8192,
        ),
    )

    raw = response.text.strip()
    # Strip markdown fences if present
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
    if raw.endswith("```"):
        raw = raw[: raw.rfind("```")]
    raw = raw.strip()

    # Try parsing directly
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # Repair truncated JSON: find the last complete object and close the array
    last_brace = raw.rfind("}")
    if last_brace != -1:
        truncated = raw[: last_brace + 1]
        # Ensure it starts with [ and ends with ]
        if not truncated.startswith("["):
            truncated = "[" + truncated
        truncated = truncated.rstrip(",").rstrip() + "]"
        try:
            return json.loads(truncated)
        except json.JSONDecodeError:
            pass

    raise ValueError("Could not parse Gemini response")


def _extract_metadata_gemini(removed_blocks):
    """Extract drawing metadata (client, part ID, etc.) from blocks marked for removal."""
    prompt = """You are analyzing text blocks extracted from an engineering drawing's title block area.
These blocks have been identified for redaction. Extract the following metadata:

- client_name: The company or client name (the original company, NOT "Mechximize")
- original_part_id: The drawing number, part number, or document ID (e.g. "IF00006703")
- part_name: The name/title of the part or assembly being drawn
- quantity: Quantity shown (default "1" if not found)
- material: Material specification (e.g., "SS 304", "Al 6061") — empty string if not found

Return ONLY a JSON object on a single line, no newlines within strings:
{"client_name":"...","original_part_id":"...","part_name":"...","quantity":"...","material":"..."}

Return valid JSON only, no markdown fences, no extra text.

Here are the text blocks from the title block:
"""
    texts = [{"id": b["id"], "text": b["text"]} for b in removed_blocks]
    payload = json.dumps(texts, ensure_ascii=False)

    model = genai.GenerativeModel("gemini-2.5-flash")
    response = model.generate_content(
        [prompt + payload],
        generation_config=genai.types.GenerationConfig(
            temperature=0.1,
            max_output_tokens=1024,
        ),
    )

    raw = response.text.strip()
    # Strip markdown fences if present
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
    if raw.endswith("```"):
        raw = raw[: raw.rfind("```")]
    raw = raw.strip()

    # Try parsing directly
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # Repair: find the last complete JSON object
    last_brace = raw.rfind("}")
    if last_brace != -1:
        candidate = raw[: last_brace + 1]
        # Find the first opening brace
        first_brace = candidate.find("{")
        if first_brace != -1:
            candidate = candidate[first_brace:]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass

    raise ValueError(f"Could not parse Gemini metadata response: {raw[:200]}")


def _overlay_new_labels(doc, redact_blocks, drawing_id, scan_blocks=None, metadata=None):
    """Overlay 'Mechximize' in the TITLE value field and Drawing ID in the DRG. NO. value field.

    Strategy: Use metadata text to find the exact removed blocks that held
    the title value and drawing number value, then place overlay text there.
    """
    page_counts = {}
    for bl in redact_blocks:
        page_counts[bl["page"]] = page_counts.get(bl["page"], 0) + 1
    title_page_num = max(page_counts, key=page_counts.get)
    page = doc[title_page_num]

    redact_ids = {bl["id"] for bl in redact_blocks if bl["page"] == title_page_num}
    page_scan_blocks = [b for b in (scan_blocks or []) if b["page"] == title_page_num]

    fontname = "helv"
    color_black = (0, 0, 0)

    def _place_text_in_bbox(bbox, text, fontsize):
        """Place text centered inside a bbox."""
        x0, y0, x1, y1 = bbox
        box_w = x1 - x0
        box_h = y1 - y0
        tw = fitz.get_text_length(text, fontname=fontname, fontsize=fontsize)
        if tw > box_w * 0.95:
            fontsize = fontsize * (box_w * 0.9) / tw
            fontsize = max(6, fontsize)
            tw = fitz.get_text_length(text, fontname=fontname, fontsize=fontsize)
        px = x0 + (box_w - tw) / 2
        py = y0 + (box_h + fontsize) / 2
        page.insert_text(
            fitz.Point(px, py), text,
            fontsize=fontsize, fontname=fontname, color=color_black,
        )

    def _find_removed_block_by_text(search_text):
        """Find a removed block containing the given text."""
        if not search_text:
            return None
        search_upper = search_text.upper()
        for b in page_scan_blocks:
            if b["id"] in redact_ids and search_upper in b["text"].upper():
                return b
        return None

    placed_company = False
    placed_id = False
    meta = metadata or {}

    # --- Strategy 1: Match by metadata text content (most reliable) ---

    # Place "Mechximize" where the title value was
    part_name = meta.get("part_name", "")
    title_block = _find_removed_block_by_text(part_name)
    if title_block:
        _place_text_in_bbox(title_block["bbox_pt"], "Mechximize", 12)
        placed_company = True

    # Place Drawing ID where the original part ID / drawing number was
    original_id = meta.get("original_part_id", "")
    drg_block = _find_removed_block_by_text(original_id)
    if drg_block:
        _place_text_in_bbox(drg_block["bbox_pt"], drawing_id, 10)
        placed_id = True

    # --- Strategy 2: Fallback — use label proximity with directional bias ---
    if not placed_company or not placed_id:
        def _find_label(keywords):
            for b in page_scan_blocks:
                txt = b["text"].upper()
                for kw in keywords:
                    if kw in txt:
                        return b
            return None

        def _find_value_below_label(label_block, exclude_ids=set()):
            """Find the nearest removed block that is BELOW or to the RIGHT of the label."""
            lx = (label_block["bbox_pt"][0] + label_block["bbox_pt"][2]) / 2
            ly = label_block["bbox_pt"][3]  # bottom edge of label
            best, best_dist = None, float("inf")
            for b in page_scan_blocks:
                if b["id"] not in redact_ids or b["id"] in exclude_ids:
                    continue
                bx = (b["bbox_pt"][0] + b["bbox_pt"][2]) / 2
                by = (b["bbox_pt"][1] + b["bbox_pt"][3]) / 2
                # Must be below or to the right of label, not above
                if by < ly - 20:
                    continue
                dist = math.sqrt((lx - bx) ** 2 + (ly - by) ** 2)
                if dist < best_dist:
                    best_dist = dist
                    best = b
            return best

        used_ids = set()

        if not placed_company:
            title_label = _find_label(["TITLE"])
            if title_label:
                val = _find_value_below_label(title_label, used_ids)
                if val:
                    _place_text_in_bbox(val["bbox_pt"], "Mechximize", 12)
                    used_ids.add(val["id"])
                    placed_company = True

        if not placed_id:
            drg_label = _find_label(["DRG. NO", "DRG NO", "DRG.NO", "DRAWING NO"])
            if drg_label:
                val = _find_value_below_label(drg_label, used_ids)
                if val:
                    _place_text_in_bbox(val["bbox_pt"], drawing_id, 10)
                    placed_id = True

    # --- Strategy 3: Last resort fallback — center of title block area ---
    if not placed_company or not placed_id:
        page_bboxes = [bl["bbox_pt"] for bl in redact_blocks if bl["page"] == title_page_num]
        if page_bboxes:
            tb_x0 = min(bb[0] for bb in page_bboxes)
            tb_y0 = min(bb[1] for bb in page_bboxes)
            tb_x1 = max(bb[2] for bb in page_bboxes)
            tb_y1 = max(bb[3] for bb in page_bboxes)
            cx = (tb_x0 + tb_x1) / 2
            cy = (tb_y0 + tb_y1) / 2
            if not placed_company:
                tw = fitz.get_text_length("Mechximize", fontname=fontname, fontsize=12)
                page.insert_text(fitz.Point(cx - tw / 2, cy - 5), "Mechximize",
                                 fontsize=12, fontname=fontname, color=color_black)
            if not placed_id:
                tw = fitz.get_text_length(drawing_id, fontname=fontname, fontsize=10)
                page.insert_text(fitz.Point(cx - tw / 2, cy + 12), drawing_id,
                                 fontsize=10, fontname=fontname, color=color_black)


# ──────────────────────────── pages ────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("pdf")
    if not f or not f.filename.lower().endswith(".pdf"):
        return "Please upload a valid PDF file.", 400

    file_id = uuid.uuid4().hex[:12]
    safe_name = secure_filename(f.filename)
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], f"{file_id}.pdf")
    f.save(save_path)

    FILE_REGISTRY[file_id] = {"filename": safe_name, "path": save_path}
    return redirect(url_for("editor", file_id=file_id))


@app.route("/editor/<file_id>")
def editor(file_id):
    info = FILE_REGISTRY.get(file_id)
    if not info:
        return "File not found.", 404
    return render_template("editor.html", file_id=file_id, filename=info["filename"])


# ──────────────────────────── API ──────────────────────────────

@app.route("/api/scan/<file_id>")
def scan(file_id):
    info = FILE_REGISTRY.get(file_id)
    if not info:
        return jsonify({"error": "not found"}), 404

    total_pages, page_dims, blocks = _extract_blocks(info["path"])
    SCAN_CACHE[file_id] = blocks

    return jsonify({
        "file_id": file_id,
        "filename": info["filename"],
        "total_pages": total_pages,
        "page_dimensions": page_dims,
        "render_dpi": RENDER_DPI,
        "blocks": blocks,
    })


@app.route("/api/page-image/<file_id>/<int:page_num>")
def page_image(file_id, page_num):
    info = FILE_REGISTRY.get(file_id)
    if not info:
        return "not found", 404

    doc = fitz.open(info["path"])
    if page_num < 0 or page_num >= len(doc):
        doc.close()
        return "invalid page", 400

    page = doc[page_num]
    pix = page.get_pixmap(dpi=RENDER_DPI)
    png_bytes = pix.tobytes("png")
    doc.close()

    return Response(png_bytes, mimetype="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.route("/api/analyze/<file_id>", methods=["POST"])
def analyze(file_id):
    """AI Intelligence Layer: send blocks to Gemini for REMOVE/KEEP classification."""
    info = FILE_REGISTRY.get(file_id)
    if not info:
        return jsonify({"error": "not found"}), 404

    blocks = SCAN_CACHE.get(file_id)
    if not blocks:
        _, _, blocks = _extract_blocks(info["path"])
        SCAN_CACHE[file_id] = blocks

    context_objects = _build_context_objects(blocks)

    # Batch into chunks of 15 to stay within token limits
    all_decisions = []
    batch_size = 15
    for i in range(0, len(context_objects), batch_size):
        batch = context_objects[i:i + batch_size]
        try:
            decisions = _call_gemini(batch)
            all_decisions.extend(decisions)
        except Exception as e:
            # On failure, mark the batch as "keep" with error reason
            for obj in batch:
                all_decisions.append({
                    "id": obj["id"],
                    "action": "keep",
                    "reason": f"AI error: {str(e)[:50]}",
                })

    return jsonify({"decisions": all_decisions})


@app.route("/api/extract-metadata/<file_id>", methods=["POST"])
def extract_metadata(file_id):
    """Extract drawing metadata from removed blocks and generate a Drawing ID."""
    info = FILE_REGISTRY.get(file_id)
    if not info:
        return jsonify({"error": "not found"}), 404

    data = request.get_json()
    block_ids = set(data.get("block_ids", []))

    blocks = SCAN_CACHE.get(file_id, [])
    removed_blocks = [b for b in blocks if b["id"] in block_ids and not b.get("is_image")]

    # Extract metadata via Gemini
    meta_error = None
    _log(f"[META] file_id={file_id}, removed_blocks={len(removed_blocks)}")
    _log(f"[META] removed texts: {[b['text'][:60] for b in removed_blocks[:10]]}")
    try:
        metadata = _extract_metadata_gemini(removed_blocks)
        _log(f"[META] extracted: {metadata}")
    except Exception as e:
        meta_error = str(e)[:200]
        _log(f"[META] ERROR: {meta_error}")
        metadata = {
            "client_name": "",
            "original_part_id": "",
            "part_name": "",
            "quantity": "1",
            "material": "",
        }

    # Material is usually KEPT (not removed), so scan ALL blocks for it
    if not metadata.get("material"):
        material_keywords = [
            "ALUMINIUM", "ALUMINUM", "AL6061", "AL 6061", "AL7075", "AL 7075",
            "MAGNESIUM", "INCONEL", "STAINLESS", "STEEL", "TITANIUM",
            "BRASS", "COPPER", "NICKEL", "NYLON", "PEEK", "DELRIN",
            "6061", "7075", "2024", "AZ31", "AZ91", "SS 304", "SS304",
            "SS 316", "SS316", "MS ", "MILD STEEL",
        ]
        for b in blocks:
            text = b.get("text", "").strip()
            text_upper = text.upper()
            # Skip labels themselves, very short text, and image blocks
            if text_upper in ("MATERIAL", "HEAT TREATMENT", "SURFACE FINISH"):
                continue
            if len(text) < 2 or b.get("is_image"):
                continue
            for kw in material_keywords:
                if kw in text_upper:
                    metadata["material"] = text
                    break
            if metadata.get("material"):
                break

    # Generate the next Drawing ID from the spreadsheet
    try:
        drawing_id = generate_drawing_id()
    except Exception as e:
        drawing_id = "DI_ERROR"

    return jsonify({
        "drawing_id": drawing_id,
        "metadata": metadata,
        "meta_error": meta_error,
    })


@app.route("/api/redact/<file_id>", methods=["POST"])
def redact(file_id):
    info = FILE_REGISTRY.get(file_id)
    if not info:
        return jsonify({"error": "not found"}), 404

    data = request.get_json()
    redact_blocks = data.get("blocks", [])
    drawing_id = data.get("drawing_id", "")
    metadata = data.get("metadata", {})

    # Debug: log what metadata we received
    _log(f"[REDACT] file_id={file_id}, drawing_id={drawing_id}")
    _log(f"[REDACT] metadata={metadata}")
    _log(f"[REDACT] blocks_to_redact={len(redact_blocks)}")

    if not redact_blocks:
        return jsonify({"error": "no blocks to redact"}), 400

    output_path = os.path.join(
        app.config["OUTPUT_FOLDER"], f"{file_id}_redacted.pdf"
    )

    doc = fitz.open(info["path"])

    # Step 1: Apply redactions (existing logic)
    pages_map = {}
    for bl in redact_blocks:
        pg = bl["page"]
        pages_map.setdefault(pg, []).append(bl["bbox_pt"])

    REDACT_PAD = 3  # pt padding to catch edge characters

    for page_num, bboxes in pages_map.items():
        page = doc[page_num]
        page_rect = page.rect
        for bbox in bboxes:
            rect = fitz.Rect(bbox)
            rect.x0 = max(rect.x0 - REDACT_PAD, page_rect.x0)
            rect.y0 = max(rect.y0 - REDACT_PAD, page_rect.y0)
            rect.x1 = min(rect.x1 + REDACT_PAD, page_rect.x1)
            rect.y1 = min(rect.y1 + REDACT_PAD, page_rect.y1)
            page.add_redact_annot(rect, fill=(1, 1, 1))  # white fill
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE)

    # Step 2: Overlay "Mechximize" + Drawing ID on the title block
    if drawing_id and drawing_id != "DI_ERROR":
        scan_blocks = SCAN_CACHE.get(file_id, [])
        _overlay_new_labels(doc, redact_blocks, drawing_id,
                            scan_blocks=scan_blocks, metadata=metadata)

    doc.save(output_path, garbage=4, deflate=True)
    doc.close()

    # Step 3: Write row to Google Sheets
    sheets_error = None
    if drawing_id and drawing_id != "DI_ERROR":
        try:
            append_drawing_row(
                drawing_id=drawing_id,
                company_name=metadata.get("client_name", ""),
                original_part_id=metadata.get("original_part_id", ""),
                part_name=metadata.get("part_name", ""),
                quantity=metadata.get("quantity", "1"),
                material=metadata.get("material", ""),
            )
        except Exception as e:
            sheets_error = str(e)[:100]

    # Store drawing_id for download filename
    if drawing_id and drawing_id != "DI_ERROR":
        FILE_REGISTRY[file_id]["drawing_id"] = drawing_id

    return jsonify({
        "status": "ok",
        "download_url": url_for("download", file_id=file_id),
        "drawing_id": drawing_id,
        "sheets_error": sheets_error,
    })


@app.route("/download/<file_id>")
def download(file_id):
    info = FILE_REGISTRY.get(file_id)
    if not info:
        return "not found", 404

    output_path = os.path.join(
        app.config["OUTPUT_FOLDER"], f"{file_id}_redacted.pdf"
    )
    if not os.path.exists(output_path):
        return "Redacted file not found. Process redaction first.", 404

    # Use Drawing ID as filename if available, otherwise fallback
    drawing_id = info.get("drawing_id", "")
    if drawing_id:
        dl_name = f"{drawing_id}.pdf"
    else:
        dl_name = f"REDACTED_{info['filename']}"

    return send_file(
        output_path,
        as_attachment=True,
        download_name=dl_name,
    )


if __name__ == "__main__":
    # Local dev only. On Render, gunicorn serves the `app` object directly.
    port = int(os.environ.get("PORT", 5000))
    # use_reloader=False — auto-reload was wiping FILE_REGISTRY on spurious
    # changes (pip's vendored libs), causing 404s mid-session.
    app.run(debug=True, host="0.0.0.0", port=port, use_reloader=False, threaded=True)
