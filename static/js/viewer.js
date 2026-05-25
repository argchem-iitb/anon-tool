/**
 * viewer.js - PDF page rendering with all-pages view and fit-to-width zoom
 */
window.viewer = (function () {
    const scrollEl = document.getElementById('viewer-scroll');
    const container = document.getElementById('viewer-container');
    const loading = document.getElementById('viewer-loading');

    // Per-page DOM refs: pageNum -> { wrapper, img, overlay, bboxEls: {blockId -> div} }
    let pageEls = {};

    function showLoading() { loading.classList.remove('hidden'); }
    function hideLoading() { loading.classList.add('hidden'); }

    /**
     * Render ALL pages stacked vertically with fit-to-width scaling.
     */
    function renderAllPages() {
        const state = window.APP_STATE;
        container.innerHTML = '';
        pageEls = {};

        showLoading();

        let loadedCount = 0;
        const totalPages = state.totalPages;

        for (let pageNum = 0; pageNum < totalPages; pageNum++) {
            (function (pn) {
                // Outer wrapper (for label + page)
                const wrapper = document.createElement('div');
                wrapper.className = 'page-wrapper';
                wrapper.dataset.page = pn;

                // Page label (outside the relative container)
                const label = document.createElement('div');
                label.className = 'page-label';
                label.textContent = 'Page ' + (pn + 1) + ' / ' + totalPages;

                // Inner container (position: relative — holds image + overlay)
                const inner = document.createElement('div');
                inner.className = 'page-inner';

                // Image
                const img = document.createElement('img');
                img.className = 'page-img';
                img.alt = 'Page ' + (pn + 1);

                // Overlay (absolute inside inner, aligned to image)
                const overlay = document.createElement('div');
                overlay.className = 'page-overlay';

                pageEls[pn] = { wrapper: wrapper, img: img, overlay: overlay, bboxEls: {} };

                img.onload = function () {
                    // Fit to available width
                    var availWidth = scrollEl.clientWidth - 60;
                    var zoom = Math.min(1, availWidth / img.naturalWidth);
                    wrapper.dataset.zoom = zoom;
                    img.style.width = (img.naturalWidth * zoom) + 'px';
                    img.style.height = (img.naturalHeight * zoom) + 'px';

                    buildPageOverlay(pn, zoom);

                    loadedCount++;
                    if (loadedCount === totalPages) {
                        hideLoading();
                    }
                };
                img.onerror = function () {
                    loadedCount++;
                    if (loadedCount === totalPages) hideLoading();
                };

                img.src = '/api/page-image/' + state.fileId + '/' + pn;

                inner.appendChild(img);
                inner.appendChild(overlay);
                wrapper.appendChild(label);
                wrapper.appendChild(inner);
                container.appendChild(wrapper);
            })(pageNum);
        }
    }

    /**
     * Build bounding box overlay for a specific page.
     */
    function buildPageOverlay(pageNum, zoom) {
        const state = window.APP_STATE;
        const pe = pageEls[pageNum];
        if (!pe) return;

        pe.overlay.innerHTML = '';
        pe.bboxEls = {};

        const pageBlocks = state.blocks.filter(function (b) { return b.page === pageNum; });

        pageBlocks.forEach(function (block) {
            var div = document.createElement('div');
            div.className = 'bbox';
            div.dataset.blockId = block.id;

            var x0 = block.bbox_px[0], y0 = block.bbox_px[1];
            var x1 = block.bbox_px[2], y1 = block.bbox_px[3];

            div.style.left   = (x0 * zoom) + 'px';
            div.style.top    = (y0 * zoom) + 'px';
            div.style.width  = ((x1 - x0) * zoom) + 'px';
            div.style.height = ((y1 - y0) * zoom) + 'px';

            // Image block style
            if (block.is_image) {
                div.classList.add('bbox-image');
            }

            // PII style
            if (block.pii_flags && block.pii_flags.length > 0) {
                div.classList.add('bbox-pii');
            }

            // AI remove style
            var aiDecision = state.aiDecisions ? state.aiDecisions[block.id] : null;
            if (aiDecision && aiDecision.action === 'remove' && !state.redactSet.has(block.id)) {
                div.classList.add('bbox-ai-remove');
            }

            // Redact style
            if (state.redactSet.has(block.id)) {
                div.classList.add('bbox-redact');
            }

            // Single click = select
            div.addEventListener('click', function (e) {
                e.stopPropagation();
                window.sync.selectBlock(block.id);
            });

            // Double click = toggle redact
            div.addEventListener('dblclick', function (e) {
                e.stopPropagation();
                window.sync.toggleRedact(block.id);
            });

            pe.overlay.appendChild(div);
            pe.bboxEls[block.id] = div;
        });
    }

    /**
     * Rebuild overlays on all pages (e.g. after AI suggestions applied).
     */
    function rebuildAllOverlays() {
        Object.keys(pageEls).forEach(function (pn) {
            var pe = pageEls[pn];
            var zoom = parseFloat(pe.wrapper.dataset.zoom) || 1;
            buildPageOverlay(parseInt(pn), zoom);
        });
    }

    /**
     * Highlight a specific block across all pages.
     */
    function highlightBlock(blockId) {
        // Clear all selections
        Object.values(pageEls).forEach(function (pe) {
            Object.values(pe.bboxEls).forEach(function (el) {
                el.classList.remove('bbox-selected');
            });
        });

        // Find and highlight the block
        for (var pn in pageEls) {
            var el = pageEls[pn].bboxEls[blockId];
            if (el) {
                el.classList.add('bbox-selected');
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                break;
            }
        }
    }

    /**
     * Toggle redact style on a specific block.
     */
    function toggleRedact(blockId, isRedacted) {
        for (var pn in pageEls) {
            var el = pageEls[pn].bboxEls[blockId];
            if (el) {
                el.classList.toggle('bbox-redact', isRedacted);
                if (isRedacted) {
                    el.classList.remove('bbox-ai-remove');
                }
                break;
            }
        }
    }

    /**
     * Refit all pages to current viewport (handles touch-keyboard dismiss).
     */
    function refitAllPages() {
        var availWidth = scrollEl.clientWidth - 60;
        Object.keys(pageEls).forEach(function (pn) {
            var pe = pageEls[pn];
            var img = pe.img;
            if (!img.naturalWidth) return;
            var zoom = Math.min(1, availWidth / img.naturalWidth);
            pe.wrapper.dataset.zoom = zoom;
            img.style.width = (img.naturalWidth * zoom) + 'px';
            img.style.height = (img.naturalHeight * zoom) + 'px';
            buildPageOverlay(parseInt(pn), zoom);
        });
    }

    var _resizeTimer = null;
    function _scheduleRefit() {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(refitAllPages, 120);
    }
    window.addEventListener('resize', _scheduleRefit);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', _scheduleRefit);
    }

    function clearSelection() {
        Object.values(pageEls).forEach(function (pe) {
            Object.values(pe.bboxEls).forEach(function (el) {
                el.classList.remove('bbox-selected');
            });
        });
    }

    /**
     * Scroll to a specific page.
     */
    function scrollToPage(pageNum) {
        var pe = pageEls[pageNum];
        if (pe) {
            pe.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    return {
        renderAllPages: renderAllPages,
        rebuildAllOverlays: rebuildAllOverlays,
        highlightBlock: highlightBlock,
        toggleRedact: toggleRedact,
        clearSelection: clearSelection,
        scrollToPage: scrollToPage,
        refitAllPages: refitAllPages,
    };
})();
