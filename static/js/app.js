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
        textBoxes: [],            // user text: {id, page, x_pt, y_pt, text, fontsize}
        renderScale: 150 / 72,    // px-per-point; refined from scan response
        activeMode: null,         // null | 'mask' | 'text'
        autoDetectOn: false,
        aiDecisions: null,        // blockId -> {action, reason}
        drawingId: null,
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
            state.textBoxes.push({
                id: 'tb_saved_' + i, page: t.page, x_pt: t.x_pt, y_pt: t.y_pt,
                text: t.text || '', fontsize: t.fontsize || 14,
            });
        });

        if (sv.drawing_id) {
            state.drawingId = sv.drawing_id;
            state.metadata = sv.metadata || null;
            state.metadataExtracted = true;   // reuse the existing ID; never regenerate

            var m = sv.metadata || {};
            var set = function (id, v) { var el = document.getElementById(id); if (el) el.value = v || ''; };
            set('meta-client', m.client_name);
            set('meta-part-id', m.original_part_id);
            set('meta-part-name', m.part_name);
            set('meta-quantity', m.quantity || '1');
            set('meta-material', m.material);

            var badge = document.getElementById('drawing-id-badge');
            if (badge) badge.textContent = sv.drawing_id;
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

    // ── Placement modes: Mask Box (white boxes) and Text Box (custom text) ──
    // Mutually exclusive; clicking an active mode turns it off.
    function setMode(mode) {
        state.activeMode = (state.activeMode === mode) ? null : mode;
        maskBtn.classList.toggle('active', state.activeMode === 'mask');
        textBtn.classList.toggle('active', state.activeMode === 'text');
        window.viewer.setMode(state.activeMode);
    }
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
            var hasText = (state.textBoxes || []).some(function (t) { return (t.text || '').trim() !== ''; });
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

            state.drawingId = data.drawing_id;
            state.metadata = data.metadata;
            state.metadataExtracted = true;

            badge.textContent = data.drawing_id;
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
        } catch (err) {
            console.error('Metadata extraction error:', err);
            badge.textContent = 'Error';
        } finally {
            state.metadataExtracting = false;
        }
    }

    // ── Process redaction ──
    processBtn.addEventListener('click', async function () {
        var textBoxesToPlace = (state.textBoxes || []).filter(function (t) { return (t.text || '').trim() !== ''; });
        if (state.redactSet.size === 0 && state.manualBoxes.length === 0 && textBoxesToPlace.length === 0) return;

        processBtn.disabled = true;
        processBtn.textContent = 'Processing...';

        // Safety net: guarantee a Drawing ID exists regardless of how blocks
        // were selected (manual, PII-auto, AI, or manual masks only).
        if (!state.drawingId) {
            processBtn.textContent = 'Generating ID...';
            await extractMetadata(true);
            processBtn.textContent = 'Processing...';
        }

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

        // Custom text boxes (non-empty only)
        var textBoxes = textBoxesToPlace.map(function (t) {
            return { page: t.page, x_pt: t.x_pt, y_pt: t.y_pt, text: t.text, fontsize: t.fontsize };
        });

        // Read metadata from UI fields (user may have edited them)
        var metadata = {
            client_name: document.getElementById('meta-client').value,
            original_part_id: document.getElementById('meta-part-id').value,
            part_name: document.getElementById('meta-part-name').value,
            quantity: document.getElementById('meta-quantity').value,
            material: document.getElementById('meta-material').value,
        };

        var payload = {
            blocks: blocksToRedact,
            manual_boxes: manualBoxes,
            text_boxes: textBoxes,
            drawing_id: state.drawingId || '',
            metadata: metadata,
        };

        try {
            const res = await fetch('/api/redact/' + state.fileId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) throw new Error('Redaction failed');
            const data = await res.json();

            // Show download modal with Drawing ID
            var totalMasks = blocksToRedact.length + manualBoxes.length + textBoxes.length;
            var msg = totalMasks + ' change(s) applied successfully.';
            if (data.drawing_id) {
                msg += ' Drawing ID: ' + data.drawing_id;
            }
            if (data.sheets_error) {
                msg += ' (Sheets sync error: ' + data.sheets_error + ')';
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
            alert('Redaction failed. Please try again.');
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
