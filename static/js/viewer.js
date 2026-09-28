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

    // ── Placement modes: 'mask' (white boxes), 'text' (add text),
    //    'select' (marquee — toggle-redact every block in a dragged area) ──
    let _activeMode = null;   // null | 'mask' | 'text' | 'select'
    let _mbCounter = 0;
    let _tbCounter = 0;

    function setMode(mode) {
        _activeMode = mode || null;
        document.body.classList.toggle('mask-mode', _activeMode === 'mask');
        document.body.classList.toggle('text-mode', _activeMode === 'text');
        document.body.classList.toggle('select-mode', _activeMode === 'select');
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
    // Also used for the Mechximize / Drawing ID labels: text boxes with a
    // `role` ('company' | 'drawing_id') whose text the app controls.
    //
    // Layout mirrors app.py (TEXT_LINE_HEIGHT / TEXT_BASELINE): same font
    // metrics, same line height, positioned by the top-left of the first line
    // and wrapped only where the user pressed Enter — so the text lands in the
    // PDF exactly where it sits in the editor.
    const TEXT_FONT = 'Arial, Helvetica, sans-serif';
    const TEXT_LINE_HEIGHT = 1.2;
    const LABEL_NAMES = { company: 'Company', drawing_id: 'Drawing ID' };
    let _measureCtx = null;

    function textWidth(text, fontPx) {
        if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
        _measureCtx.font = fontPx + 'px ' + TEXT_FONT;
        return _measureCtx.measureText(text).width;
    }

    // Displayed px per PDF point on a page.
    function pageScale(pageNum) {
        const pe = pageEls[pageNum];
        const zoom = pe ? (parseFloat(pe.wrapper.dataset.zoom) || 1) : 1;
        return (window.APP_STATE.renderScale || (150 / 72)) * zoom;
    }

    function textBoxEl(tb) {
        const pe = pageEls[tb.page];
        return pe ? pe.overlay.querySelector('[data-tb-id="' + tb.id + '"]') : null;
    }

    // Position and size a text box element from its state. Updates in place
    // (no rebuild), so an edit in progress keeps its focus and caret.
    function layoutTextBox(tEl, tb) {
        const s = pageScale(tb.page);
        const ta = tEl.querySelector('.text-box-input');
        const fontPx = tb.fontsize * s;
        tEl.style.left = (tb.x_pt * s) + 'px';
        tEl.style.top = (tb.y_pt * s) + 'px';
        ta.style.fontSize = fontPx + 'px';
        const lines = (ta.value || ta.placeholder).split('\n');
        let w = 0;
        lines.forEach(function (line) { w = Math.max(w, textWidth(line, fontPx)); });
        // Slack for the caret, so a line never scrolls sideways out of view.
        ta.style.width = Math.ceil(w + Math.max(4, fontPx * 0.4)) + 'px';
        ta.style.height = Math.ceil(lines.length * fontPx * TEXT_LINE_HEIGHT) + 'px';
    }

    function notifyTextChange() {
        if (window.sync && window.sync.updateRedactCount) window.sync.updateRedactCount();
    }

    // opts: { role, text, fontsize, focus }. New plain text boxes get focus
    // so the user can type immediately.
    function addTextBox(pageNum, x_pt, y_pt, opts) {
        opts = opts || {};
        const state = window.APP_STATE;
        if (!state.textBoxes) state.textBoxes = [];
        const tb = {
            id: 'tb_' + pageNum + '_' + (_tbCounter++), page: pageNum,
            x_pt: x_pt, y_pt: y_pt, text: opts.text || '', fontsize: opts.fontsize || 14,
        };
        if (opts.role) tb.role = opts.role;
        state.textBoxes.push(tb);
        const pe = pageEls[pageNum];
        if (pe && pe.loaded) {   // unloaded pages build their boxes on load
            const tEl = buildTextBox(tb);
            pe.overlay.appendChild(tEl);
            if (opts.focus !== false) tEl.querySelector('.text-box-input').focus();
        }
        notifyTextChange();
        return tb;
    }

    function removeTextBox(id) {
        const state = window.APP_STATE;
        if (!state.textBoxes) return;
        const idx = state.textBoxes.findIndex(function (t) { return t.id === id; });
        if (idx < 0) return;
        const tEl = textBoxEl(state.textBoxes[idx]);
        state.textBoxes.splice(idx, 1);
        if (tEl) tEl.remove();
        notifyTextChange();
    }

    // Re-sync an existing text box element after its state changed.
    function updateTextBox(tb) {
        const tEl = textBoxEl(tb);
        if (!tEl) return;
        const ta = tEl.querySelector('.text-box-input');
        if (ta.value !== (tb.text || '')) ta.value = tb.text || '';
        layoutTextBox(tEl, tb);
    }

    // Move a text box, possibly to another page.
    function placeTextBox(tb, pageNum, x_pt, y_pt, fontsize) {
        const oldEl = textBoxEl(tb);
        const pageChanged = tb.page !== pageNum;
        tb.page = pageNum;
        tb.x_pt = x_pt;
        tb.y_pt = y_pt;
        if (fontsize) tb.fontsize = fontsize;
        if (!pageChanged) {
            if (oldEl) layoutTextBox(oldEl, tb);
            return;
        }
        if (oldEl) oldEl.remove();
        const pe = pageEls[pageNum];
        if (pe && pe.loaded) pe.overlay.appendChild(buildTextBox(tb));
    }

    // Drag a text box with any pointer (mouse, touch, pen); updates x_pt/y_pt
    // in PDF points, clamped to the page. A press that doesn't move calls
    // onTap instead.
    function attachTextDrag(handle, tb, onTap) {
        // Keep focus where it is (don't steal it from the text being edited).
        handle.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
        handle.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const s = pageScale(tb.page);
            const dims = (window.APP_STATE.pageDims || {})[String(tb.page)];
            const startX = e.clientX, startY = e.clientY;
            const origX = tb.x_pt, origY = tb.y_pt;
            const tEl = handle.closest('.text-box');
            let moved = false;
            try { handle.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ }
            tEl.classList.add('text-box-dragging');
            function move(ev) {
                const dx = ev.clientX - startX, dy = ev.clientY - startY;
                if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;  // jitter, not a drag
                moved = true;
                let x = origX + dx / s, y = origY + dy / s;
                if (dims) {
                    x = Math.min(x, dims.width_pt - 4);
                    y = Math.min(y, dims.height_pt - 4);
                }
                tb.x_pt = Math.max(0, x);
                tb.y_pt = Math.max(0, y);
                tEl.style.left = (tb.x_pt * s) + 'px';
                tEl.style.top = (tb.y_pt * s) + 'px';
            }
            function up() {
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                handle.removeEventListener('pointercancel', up);
                tEl.classList.remove('text-box-dragging');
                if (moved) tb.moved = true;   // user-placed: auto-placement leaves it alone
                else if (onTap) onTap();
            }
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
            handle.addEventListener('pointercancel', up);
        });
    }

    function buildTextBox(tb) {
        const tEl = document.createElement('div');
        tEl.className = 'text-box' + (tb.role ? ' text-box-label' : '');
        tEl.dataset.tbId = tb.id;

        // A textarea, not an <input>: Enter / Shift+Enter start a new line and
        // every normal editing key (Shift+arrows, Ctrl+A/C/V/Z, Home/End…) works.
        const ta = document.createElement('textarea');
        ta.className = 'text-box-input';
        ta.rows = 1;
        ta.setAttribute('wrap', 'off');   // lines break only where Enter was pressed, as in the PDF
        ta.spellcheck = false;
        ta.value = tb.text || '';
        ta.placeholder = 'type text…';
        ta.addEventListener('input', function () {
            tb.text = ta.value;
            layoutTextBox(tEl, tb);
            notifyTextChange();
        });
        ta.addEventListener('keydown', function (e) {
            e.stopPropagation();          // keys belong to the text, not page navigation
            if (e.key === 'Escape') ta.blur();
        });
        ta.addEventListener('focus', function () { tEl.classList.add('text-box-active'); });
        ta.addEventListener('blur', function () { tEl.classList.remove('text-box-active'); });
        ta.addEventListener('click', function (e) { e.stopPropagation(); });
        if (tb.role) {
            // Labels show app-controlled text: drag them anywhere by the body;
            // a tap selects them (shows the toolbar).
            ta.readOnly = true;
            ta.title = LABEL_NAMES[tb.role] + ' — drag to position';
            attachTextDrag(ta, tb, function () { ta.focus(); });
        } else {
            ta.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        }

        // Floating toolbar (grip / font− font+ / delete), shown on hover or
        // while the box is selected.
        const bar = document.createElement('div');
        bar.className = 'text-box-bar';
        const mkBtn = function (txt, title, fn) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'text-box-btn';
            b.textContent = txt;
            b.title = title;
            // mousedown default would move focus off the text being edited.
            b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
            b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
            return b;
        };
        const grip = mkBtn('✥', 'Drag to move', function () {});
        grip.classList.add('text-box-grip');
        attachTextDrag(grip, tb, function () { ta.focus(); });
        bar.appendChild(grip);
        if (tb.role) {
            const tag = document.createElement('span');
            tag.className = 'text-box-tag';
            tag.textContent = LABEL_NAMES[tb.role];
            bar.appendChild(tag);
        }
        bar.appendChild(mkBtn('A−', 'Smaller', function () {
            tb.fontsize = Math.max(4, tb.fontsize - (tb.fontsize > 8 ? 2 : 1));
            layoutTextBox(tEl, tb);
        }));
        bar.appendChild(mkBtn('A+', 'Larger', function () {
            tb.fontsize = Math.min(96, tb.fontsize + (tb.fontsize >= 8 ? 2 : 1));
            layoutTextBox(tEl, tb);
        }));
        bar.appendChild(mkBtn('×', tb.role ? 'Remove label (Auto-place brings it back)' : 'Delete',
            function () { removeTextBox(tb.id); }));

        tEl.appendChild(bar);
        tEl.appendChild(ta);
        layoutTextBox(tEl, tb);
        return tEl;
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
            if ((_activeMode !== 'mask' && _activeMode !== 'select') || e.button !== 0) return;
            e.preventDefault();
            const xy = localXY(e);
            startX = xy[0]; startY = xy[1];
            drawing = true;
            band = document.createElement('div');
            band.className = _activeMode === 'select' ? 'draw-band select-band' : 'draw-band';
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
            if (_activeMode === 'select') {
                if (window.sync && window.sync.redactArea) window.sync.redactArea(pageNum, bbox_pt);
            } else {
                addManualBox(pageNum, bbox_pt);
            }
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
     *
     * Pages load LAZILY (as they approach the viewport) with automatic
     * retries. Firing every page render at once used to crush the server on
     * multi-page documents — pages 7+ came back broken.
     */
    function loadPage(pn) {
        const pe = pageEls[pn];
        if (!pe || pe.loaded || pe.loading) return;
        pe.loading = true;
        const bust = pe.attempts > 0 ? ('?r=' + pe.attempts) : '';
        pe.img.src = '/api/page-image/' + window.APP_STATE.fileId + '/' + pn + bust;
    }

    /**
     * Load every page whose wrapper is within `margin` px of the viewport.
     * Scroll-position based (NOT IntersectionObserver — IO is throttled to
     * uselessness in background tabs and embedded webviews, which left far
     * pages permanently unloaded).
     */
    function _checkVisiblePages() {
        const rootRect = scrollEl.getBoundingClientRect();
        const margin = 800;
        Object.keys(pageEls).forEach(function (pn) {
            const pe = pageEls[pn];
            if (pe.loaded || pe.loading) return;
            const r = pe.wrapper.getBoundingClientRect();
            if (r.bottom > rootRect.top - margin && r.top < rootRect.bottom + margin) {
                loadPage(parseInt(pn));
            }
        });
    }

    let _lazyTimer = null;
    let _lazyInterval = null;
    function _scheduleLazyCheck() {
        if (_lazyTimer) return;
        _lazyTimer = setTimeout(function () {
            _lazyTimer = null;
            _checkVisiblePages();
        }, 150);
    }

    function _removeRetryNotice(pe) {
        const n = pe.inner.querySelector('.page-retry');
        if (n) n.parentNode.removeChild(n);
    }

    function _showRetryNotice(pe, pn) {
        _removeRetryNotice(pe);
        const box = document.createElement('div');
        box.className = 'page-retry';
        const msg = document.createElement('span');
        msg.textContent = 'Page ' + (pn + 1) + ' failed to load.';
        const btn = document.createElement('button');
        btn.className = 'hdr-btn';
        btn.textContent = 'Retry';
        btn.addEventListener('click', function () {
            pe.attempts = 0;
            _removeRetryNotice(pe);
            loadPage(pn);
        });
        box.appendChild(msg);
        box.appendChild(btn);
        pe.inner.appendChild(box);
    }

    function _setupLazyLoading() {
        const state = window.APP_STATE;
        loadPage(0);  // first page always loads immediately

        if (state.totalPages <= 3 || scrollEl.clientHeight <= 50) {
            // Small docs (or environments without a real viewport): eager load.
            for (let pn = 1; pn < state.totalPages; pn++) loadPage(pn);
            return;
        }
        scrollEl.addEventListener('scroll', _scheduleLazyCheck);
        window.addEventListener('resize', _scheduleLazyCheck);
        _checkVisiblePages();

        // Safety net: scroll events can be throttled/suppressed (background
        // tabs, embedded webviews). Poll proximity until every page has
        // loaded, then stop — guarantees progress without event delivery.
        if (_lazyInterval) clearInterval(_lazyInterval);
        _lazyInterval = setInterval(function () {
            const pending = Object.values(pageEls).some(function (pe) {
                return !pe.loaded && pe.attempts <= 3;
            });
            if (!pending) {
                clearInterval(_lazyInterval);
                _lazyInterval = null;
                return;
            }
            _checkVisiblePages();
        }, 900);
    }

    function renderAllPages() {
        const state = window.APP_STATE;
        container.innerHTML = '';
        pageEls = {};

        showLoading();

        const totalPages = state.totalPages;
        const availWidth = Math.max(scrollEl.clientWidth - 60, 100);

        for (let pageNum = 0; pageNum < totalPages; pageNum++) {
            (function (pn) {
                // Outer wrapper (for label + page)
                const wrapper = document.createElement('div');
                wrapper.className = 'page-wrapper';
                wrapper.dataset.page = pn;

                // Page label row (page number + bulk redact-page button)
                const label = document.createElement('div');
                label.className = 'page-label';
                const labelText = document.createElement('span');
                labelText.textContent = 'Page ' + (pn + 1) + ' / ' + totalPages;
                label.appendChild(labelText);
                const pageBtn = document.createElement('button');
                pageBtn.className = 'page-redact-btn';
                pageBtn.textContent = 'Redact page';
                pageBtn.title = 'Toggle redaction for every detected block on this page';
                pageBtn.addEventListener('click', function () {
                    if (window.sync && window.sync.redactPage) window.sync.redactPage(pn);
                });
                label.appendChild(pageBtn);

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

                // Draw layer (captures drag interactions when a mode is active)
                const drawlayer = document.createElement('div');
                drawlayer.className = 'page-drawlayer';
                attachDrawHandlers(pn, drawlayer);

                pageEls[pn] = {
                    wrapper: wrapper, inner: inner, img: img, overlay: overlay,
                    drawlayer: drawlayer, bboxEls: {},
                    loaded: false, loading: false, attempts: 0,
                };

                // Reserve space from the known page dimensions so lazy pages
                // keep their height and the scrollbar stays truthful.
                const dims = (state.pageDims || {})[String(pn)];
                if (dims) {
                    const estZoom = Math.max(0.05, Math.min(1, availWidth / (dims.width_pt * state.renderScale)));
                    inner.style.minHeight = Math.round(dims.height_pt * state.renderScale * estZoom) + 'px';
                    inner.style.minWidth = Math.round(dims.width_pt * state.renderScale * estZoom) + 'px';
                }

                img.onload = function () {
                    const pe = pageEls[pn];
                    pe.loaded = true;
                    pe.loading = false;
                    pe.attempts = 0;
                    inner.style.minHeight = '';
                    inner.style.minWidth = '';
                    _removeRetryNotice(pe);

                    // Fit to available width
                    var availW = Math.max(scrollEl.clientWidth - 60, 100);
                    var zoom = Math.max(0.05, Math.min(1, availW / img.naturalWidth));
                    wrapper.dataset.zoom = zoom;
                    img.style.width = (img.naturalWidth * zoom) + 'px';
                    img.style.height = (img.naturalHeight * zoom) + 'px';

                    buildPageOverlay(pn, zoom);

                    // The editor is usable as soon as the first page is in.
                    hideLoading();
                    // Loading a page changes layout heights — re-check which
                    // neighbors are now in range (chain-loads when parked).
                    _scheduleLazyCheck();
                };
                img.onerror = function () {
                    const pe = pageEls[pn];
                    if (!pe.loading) return;   // spurious (e.g. empty src)
                    pe.loading = false;
                    pe.attempts++;
                    if (pe.attempts <= 3) {
                        // Back off and retry — transient server pressure heals.
                        setTimeout(function () { loadPage(pn); }, 700 * Math.pow(2, pe.attempts - 1));
                    } else {
                        hideLoading();
                        _showRetryNotice(pe, pn);
                    }
                };

                inner.appendChild(img);
                inner.appendChild(overlay);
                inner.appendChild(drawlayer);
                wrapper.appendChild(label);
                wrapper.appendChild(inner);
                container.appendChild(wrapper);
            })(pageNum);
        }

        _setupLazyLoading();
    }

    /**
     * Build bounding box overlay for a specific page.
     */
    function buildPageOverlay(pageNum, zoom) {
        const state = window.APP_STATE;
        const pe = pageEls[pageNum];
        if (!pe) return;

        // A rebuild replaces the text box elements. Carry an edit in progress
        // (focus + caret) across it — otherwise any refresh, or a touch
        // keyboard resizing the viewport, throws the user out mid-typing.
        const active = document.activeElement;
        let editing = null;
        if (active && active.classList.contains('text-box-input') && pe.overlay.contains(active)) {
            editing = { id: active.parentNode.dataset.tbId, start: active.selectionStart, end: active.selectionEnd };
        }

        pe.overlay.innerHTML = '';
        pe.bboxEls = {};

        // Lazy pages have no image yet — their zoom is unknown, so boxes
        // would land at the wrong scale. Overlays build on img.onload.
        if (!pe.loaded) return;

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

        // Custom text boxes + labels (black Helvetica text placed anywhere)
        (state.textBoxes || []).forEach(function (tb) {
            if (tb.page === pageNum) pe.overlay.appendChild(buildTextBox(tb));
        });

        if (editing) {
            var ta = pe.overlay.querySelector('[data-tb-id="' + editing.id + '"] .text-box-input');
            if (ta) {
                ta.focus({ preventScroll: true });
                try { ta.setSelectionRange(editing.start, editing.end); } catch (_) { /* readonly */ }
            }
        }
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
            // Height-only viewport changes (e.g. a touch keyboard opening while
            // a text box is edited) leave the fit unchanged — don't rebuild.
            if (Math.abs(zoom - parseFloat(pe.wrapper.dataset.zoom)) < 1e-4) return;
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
            loadPage(pageNum);   // jumping can outrun the lazy observer
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
        updateTextBox: updateTextBox,
        placeTextBox: placeTextBox,
    };
})();
