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
        const count = state.redactSet.size + manual;
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
        enableAutoDetect,
        disableAutoDetect,
        applyAISuggestions,
        refreshView,
        updateRedactCount,
    };
})();
