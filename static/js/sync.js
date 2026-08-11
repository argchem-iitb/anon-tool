/**
 * sync.js - Bidirectional sync between viewer and sidebar,
 *           redaction toggling, PII auto-detect, and AI suggestions.
 */
window.sync = (function () {
    let selectedId = null;

    /**
     * Select a block: highlight in both viewer and sidebar.
     */
    function selectBlock(blockId) {
        if (selectedId === blockId) return;
        selectedId = blockId;
        window.viewer.highlightBlock(blockId);
        window.sidebar.highlightItem(blockId);
    }

    /**
     * Toggle redaction state for a block.
     */
    function toggleRedact(blockId) {
        const state = window.APP_STATE;
        const isRedacted = state.redactSet.has(blockId);

        if (isRedacted) {
            state.redactSet.delete(blockId);
            state.manualRedactSet.delete(blockId);
        } else {
            state.redactSet.add(blockId);
            state.manualRedactSet.add(blockId);
        }

        window.viewer.toggleRedact(blockId, !isRedacted);
        window.sidebar.setRedactState(blockId, !isRedacted);
        updateRedactCount();
    }

    /**
     * Auto-detect PII: select all PII-flagged blocks for redaction.
     */
    function enableAutoDetect() {
        const state = window.APP_STATE;
        state.autoFlaggedSet.clear();

        state.blocks.forEach(block => {
            if (block.pii_flags && block.pii_flags.length > 0 && !state.redactSet.has(block.id)) {
                state.redactSet.add(block.id);
                state.autoFlaggedSet.add(block.id);
            }
        });

        refreshView();
        updateRedactCount();
    }

    /**
     * Disable auto-detect: remove auto-flagged (but keep manual).
     */
    function disableAutoDetect() {
        const state = window.APP_STATE;

        state.autoFlaggedSet.forEach(id => {
            if (!state.manualRedactSet.has(id)) {
                state.redactSet.delete(id);
            }
        });
        state.autoFlaggedSet.clear();

        refreshView();
        updateRedactCount();
    }

    /**
     * Apply AI suggestions: mark all "remove" decisions for redaction.
     */
    function applyAISuggestions() {
        const state = window.APP_STATE;
        if (!state.aiDecisions) return;

        state.aiFlaggedSet.clear();

        Object.entries(state.aiDecisions).forEach(function (entry) {
            var blockId = entry[0];
            var decision = entry[1];
            if (decision.action === 'remove' && !state.redactSet.has(blockId)) {
                state.redactSet.add(blockId);
                state.aiFlaggedSet.add(blockId);
            }
        });

        refreshView();
        updateRedactCount();
    }

    /**
     * Bulk-set redaction for many blocks at once, with a SINGLE view refresh
     * (per-block toggling rebuilds the sidebar each time — unusable at
     * 1000+ blocks).
     */
    function bulkSetRedact(blockIds, on) {
        const state = window.APP_STATE;
        blockIds.forEach(function (id) {
            if (on) {
                state.redactSet.add(id);
                state.manualRedactSet.add(id);
            } else {
                state.redactSet.delete(id);
                state.manualRedactSet.delete(id);
                state.autoFlaggedSet.delete(id);
                state.aiFlaggedSet.delete(id);
            }
        });
        refreshView();
        updateRedactCount();
    }

    /**
     * Toggle redaction for every detected block on a page: if all are
     * already redacted, un-redact the page; otherwise redact everything.
     */
    function redactPage(pageNum) {
        const state = window.APP_STATE;
        const ids = state.blocks
            .filter(function (b) { return b.page === pageNum; })
            .map(function (b) { return b.id; });
        if (!ids.length) return;
        const allOn = ids.every(function (id) { return state.redactSet.has(id); });
        bulkSetRedact(ids, !allOn);
    }

    /**
     * Marquee (Area Select): toggle-redact every block intersecting the
     * dragged rectangle (visible-space pt coords). If any block in the area
     * is unredacted, redact them all; if all are redacted, undo them.
     */
    function redactArea(pageNum, rect) {
        const state = window.APP_STATE;
        const x0 = rect[0], y0 = rect[1], x1 = rect[2], y1 = rect[3];
        const ids = state.blocks.filter(function (b) {
            if (b.page !== pageNum) return false;
            const bb = b.bbox_pt;
            // Require the marquee to cover >=50% of the BLOCK's area — mere
            // intersection meant grazing a large image (or a long line)
            // selected the whole thing.
            const ix = Math.min(bb[2], x1) - Math.max(bb[0], x0);
            const iy = Math.min(bb[3], y1) - Math.max(bb[1], y0);
            if (ix <= 0 || iy <= 0) return false;
            const blockArea = (bb[2] - bb[0]) * (bb[3] - bb[1]);
            return blockArea <= 0 || (ix * iy) / blockArea >= 0.5;
        }).map(function (b) { return b.id; });
        if (!ids.length) return;
        const anyOff = ids.some(function (id) { return !state.redactSet.has(id); });
        bulkSetRedact(ids, anyOff);
    }

    /**
     * Re-render all page overlays and sidebar to reflect state changes.
     */
    function refreshView() {
        const state = window.APP_STATE;
        window.viewer.rebuildAllOverlays();
        window.sidebar.renderList(state.blocks);
    }

    function updateRedactCount() {
        const state = window.APP_STATE;
        const manual = state.manualBoxes ? state.manualBoxes.length : 0;
        const texts = state.textBoxes
            ? state.textBoxes.filter(function (t) { return (t.text || '').trim() !== ''; }).length
            : 0;
        const count = state.redactSet.size + manual + texts;
        const el = document.getElementById('redactCount');
        if (el) el.textContent = count + ' selected';
        const pb = document.getElementById('processBtn');
        if (pb) pb.disabled = count === 0;
        // Notify app.js so it can auto-generate a Drawing ID for ANY redaction
        // method (manual, PII auto-detect, or AI) — not just AI confirm.
        document.dispatchEvent(new CustomEvent('redactchange'));
    }

    return {
        selectBlock,
        toggleRedact,
        bulkSetRedact,
        redactPage,
        redactArea,
        enableAutoDetect,
        disableAutoDetect,
        applyAISuggestions,
        refreshView,
        updateRedactCount,
    };
})();
