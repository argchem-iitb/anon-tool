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

    // ── Placement modes: 'mask' (draw white boxes) or 'text' (add text) ──
    let _activeMode = null;   // null | 'mask' | 'text'
    let _mbCounter = 0;
    let _tbCounter = 0;

    function setMode(mode) {
        _activeMode = mode || null;
        document.body.classList.toggle('mask-mode', _activeMode === 'mask');
        document.body.classList.toggle('text-mode', _activeMode === 'text');
    }

    function rebuildPage(pageNum) {
        var pe = pageEls[pageNum];
        if (pe) buildPageOverlay(pageNum, parseFloat(pe.wrapper.dataset.zoom) || 1);
    }

    function addManualBox(pageNum, bbox_pt) {
        const state = window.APP_STATE;
        if (!state.manualBoxes) state.manualBoxes = [];
        const id = 'mb_' + pageNum + '_' + (_mbCounter++);
        state.manualBoxes.push({ id: id, page: pageNum, bbox_pt: bbox_pt });
        const pe = pageEls[pageNum];
        if (pe) buildPageOverlay(pageNum, parseFloat(pe.wrapper.dataset.zoom) || 1);
        if (window.sync && window.sync.updateRedactCount) window.sync.updateRedactCount();
    }

    function removeManualBox(id) {
        const state = window.APP_STATE;
        if (!state.manualBoxes) return;
        const idx = state.manualBoxes.findIndex(function (b) { return b.id === id; });
        if (idx < 0) return;
        const pageNum = state.manualBoxes[idx].page;
        state.manualBoxes.splice(idx, 1);
        const pe = pageEls[pageNum];
        if (pe) buildPageOverlay(pageNum, parseFloat(pe.wrapper.dataset.zoom) || 1);
        if (window.sync && window.sync.updateRedactCount) window.sync.updateRedactCount();
    }

    // ── Custom text boxes (place text anywhere) ──
    function addTextBox(pageNum, x_pt, y_pt) {
        const state = window.APP_STATE;
        if (!state.textBoxes) state.textBoxes = [];
        const id = 'tb_' + pageNum + '_' + (_tbCounter++);
        state.textBoxes.push({ id: id, page: pageNum, x_pt: x_pt, y_pt: y_pt, text: '', fontsize: 14 });
        rebuildPage(pageNum);
        if (window.sync && window.sync.updateRedactCount) window.sync.updateRedactCount();
        // Focus the fresh input so the user can type immediately.
        const pe = pageEls[pageNum];
        if (pe) {
            const el = pe.overlay.querySelector('[data-tb-id="' + id + '"] .text-box-input');
            if (el) el.focus();
        }
    }

    function removeTextBox(id) {
        const state = window.APP_STATE;
        if (!state.textBoxes) return;
        const idx = state.textBoxes.findIndex(function (t) { return t.id === id; });
        if (idx < 0) return;
        const pageNum = state.textBoxes[idx].page;
        state.textBoxes.splice(idx, 1);
        rebuildPage(pageNum);
        if (window.sync && window.sync.updateRedactCount) window.sync.updateRedactCount();
    }

    // Drag a text box by its grip handle (updates x_pt/y_pt in PDF points).
    function attachTextDrag(handle, tb, pageNum) {
        handle.addEventListener('mousedown', function (e) {
            e.preventDefault(); e.stopPropagation();
            const pe = pageEls[pageNum];
            const zoom = parseFloat(pe.wrapper.dataset.zoom) || 1;
            const scale = (window.APP_STATE.renderScale) || (150 / 72);
            const f = 1 / (scale * zoom);
            const startX = e.clientX, startY = e.clientY;
            const origX = tb.x_pt, origY = tb.y_pt;
            const tEl = pe.overlay.querySelector('[data-tb-id="' + tb.id + '"]');
            function move(ev) {
                tb.x_pt = Math.max(0, origX + (ev.clientX - startX) * f);
                tb.y_pt = Math.max(0, origY + (ev.clientY - startY) * f);
                if (tEl) {
                    tEl.style.left = (tb.x_pt * scale * zoom) + 'px';
                    tEl.style.top = (tb.y_pt * scale * zoom) + 'px';
                }
            }
            function up() {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            }
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    }

    /**
     * Attach drag-to-draw handlers to a page's draw layer. Active only in
     * draw mode; converts the drawn rectangle to PDF points and stores it.
     */
    function attachDrawHandlers(pageNum, layer) {
        let startX = 0, startY = 0, band = null, drawing = false;

        function localXY(e) {
            const rect = layer.getBoundingClientRect();
            return [e.clientX - rect.left, e.clientY - rect.top];
        }

        layer.addEventListener('mousedown', function (e) {
            if (_activeMode !== 'mask' || e.button !== 0) return;
            e.preventDefault();
            const xy = localXY(e);
            startX = xy[0]; startY = xy[1];
            drawing = true;
            band = document.createElement('div');
            band.className = 'draw-band';
            band.style.left = startX + 'px';
            band.style.top = startY + 'px';
            layer.appendChild(band);
        });

        layer.addEventListener('mousemove', function (e) {
            if (!drawing || !band) return;
            const xy = localXY(e);
            const x = Math.min(startX, xy[0]), y = Math.min(startY, xy[1]);
            const w = Math.abs(xy[0] - startX), h = Math.abs(xy[1] - startY);
            band.style.left = x + 'px';
            band.style.top = y + 'px';
            band.style.width = w + 'px';
            band.style.height = h + 'px';
        });

        function finish(e) {
            if (!drawing) return;
            drawing = false;
            const xy = localXY(e);
            const x = Math.min(startX, xy[0]), y = Math.min(startY, xy[1]);
            const w = Math.abs(xy[0] - startX), h = Math.abs(xy[1] - startY);
            if (band && band.parentNode) band.parentNode.removeChild(band);
            band = null;
            if (w < 5 || h < 5) return;  // ignore accidental clicks

            const state = window.APP_STATE;
            const pe = pageEls[pageNum];
            const zoom = parseFloat(pe.wrapper.dataset.zoom) || 1;
            const scale = state.renderScale || (150 / 72);
            const f = 1 / (scale * zoom);  // displayed px -> PDF points
            const bbox_pt = [x * f, y * f, (x + w) * f, (y + h) * f];
            addManualBox(pageNum, bbox_pt);
        }

        layer.addEventListener('mouseup', finish);
        layer.addEventListener('mouseleave', function (e) { if (drawing) finish(e); });

        // Text mode: a click on empty page area drops a new text box there.
        layer.addEventListener('click', function (e) {
            if (_activeMode !== 'text') return;
            const xy = localXY(e);
            const pe = pageEls[pageNum];
            const zoom = parseFloat(pe.wrapper.dataset.zoom) || 1;
            const scale = (window.APP_STATE.renderScale) || (150 / 72);
            const f = 1 / (scale * zoom);
            addTextBox(pageNum, xy[0] * f, xy[1] * f);
        });
    }

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

                // Draw layer (captures drag-to-mask only when draw mode is on)
                const drawlayer = document.createElement('div');
                drawlayer.className = 'page-drawlayer';
                attachDrawHandlers(pn, drawlayer);

                pageEls[pn] = {
                    wrapper: wrapper, img: img, overlay: overlay,
                    drawlayer: drawlayer, bboxEls: {},
                };

                img.onload = function () {
                    // Fit to available width
                    var availWidth = scrollEl.clientWidth - 60;
                    var zoom = Math.max(0.05, Math.min(1, availWidth / img.naturalWidth));
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
                inner.appendChild(drawlayer);
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

        // Manual white-mask boxes (user-drawn, borderless white in output)
        var scale = state.renderScale || (150 / 72);
        var mboxes = (state.manualBoxes || []).filter(function (b) { return b.page === pageNum; });
        mboxes.forEach(function (mb) {
            var mdiv = document.createElement('div');
            mdiv.className = 'manual-box';

            var mx0 = mb.bbox_pt[0] * scale, my0 = mb.bbox_pt[1] * scale;
            var mx1 = mb.bbox_pt[2] * scale, my1 = mb.bbox_pt[3] * scale;
            mdiv.style.left   = (mx0 * zoom) + 'px';
            mdiv.style.top    = (my0 * zoom) + 'px';
            mdiv.style.width  = ((mx1 - mx0) * zoom) + 'px';
            mdiv.style.height = ((my1 - my0) * zoom) + 'px';

            var del = document.createElement('button');
            del.className = 'manual-box-del';
            del.textContent = '×';
            del.title = 'Remove mask';
            del.addEventListener('click', function (e) {
                e.stopPropagation();
                removeManualBox(mb.id);
            });
            mdiv.appendChild(del);

            pe.overlay.appendChild(mdiv);
        });

        // Custom text boxes (black Helvetica text placed anywhere)
        var tboxes = (state.textBoxes || []).filter(function (t) { return t.page === pageNum; });
        tboxes.forEach(function (tb) {
            var tEl = document.createElement('div');
            tEl.className = 'text-box';
            tEl.dataset.tbId = tb.id;
            tEl.style.left = (tb.x_pt * scale * zoom) + 'px';
            tEl.style.top  = (tb.y_pt * scale * zoom) + 'px';

            var fontPx = Math.max(6, tb.fontsize * scale * zoom);

            var input = document.createElement('input');
            input.className = 'text-box-input';
            input.value = tb.text || '';
            input.placeholder = 'type text…';
            input.style.fontSize = fontPx + 'px';
            var sizeInput = function () {
                var len = input.value.length || input.placeholder.length;
                input.style.width = Math.max(40, (len + 1) * fontPx * 0.58) + 'px';
            };
            sizeInput();
            input.addEventListener('input', function () {
                tb.text = input.value;
                sizeInput();
                if (window.sync && window.sync.updateRedactCount) window.sync.updateRedactCount();
            });
            input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
            input.addEventListener('click', function (e) { e.stopPropagation(); });

            // Floating toolbar (grip / font− font+ / delete), shown on hover/focus
            var bar = document.createElement('div');
            bar.className = 'text-box-bar';
            var mkBtn = function (txt, title, fn) {
                var b = document.createElement('button');
                b.className = 'text-box-btn';
                b.textContent = txt; b.title = title;
                b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
                b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
                return b;
            };
            var grip = document.createElement('button');
            grip.className = 'text-box-btn text-box-grip';
            grip.textContent = '✥'; grip.title = 'Drag to move';
            attachTextDrag(grip, tb, pageNum);
            bar.appendChild(grip);
            bar.appendChild(mkBtn('A−', 'Smaller', function () { tb.fontsize = Math.max(6, tb.fontsize - 2); rebuildPage(pageNum); }));
            bar.appendChild(mkBtn('A+', 'Larger', function () { tb.fontsize = Math.min(96, tb.fontsize + 2); rebuildPage(pageNum); }));
            bar.appendChild(mkBtn('×', 'Delete', function () { removeTextBox(tb.id); }));

            tEl.appendChild(bar);
            tEl.appendChild(input);
            pe.overlay.appendChild(tEl);
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
            var zoom = Math.max(0.05, Math.min(1, availWidth / img.naturalWidth));
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
        setMode: setMode,
        addManualBox: addManualBox,
        removeManualBox: removeManualBox,
        addTextBox: addTextBox,
        removeTextBox: removeTextBox,
    };
})();
