/**
 * app.js - Main application controller
 */
(function () {
    // Global state
    window.APP_STATE = {
        fileId: window.FILE_ID,
        filename: window.FILE_NAME,
        totalPages: 0,
        currentPage: 0,
        blocks: [],
        redactSet: new Set(),
        manualRedactSet: new Set(),
        autoFlaggedSet: new Set(),
        aiFlaggedSet: new Set(),
        autoDetectOn: false,
        aiDecisions: null,  // blockId -> {action, reason}
        drawingId: null,
        metadata: null,
    };

    const state = window.APP_STATE;

    // DOM refs
    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    const pageInfo = document.getElementById('pageInfo');
    const autoBtn = document.getElementById('autoDetect');
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

            updatePageNav();

            // Render ALL pages at once (fit-to-width, stacked vertically)
            window.viewer.renderAllPages();

            // Sidebar shows ALL blocks across all pages
            window.sidebar.renderList(state.blocks);
        } catch (err) {
            console.error('Init error:', err);
            alert('Failed to scan PDF. Please try again.');
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
        // Automatically extract metadata after confirming AI suggestions
        extractMetadata();
    });

    // ── Extract Metadata ──
    async function extractMetadata() {
        var blockIds = Array.from(state.redactSet);
        if (blockIds.length === 0) return;

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

            badge.textContent = data.drawing_id;
            document.getElementById('meta-client').value = data.metadata.client_name || '';
            document.getElementById('meta-part-id').value = data.metadata.original_part_id || '';
            document.getElementById('meta-part-name').value = data.metadata.part_name || '';
            document.getElementById('meta-quantity').value = data.metadata.quantity || '1';
            document.getElementById('meta-material').value = data.metadata.material || '';

            // Warn if metadata extraction had errors or returned empty
            if (data.meta_error) {
                console.warn('Metadata extraction error:', data.meta_error);
                var footer = document.querySelector('.drawing-info-footer');
                if (footer) {
                    footer.innerHTML = '<span style="color:#f85149;">⚠ Metadata extraction failed — please fill fields manually</span>';
                }
            } else if (!data.metadata.client_name && !data.metadata.original_part_id) {
                var footer = document.querySelector('.drawing-info-footer');
                if (footer) {
                    footer.innerHTML = '<span style="color:#f0883e;">⚠ Could not auto-detect details — please verify fields</span>';
                }
            }
        } catch (err) {
            console.error('Metadata extraction error:', err);
            badge.textContent = 'Error';
        }
    }

    // ── Process redaction ──
    processBtn.addEventListener('click', async function () {
        if (state.redactSet.size === 0) return;

        processBtn.disabled = true;
        processBtn.textContent = 'Processing...';

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
            var msg = blocksToRedact.length + ' block(s) redacted successfully.';
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

    // Kick off
    init();
})();
