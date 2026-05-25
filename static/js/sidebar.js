/**
 * sidebar.js - Side panel block list management
 */
window.sidebar = (function () {
    const list = document.getElementById('block-list');
    const filterInput = document.getElementById('filterInput');
    const statsEl = document.getElementById('sidebar-stats');

    let itemEls = {};  // blockId -> <li> element

    /**
     * Render the list for the given blocks.
     */
    function renderList(blocks) {
        list.innerHTML = '';
        itemEls = {};
        const state = window.APP_STATE;

        blocks.forEach(block => {
            const li = document.createElement('li');
            li.className = 'block-item';
            li.dataset.blockId = block.id;

            if (state.redactSet.has(block.id)) {
                li.classList.add('block-item-redact');
            }

            // AI remove highlight (if not already manually redacted)
            var aiDecision = state.aiDecisions ? state.aiDecisions[block.id] : null;
            if (aiDecision && aiDecision.action === 'remove' && !state.redactSet.has(block.id)) {
                li.classList.add('block-item-ai-remove');
            }

            // Text
            const textDiv = document.createElement('div');
            textDiv.className = 'block-text';
            textDiv.textContent = block.text;
            textDiv.title = block.text;
            li.appendChild(textDiv);

            // Meta row: coords + PII badges + AI badge
            const metaDiv = document.createElement('div');
            metaDiv.className = 'block-meta';

            const coordSpan = document.createElement('span');
            coordSpan.className = 'block-coords';
            const [x0, y0, x1, y1] = block.bbox_pt;
            coordSpan.textContent = '(' + Math.round(x0) + ',' + Math.round(y0) +
                ') \u2013 (' + Math.round(x1) + ',' + Math.round(y1) + ')';
            metaDiv.appendChild(coordSpan);

            // PII badges
            if (block.pii_flags) {
                block.pii_flags.forEach(flag => {
                    const badge = document.createElement('span');
                    badge.className = 'badge-pii ' + flag;
                    badge.textContent = flag;
                    metaDiv.appendChild(badge);
                });
            }

            // AI badge
            if (aiDecision) {
                const aiBadge = document.createElement('span');
                aiBadge.className = 'badge-ai ' + aiDecision.action;
                aiBadge.textContent = 'AI: ' + aiDecision.action;
                aiBadge.title = aiDecision.reason || '';
                metaDiv.appendChild(aiBadge);
            }

            li.appendChild(metaDiv);

            // AI reason tooltip (shown on hover)
            if (aiDecision && aiDecision.reason) {
                const reasonDiv = document.createElement('div');
                reasonDiv.className = 'ai-reason-tooltip';
                reasonDiv.textContent = aiDecision.reason;
                li.appendChild(reasonDiv);
            }

            // Redact button
            const redactBtn = document.createElement('button');
            redactBtn.className = 'btn-redact';
            redactBtn.textContent = state.redactSet.has(block.id) ? 'Undo' : 'Redact';
            if (state.redactSet.has(block.id)) redactBtn.classList.add('active');

            redactBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                window.sync.toggleRedact(block.id);
            });
            li.appendChild(redactBtn);

            // Click to select
            li.addEventListener('click', function () {
                window.sync.selectBlock(block.id);
            });

            list.appendChild(li);
            itemEls[block.id] = li;
        });

        updateStats(blocks);
    }

    function updateStats(blocks) {
        const state = window.APP_STATE;
        const pageCount = blocks.length;
        const piiCount = blocks.filter(b => b.pii_flags && b.pii_flags.length > 0).length;
        var aiRemoveCount = 0;
        if (state.aiDecisions) {
            blocks.forEach(b => {
                var d = state.aiDecisions[b.id];
                if (d && d.action === 'remove') aiRemoveCount++;
            });
        }
        var parts = [pageCount + ' blocks'];
        if (piiCount > 0) parts.push(piiCount + ' PII');
        if (aiRemoveCount > 0) parts.push(aiRemoveCount + ' AI flagged');
        statsEl.textContent = parts.join(' \u00b7 ');
    }

    function highlightItem(blockId) {
        Object.values(itemEls).forEach(el => el.classList.remove('block-item-selected'));
        const el = itemEls[blockId];
        if (el) {
            el.classList.add('block-item-selected');
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function setRedactState(blockId, isRedacted) {
        const el = itemEls[blockId];
        if (!el) return;

        el.classList.toggle('block-item-redact', isRedacted);
        if (isRedacted) {
            el.classList.remove('block-item-ai-remove');
        }
        const btn = el.querySelector('.btn-redact');
        if (btn) {
            btn.textContent = isRedacted ? 'Undo' : 'Redact';
            btn.classList.toggle('active', isRedacted);
        }
    }

    function clearSelection() {
        Object.values(itemEls).forEach(el => el.classList.remove('block-item-selected'));
    }

    // Filter input handler
    filterInput.addEventListener('input', function () {
        const query = filterInput.value.toLowerCase();
        Object.entries(itemEls).forEach(([id, el]) => {
            const text = el.querySelector('.block-text').textContent.toLowerCase();
            el.style.display = text.includes(query) ? '' : 'none';
        });
    });

    return { renderList, highlightItem, setRedactState, clearSelection };
})();
