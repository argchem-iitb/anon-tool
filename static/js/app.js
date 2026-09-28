/**
 * app.js - Main application controller
 */
(function () {
    // Global state
    window.APP_STATE = {
        fileId: window.FILE_ID,
        filename: window.FILE_NAME,
        batchId: window.BATCH_ID || '',
        totalPages: 0,
        currentPage: 0,
        blocks: [],
        redactSet: new Set(),
        manualRedactSet: new Set(),
        autoFlaggedSet: new Set(),
        aiFlaggedSet: new Set(),
        manualBoxes: [],          // user-drawn white masks: {id, page, bbox_pt}
        textBoxes: [],            // {id, page, x_pt, y_pt, text, fontsize, role?}; role marks
                                  // the Mechximize ('company') / 'drawing_id' labels
        renderScale: 150 / 72,    // px-per-point; refined from scan response
        activeMode: null,         // null | 'mask' | 'text'
        autoDetectOn: false,
        aiDecisions: null,        // blockId -> {action, reason}
        drawingId: null,          // effective Drawing ID (null until known / picked)
        idMode: 'new',            // 'new' (fresh ID) | 'revision' (of an existing drawing)
        freshDrawingId: null,     // the fresh ID offered in 'new' mode
        revisionBase: null,       // base Drawing ID picked in 'revision' mode
        revisionDrawingId: null,  // the revision ID assigned for revisionBase
        labelsInit: false,        // Mechximize / Drawing ID labels placed once already
        metadata: null,
        metadataExtracted: false,
        metadataExtracting: false,
    };

    const state = window.APP_STATE;

    // DOM refs
    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    const pageInfo = document.getElementById('pageInfo');
    const autoBtn = document.getElementById('autoDetect');
    const areaBtn = document.getElementById('areaSelect');
    const maskBtn = document.getElementById('maskBox');
    const textBtn = document.getElementById('textBox');
    const aiBtn = document.getElementById('aiAnalyze');
    const confirmAIBtn = document.getElementById('confirmAI');
    const aiStatus = document.getElementById('ai-status');
    const aiStatusText = document.getElementById('ai-status-text');
    const processBtn = document.getElementById('processBtn');
    const modal = document.getElementById('download-modal');
    const modalMsg = document.getElementById('modal-msg');
    const downloadLink = document.getElementById('download-link');
    const modalClose = document.getElementById('modal-close');

    // ── Init ──
    async function init() {
        try {
            const res = await fetch('/api/scan/' + state.fileId);
            if (!res.ok) throw new Error('Scan failed');
            const data = await res.json();

            state.totalPages = data.total_pages;
            state.blocks = data.blocks;
            state.currentPage = 0;
            state.pageDims = data.page_dimensions || {};
            if (data.render_dpi) state.renderScale = data.render_dpi / 72;

            // If this exact drawing was processed before, restore its Drawing ID
            // and prior redactions so the user builds on it instead of restarting.
            if (data.saved) restoreSavedState(data.saved);

            updatePageNav();

            // Render ALL pages at once (fit-to-width, stacked vertically)
            window.viewer.renderAllPages();

            // Sidebar shows ALL blocks across all pages
            window.sidebar.renderList(state.blocks);

            // Reflect any restored selections in the counter / Process button.
            window.sync.updateRedactCount();

            // Reopened drawings saved before labels were draggable get them now.
            if (state.drawingId && !state.labelsInit) placeLabels(false);
        } catch (err) {
            console.error('Init error:', err);
            alert('Failed to scan PDF. Please try again.');
        }
    }

    // ── Restore prior work for a reopened drawing ──
    function restoreSavedState(sv) {
        var restored = 0;
        (sv.redact_block_ids || []).forEach(function (id) {
            if (state.blocks.some(function (b) { return b.id === id; })) {
                state.redactSet.add(id);
                state.manualRedactSet.add(id);
                restored++;
            }
        });
        (sv.manual_boxes || []).forEach(function (mb, i) {
            state.manualBoxes.push({ id: 'mb_saved_' + i, page: mb.page, bbox_pt: mb.bbox_pt });
        });
        (sv.text_boxes || []).forEach(function (t, i) {
            var tb = {
                id: 'tb_saved_' + i, page: t.page, x_pt: t.x_pt, y_pt: t.y_pt,
                text: t.text || '', fontsize: t.fontsize || 14,
            };
            // Labels come back exactly where the user left them.
            if (t.role === 'company' || t.role === 'drawing_id') {
                tb.role = t.role;
                tb.moved = true;
            }
            state.textBoxes.push(tb);
        });
        state.labelsInit = !!sv.labels_placed;

        if (sv.drawing_id) {
            state.metadata = sv.metadata || null;
            state.metadataExtracted = true;   // reuse the existing ID; never regenerate

            var m = sv.metadata || {};
            var set = function (id, v) { var el = document.getElementById(id); if (el) el.value = v || ''; };
            set('meta-client', m.client_name);
            set('meta-part-id', m.original_part_id);
            set('meta-part-name', m.part_name);
            set('meta-quantity', m.quantity || '1');
            set('meta-material', m.material);

            adoptDrawingId(sv.drawing_id);
            var panel = document.getElementById('drawing-info-panel');
            if (panel) panel.classList.remove('hidden');
            var footer = document.querySelector('.drawing-info-footer');
            if (footer) {
                footer.innerHTML = '<span style="color:#3fb950;">↺ Reopened — Drawing ID ' +
                    sv.drawing_id + ' and ' + restored + ' prior selection(s) restored.</span>';
            }
        }
    }

    // ── Page navigation (jump-to-page) ──
    function updatePageNav() {
        pageInfo.textContent = 'Page ' + (state.currentPage + 1) + ' / ' + state.totalPages;
        prevBtn.disabled = state.currentPage <= 0;
        nextBtn.disabled = state.currentPage >= state.totalPages - 1;
    }

    prevBtn.addEventListener('click', function () {
        if (state.currentPage > 0) {
            state.currentPage--;
            updatePageNav();
            window.viewer.scrollToPage(state.currentPage);
        }
    });
    nextBtn.addEventListener('click', function () {
        if (state.currentPage < state.totalPages - 1) {
            state.currentPage++;
            updatePageNav();
            window.viewer.scrollToPage(state.currentPage);
        }
    });

    // Keyboard navigation
    document.addEventListener('keydown', function (e) {
        // Don't intercept if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            if (state.currentPage > 0) {
                state.currentPage--;
                updatePageNav();
                window.viewer.scrollToPage(state.currentPage);
            }
            e.preventDefault();
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            if (state.currentPage < state.totalPages - 1) {
                state.currentPage++;
                updatePageNav();
                window.viewer.scrollToPage(state.currentPage);
            }
            e.preventDefault();
        }
    });

    // ── Auto-detect PII ──
    autoBtn.addEventListener('click', function () {
        state.autoDetectOn = !state.autoDetectOn;
        autoBtn.classList.toggle('active', state.autoDetectOn);

        if (state.autoDetectOn) {
            window.sync.enableAutoDetect();
        } else {
            window.sync.disableAutoDetect();
        }
    });

    // ── Placement modes: Area Select (marquee bulk-redact), Mask Box
    //    (white boxes), Text Box (custom text) ──
    // Mutually exclusive; clicking an active mode turns it off.
    function setMode(mode) {
        state.activeMode = (state.activeMode === mode) ? null : mode;
        areaBtn.classList.toggle('active', state.activeMode === 'select');
        maskBtn.classList.toggle('active', state.activeMode === 'mask');
        textBtn.classList.toggle('active', state.activeMode === 'text');
        window.viewer.setMode(state.activeMode);
    }
    areaBtn.addEventListener('click', function () { setMode('select'); });
    maskBtn.addEventListener('click', function () { setMode('mask'); });
    textBtn.addEventListener('click', function () { setMode('text'); });

    // ── Auto-generate Drawing ID for ANY redaction method ──
    // Fires (debounced) whenever the redaction selection changes, so manually
    // redacting no longer requires running AI to get a pseudonymized ID.
    var _metaTimer = null;
    document.addEventListener('redactchange', function () {
        clearTimeout(_metaTimer);
        _metaTimer = setTimeout(function () {
            if (state.metadataExtracted || state.metadataExtracting) return;
            var hasText = (state.textBoxes || []).some(function (t) { return !t.role && (t.text || '').trim() !== ''; });
            if (state.redactSet.size > 0 || state.manualBoxes.length > 0 || hasText) {
                extractMetadata(false);
            }
        }, 700);
    });

    // ── AI Analyze ──
    aiBtn.addEventListener('click', async function () {
        aiBtn.disabled = true;
        aiStatus.classList.remove('hidden');
        aiStatusText.textContent = 'Analyzing ' + state.blocks.length + ' blocks with Gemini...';

        try {
            const res = await fetch('/api/analyze/' + state.fileId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!res.ok) throw new Error('AI analysis failed');
            const data = await res.json();

            // Build decisions map: blockId -> {action, reason}
            state.aiDecisions = {};
            var removeCount = 0;
            data.decisions.forEach(function (d) {
                state.aiDecisions[d.id] = {
                    action: d.action,
                    reason: d.reason || '',
                };
                if (d.action === 'remove') removeCount++;
            });

            aiStatusText.textContent = 'AI flagged ' + removeCount + ' block(s) for removal.';

            // Show confirm button if there are items to remove
            if (removeCount > 0) {
                confirmAIBtn.classList.remove('hidden');
                confirmAIBtn.textContent = 'Confirm AI Suggestions (' + removeCount + ')';
            }

            // Refresh the view to show AI badges and highlights
            window.sync.refreshView();

            // Hide status bar after 4 seconds
            setTimeout(function () {
                aiStatus.classList.add('hidden');
            }, 4000);

        } catch (err) {
            console.error('AI analysis error:', err);
            aiStatusText.textContent = 'AI analysis failed: ' + err.message;
            setTimeout(function () {
                aiStatus.classList.add('hidden');
            }, 4000);
        } finally {
            aiBtn.disabled = false;
        }
    });

    // ── Confirm AI Suggestions ──
    confirmAIBtn.addEventListener('click', function () {
        window.sync.applyAISuggestions();
        confirmAIBtn.classList.add('hidden');
        // Re-extract metadata using the (now larger) AI selection.
        extractMetadata(true);
    });

    // ── Extract Metadata + generate Drawing ID ──
    // force=false: run once (auto-trigger); force=true: re-run (AI confirm /
    // Process safety-net). Works for manual, PII-auto, or AI selections — and
    // still generates a Drawing ID when only manual masks are drawn.
    function extractMetadata(force) {
        // Concurrent callers (auto-trigger + Process safety-net) share the
        // same in-flight promise so Process can await an ID already generating.
        if (state.metadataExtracting && state._metaPromise) return state._metaPromise;
        if (state.metadataExtracted && !force) return Promise.resolve();

        var blockIds = Array.from(state.redactSet);
        if (blockIds.length === 0 && state.manualBoxes.length === 0) return Promise.resolve();

        state.metadataExtracting = true;
        state._metaPromise = _doExtractMetadata(blockIds);
        return state._metaPromise;
    }

    async function _doExtractMetadata(blockIds) {
        var panel = document.getElementById('drawing-info-panel');
        var badge = document.getElementById('drawing-id-badge');
        badge.textContent = 'Generating...';
        panel.classList.remove('hidden');

        try {
            var res = await fetch('/api/extract-metadata/' + state.fileId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ block_ids: blockIds }),
            });
            if (!res.ok) throw new Error('Metadata extraction failed');
            var data = await res.json();

            state.metadata = data.metadata;
            state.metadataExtracted = true;

            adoptDrawingId(data.drawing_id);
            document.getElementById('meta-client').value = data.metadata.client_name || '';
            document.getElementById('meta-part-id').value = data.metadata.original_part_id || '';
            document.getElementById('meta-part-name').value = data.metadata.part_name || '';
            document.getElementById('meta-quantity').value = data.metadata.quantity || '1';
            document.getElementById('meta-material').value = data.metadata.material || '';

            // Warn if metadata extraction had errors or returned empty
            var footer = document.querySelector('.drawing-info-footer');
            if (data.meta_error) {
                console.warn('Metadata extraction error:', data.meta_error);
                if (footer) {
                    footer.innerHTML = '<span style="color:#f85149;">⚠ Metadata extraction failed — please fill fields manually</span>';
                }
            } else if (!data.metadata.client_name && !data.metadata.original_part_id) {
                if (footer) {
                    footer.innerHTML = '<span style="color:#f0883e;">⚠ Verify fields — auto-detect found little. Drawing ID still assigned.</span>';
                }
            }

            // Labels appear with the first Drawing ID; later re-extractions
            // (e.g. AI confirm) re-suggest spots for labels not yet dragged.
            placeLabels(false);
        } catch (err) {
            console.error('Metadata extraction error:', err);
            if (state.drawingId) {
                badge.textContent = state.drawingId;   // keep the ID we already have
            } else {
                badge.textContent = 'Error — click to retry';
                badge.title = 'The server call failed (it may have been busy). Click to retry.';
            }
        } finally {
            state.metadataExtracting = false;
        }
    }

    // Error badge is clickable to retry a failed Drawing-ID generation.
    document.getElementById('drawing-id-badge').addEventListener('click', function () {
        if (!state.drawingId && state.idMode === 'new') extractMetadata(true);
    });

    // ── Drawing ID: a fresh ID, or a revision of an existing drawing ──
    // Revisions keep the base ID plus a letter: DI04260012-RevA, -RevB, …
    // (see sheets_integration.py). Nothing is reserved until Process writes
    // the Sheet row, so switching back and forth is free.
    var badgeEl = document.getElementById('drawing-id-badge');
    var idModeBtns = document.querySelectorAll('.id-mode-btn');
    var idModeNote = document.getElementById('id-mode-note');
    var revisionPicker = document.getElementById('revision-picker');
    var revisionSearch = document.getElementById('revision-search');
    var revisionResults = document.getElementById('revision-results');

    // 'DI04260012-RevB' -> {base: 'DI04260012', rev: 'B'} (mirrors split_revision)
    function parseDrawingId(id) {
        var m = /^(.+)-Rev([A-Z]{1,3})$/.exec(id || '');
        return m ? { base: m[1], rev: m[2] } : { base: id || '', rev: '' };
    }

    function renderIdMode(errorMsg) {
        idModeBtns.forEach(function (b) {
            b.classList.toggle('active', b.dataset.mode === state.idMode);
        });
        revisionPicker.classList.toggle('hidden', state.idMode !== 'revision');
        var note = '';
        if (errorMsg) {
            note = '⚠ ' + errorMsg;
        } else if (state.idMode === 'revision') {
            var p = parseDrawingId(state.drawingId);
            note = p.rev ? 'Recording Rev ' + p.rev + ' of ' + p.base + '.'
                         : 'Pick the drawing this file is a revision of.';
        }
        idModeNote.textContent = note;
        idModeNote.classList.toggle('error', !!errorMsg);
    }

    // Make `id` the effective Drawing ID and reflect it everywhere it shows.
    function applyDrawingId(id) {
        state.drawingId = id || null;
        badgeEl.textContent = id || (state.idMode === 'revision' ? 'Pick a drawing…' : '—');
        var tb = findLabel('drawing_id');
        if (tb) {
            tb.text = labelText('drawing_id');
            window.viewer.updateTextBox(tb);
        }
        renderIdMode();
    }

    // An ID the server resolved for this drawing (extracted, or reopened).
    // A revision ID means this exact file was recorded as that revision.
    function adoptDrawingId(id) {
        var p = parseDrawingId(id);
        if (p.rev) {
            state.idMode = 'revision';
            state.revisionBase = p.base;
            state.revisionDrawingId = id;
            if (!_searchResults.length) runRevisionSearch();   // picker is visible: fill it
        } else {
            state.freshDrawingId = id;
        }
        applyDrawingId(state.idMode === 'new' ? state.freshDrawingId : state.revisionDrawingId);
    }

    var _idRequest = 0;
    async function requestDrawingId(body) {
        var token = ++_idRequest;
        badgeEl.textContent = 'Generating...';
        try {
            var res = await fetch('/api/drawing-id/' + state.fileId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
            return token === _idRequest ? data.drawing_id : null;  // superseded by a newer request
        } catch (err) {
            console.error('Drawing ID error:', err);
            if (token === _idRequest) {
                applyDrawingId(null);
                renderIdMode('Could not get a Drawing ID: ' + err.message);
            }
            return null;
        }
    }

    async function setIdMode(mode) {
        // Re-clicking "New" after a failed generation (DI_ERROR) retries it.
        if (mode === state.idMode && !(mode === 'new' && state.drawingId === 'DI_ERROR')) return;
        state.idMode = mode;
        if (mode === 'revision') {
            applyDrawingId(state.revisionDrawingId);
            if (!state.revisionDrawingId) revisionSearch.focus();
            runRevisionSearch();
            if (state.revisionDrawingId) placeLabels(false);
            return;
        }
        if (state.freshDrawingId && state.freshDrawingId !== 'DI_ERROR') {
            applyDrawingId(state.freshDrawingId);
        } else {
            applyDrawingId(null);
            var id = await requestDrawingId({ mode: 'new' });
            if (!id || state.idMode !== 'new') return;
            state.freshDrawingId = id;
            applyDrawingId(id);
        }
        placeLabels(false);
    }

    idModeBtns.forEach(function (b) {
        b.addEventListener('click', function () { setIdMode(b.dataset.mode); });
    });

    async function pickRevision(r) {
        state.revisionBase = r.base_id;
        state.revisionDrawingId = null;
        applyDrawingId(null);
        revisionResults.querySelectorAll('.revision-item').forEach(function (li) {
            li.classList.toggle('selected', li.dataset.baseId === r.base_id);
        });
        var id = await requestDrawingId({ mode: 'revision', base_id: r.base_id });
        if (!id || state.idMode !== 'revision' || state.revisionBase !== r.base_id) return;
        state.revisionDrawingId = id;
        applyDrawingId(id);
        // A revision describes the same part: fill any blank fields from it.
        [['meta-client', r.client], ['meta-part-id', r.part_id], ['meta-part-name', r.part_name]]
            .forEach(function (f) {
                var el = document.getElementById(f[0]);
                if (el && !el.value.trim() && f[1]) el.value = f[1];
            });
        placeLabels(false);
    }

    var _searchTimer = null, _searchSeq = 0, _searchResults = [];
    async function runRevisionSearch() {
        var seq = ++_searchSeq;
        // Reading the Sheet can take a few seconds: never leave the list blank.
        revisionResults.classList.add('loading');
        if (!_searchResults.length) {
            revisionResults.innerHTML = '';
            addResultNote('Loading drawings from the Google Sheet…');
        }
        var params = new URLSearchParams({
            q: revisionSearch.value.trim(),
            // Drawings with this file's part no. are listed first.
            hint: document.getElementById('meta-part-id').value.trim(),
        });
        try {
            var res = await fetch('/api/drawings/search?' + params.toString());
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            if (seq === _searchSeq) renderRevisionResults(data.results || [], data.sheet_error);
        } catch (err) {
            if (seq !== _searchSeq) return;
            _searchResults = [];
            revisionResults.innerHTML = '';
            addResultNote('Search failed: ' + err.message);
        } finally {
            if (seq === _searchSeq) revisionResults.classList.remove('loading');
        }
    }

    function addResultNote(text) {
        var li = document.createElement('li');
        li.className = 'revision-empty';
        li.textContent = text;
        revisionResults.appendChild(li);
    }

    function renderRevisionResults(results, sheetError) {
        _searchResults = results;
        revisionResults.innerHTML = '';
        if (sheetError) addResultNote('Google Sheet unavailable — showing drawings known to this server only.');
        if (!results.length) addResultNote('No matching drawings.');
        results.forEach(function (r) {
            var li = document.createElement('li');
            li.className = 'revision-item' + (r.base_id === state.revisionBase ? ' selected' : '');
            li.dataset.baseId = r.base_id;

            var top = document.createElement('div');
            var idEl = document.createElement('span');
            idEl.className = 'revision-id';
            idEl.textContent = r.base_id;
            top.appendChild(idEl);
            var latest = document.createElement('span');
            latest.className = 'revision-latest';
            latest.textContent = r.revisions.length
                ? 'latest Rev ' + r.revisions[r.revisions.length - 1]
                : 'no revisions yet';
            top.appendChild(latest);
            if (r.match) {
                var tag = document.createElement('span');
                tag.className = 'revision-match';
                tag.textContent = 'same part no.';
                top.appendChild(tag);
            }
            li.appendChild(top);

            var details = [r.client, r.part_id, r.part_name].filter(Boolean).join(' · ');
            if (details) {
                var meta = document.createElement('div');
                meta.className = 'revision-meta';
                meta.textContent = details;
                meta.title = details;
                li.appendChild(meta);
            }
            li.addEventListener('click', function () { pickRevision(r); });
            revisionResults.appendChild(li);
        });
    }

    revisionSearch.addEventListener('input', function () {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(runRevisionSearch, 250);
    });
    revisionSearch.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && _searchResults.length) {
            e.preventDefault();
            pickRevision(_searchResults[0]);
        }
    });

    // ── Mechximize / Drawing ID labels ──
    // Draggable text boxes (role 'company' / 'drawing_id') that the server
    // stamps exactly where they sit in the editor — nothing is auto-placed at
    // Process time. They start at a suggested spot near the redacted title
    // block; once the user drags a label, suggestions leave it alone.
    var COMPANY_LABEL = 'Mechximize';
    var LABEL_ROLES = ['company', 'drawing_id'];

    function findLabel(role) {
        return (state.textBoxes || []).find(function (t) { return t.role === role; });
    }

    function labelText(role) {
        return role === 'company' ? COMPANY_LABEL : (state.drawingId || 'Drawing ID');
    }

    function readMetadataFields() {
        return {
            client_name: document.getElementById('meta-client').value,
            original_part_id: document.getElementById('meta-part-id').value,
            part_name: document.getElementById('meta-part-name').value,
            quantity: document.getElementById('meta-quantity').value,
            material: document.getElementById('meta-material').value,
        };
    }

    // force=false: first placement, and re-suggest labels not dragged yet
    //   (never resurrects a label the user removed).
    // force=true ("Auto-place"): move both to the suggestion, re-adding any
    //   removed label.
    // Calls are serialized so overlapping requests can't duplicate labels.
    var _labelsChain = Promise.resolve();
    function placeLabels(force) {
        _labelsChain = _labelsChain
            .then(function () { return _doPlaceLabels(force); })
            .catch(function (err) { console.error('Label placement error:', err); });
        return _labelsChain;
    }

    async function _doPlaceLabels(force) {
        var res = await fetch('/api/suggest-labels/' + state.fileId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                block_ids: Array.from(state.redactSet),
                manual_boxes: state.manualBoxes.map(function (b) { return { page: b.page, bbox_pt: b.bbox_pt }; }),
                drawing_id: state.drawingId || '',
                metadata: readMetadataFields(),
            }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var suggested = (await res.json()).labels || {};

        LABEL_ROLES.forEach(function (role, i) {
            var pos = suggested[role] || fallbackLabelPos(i);
            var tb = findLabel(role);
            if (!tb) {
                if (state.labelsInit && !force) return;   // the user removed it
                window.viewer.addTextBox(pos.page, pos.x_pt, pos.y_pt, {
                    role: role, text: labelText(role), fontsize: pos.fontsize, focus: false,
                });
            } else if (force || !tb.moved) {
                tb.moved = false;
                window.viewer.placeTextBox(tb, pos.page, pos.x_pt, pos.y_pt, pos.fontsize);
            }
        });
        state.labelsInit = true;
    }

    // Nothing redacted to anchor to: bottom-right of the current page, where
    // title blocks usually sit.
    function fallbackLabelPos(i) {
        var dims = (state.pageDims || {})[String(state.currentPage)] || { width_pt: 842, height_pt: 595 };
        return {
            page: state.currentPage,
            x_pt: dims.width_pt * 0.72,
            y_pt: dims.height_pt * 0.88 + i * 18,
            fontsize: i ? 10 : 12,
        };
    }

    document.getElementById('autoPlaceLabels').addEventListener('click', function () {
        placeLabels(true);
    });

    // ── Process redaction ──
    processBtn.addEventListener('click', async function () {
        var hasUserText = (state.textBoxes || []).some(function (t) { return !t.role && (t.text || '').trim() !== ''; });
        if (state.redactSet.size === 0 && state.manualBoxes.length === 0 && !hasUserText) return;
        if (state.idMode === 'revision' && !state.drawingId) {
            alert('Pick the drawing this file is a revision of (or switch to "New Drawing ID") before processing.');
            return;
        }

        processBtn.disabled = true;
        processBtn.textContent = 'Processing...';

        // Safety net: guarantee a Drawing ID exists regardless of how blocks
        // were selected (manual, PII-auto, AI, or manual masks only).
        if (!state.drawingId) {
            processBtn.textContent = 'Generating ID...';
            await extractMetadata(true);
            processBtn.textContent = 'Processing...';
        }
        // Labels must be on the page before the payload is built: an ID
        // generated just now places them asynchronously.
        if (state.drawingId && !state.labelsInit) placeLabels(false);
        await _labelsChain;

        // Build the redaction payload
        const blocksToRedact = [];
        state.redactSet.forEach(id => {
            const block = state.blocks.find(b => b.id === id);
            if (block) {
                blocksToRedact.push({
                    id: block.id,
                    page: block.page,
                    bbox_pt: block.bbox_pt,
                });
            }
        });

        // Manual white masks (user-drawn over undetected content)
        var manualBoxes = state.manualBoxes.map(function (b) {
            return { page: b.page, bbox_pt: b.bbox_pt };
        });

        // Custom text boxes (non-empty only) + the positioned labels
        var textBoxes = (state.textBoxes || []).filter(function (t) {
            return t.role || (t.text || '').trim() !== '';
        }).map(function (t) {
            var out = { page: t.page, x_pt: t.x_pt, y_pt: t.y_pt, text: t.text, fontsize: t.fontsize };
            if (t.role) out.role = t.role;
            return out;
        });

        var payload = {
            blocks: blocksToRedact,
            manual_boxes: manualBoxes,
            text_boxes: textBoxes,
            drawing_id: state.drawingId || '',
            // Read metadata from UI fields (user may have edited them)
            metadata: readMetadataFields(),
            labels_placed: state.labelsInit,
        };

        try {
            const res = await fetch('/api/redact/' + state.fileId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                var detail = '';
                try { detail = (await res.text()).slice(0, 120); } catch (e) {}
                throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail : '') +
                    (res.status === 502 ? ' (server ran out of memory or restarted)' : ''));
            }
            const data = await res.json();

            // Show download modal with Drawing ID
            var userTexts = textBoxes.filter(function (t) { return !t.role; }).length;
            var totalMasks = blocksToRedact.length + manualBoxes.length + userTexts;
            var msg = totalMasks + ' change(s) applied successfully.';
            if (data.drawing_id) {
                msg += ' Drawing ID: ' + data.drawing_id;
            }
            if (data.sheets_error) {
                msg += ' (Sheets sync error: ' + data.sheets_error + ')';
            }
            if (data.warnings && data.warnings.length) {
                msg += '\n⚠ ' + data.warnings.join('\n⚠ ');
            }
            modalMsg.textContent = msg;
            downloadLink.href = data.download_url;
            var dlName = data.drawing_id ? data.drawing_id + '.pdf' : 'REDACTED_' + state.filename;
            downloadLink.textContent = 'Download ' + dlName;

            // Batch context: offer a way back to the batch list
            var batchLink = document.getElementById('batch-link');
            if (state.batchId && batchLink) {
                batchLink.href = '/batch/' + state.batchId;
                batchLink.classList.remove('hidden');
            }

            modal.classList.remove('hidden');
        } catch (err) {
            console.error('Redaction error:', err);
            alert('Redaction failed: ' + err.message + '\nYour selection is preserved — try again.');
        } finally {
            processBtn.disabled = false;
            processBtn.textContent = 'Process Redaction';
        }
    });

    // ── Modal close ──
    modalClose.addEventListener('click', function () {
        modal.classList.add('hidden');
    });

    // Touch-keyboard suppression: inputs start readonly. Double-click/tap to edit.
    document.querySelectorAll('input[readonly]').forEach(function (inp) {
        inp.addEventListener('dblclick', function () {
            inp.removeAttribute('readonly');
            inp.focus();
            inp.select();
        });
        inp.addEventListener('blur', function () {
            inp.setAttribute('readonly', '');
        });
    });

    // The on-screen (touch) keyboard can leave the page scrolled or the layout
    // offset after it closes, which was making the sidebar unreachable. Snap the
    // root viewport back to origin whenever focus leaves a field or the visual
    // viewport resizes (keyboard open/close).
    function _restoreViewport() {
        window.scrollTo(0, 0);
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    }
    document.addEventListener('focusout', _restoreViewport);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', _restoreViewport);
    }

    // Kick off
    init();
})();
