(function (global) {
    'use strict';

    const STUDY_NUMBERS = '123456789';

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function formatDate(value) {
        if (!value) return '—';
        const d = new Date(value);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function csvCell(value) {
        const s = value == null ? '' : String(value);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    async function copyText(text) {
        if (global.navigator.clipboard && global.isSecureContext) {
            await global.navigator.clipboard.writeText(text);
            return;
        }
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
    }

    function mount(container, options) {
        if (!container) throw new Error('ParticipantLoginAdmin.mount needs a container element.');
        const opts = Object.assign({
            apiBase: '/api/admin/participant-login',
            headers: null,
            onUnauthorized: null,
            participantUrl: global.location.origin + '/',
            urlParam: 'code',
            extraColumns: [],
            loadExtra: null,
            renderDetail: null,
            maxBulk: 200
        }, options || {});

        const state = {
            studies: [],
            selected: null,
            participants: [],
            extra: {},
            expanded: null,
            fresh: new Set(),
            busy: false
        };

        container.innerHTML = `
            <div class="pla-root">
                <div class="pla-section">
                    <div class="pla-label">New study</div>
                    <div class="pla-row">
                        <div class="pla-field pla-grow">
                            <label for="pla-study-name">Study name</label>
                            <input id="pla-study-name" class="pla-input" type="text" maxlength="120" placeholder="HALT Pilot VR Study" autocomplete="off">
                        </div>
                        <div class="pla-field pla-number-field">
                            <label for="pla-study-number">Study number</label>
                            <div class="pla-prefix">
                                <span class="pla-prefix-fixed">S</span>
                                <input id="pla-study-number" class="pla-input pla-prefix-input" type="text" inputmode="numeric" maxlength="1" placeholder="1" autocomplete="off">
                            </div>
                        </div>
                        <button type="button" class="pla-btn" data-action="create-study">Create study</button>
                    </div>
                    <div class="pla-msg" data-role="study-msg"></div>
                </div>
                <div class="pla-section">
                    <div class="pla-label">Studies</div>
                    <div data-role="study-list"><div class="pla-empty">Loading…</div></div>
                </div>
                <div class="pla-section" data-role="detail" hidden>
                    <div class="pla-label" data-role="detail-label">Participants</div>
                    <div class="pla-row pla-gen-row">
                        <button type="button" class="pla-btn" data-action="generate-one">Generate 1 code</button>
                        <div class="pla-field pla-count-field">
                            <label for="pla-bulk-count">How many</label>
                            <input id="pla-bulk-count" class="pla-input" type="number" min="1" max="${opts.maxBulk}" value="20">
                        </div>
                        <button type="button" class="pla-btn pla-ghost" data-action="generate-bulk">Generate codes</button>
                        <button type="button" class="pla-btn pla-ghost pla-push" data-action="export">Export CSV</button>
                    </div>
                    <div class="pla-msg" data-role="gen-msg"></div>
                    <div class="pla-table-wrap">
                        <table class="pla-table">
                            <thead data-role="thead"></thead>
                            <tbody data-role="tbody"></tbody>
                        </table>
                    </div>
                    <div class="pla-empty" data-role="no-codes" hidden>No codes yet. Generate the first one above.</div>
                </div>
            </div>
        `;

        const root = container.querySelector('.pla-root');
        const q = sel => root.querySelector(sel);
        const nameInput = q('#pla-study-name');
        const numberInput = q('#pla-study-number');
        const countInput = q('#pla-bulk-count');
        const studyMsg = q('[data-role="study-msg"]');
        const genMsg = q('[data-role="gen-msg"]');

        function setMsg(node, text, kind) {
            node.textContent = text || '';
            node.className = 'pla-msg' + (kind ? ' pla-' + kind : '');
        }

        async function request(method, path, body) {
            const base = { 'Content-Type': 'application/json' };
            const extra = typeof opts.headers === 'function' ? opts.headers() : (opts.headers || {});
            const res = await fetch(opts.apiBase + path, {
                method,
                headers: Object.assign(base, extra),
                body: body ? JSON.stringify(body) : undefined
            });
            let data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            if (res.status === 401) {
                if (typeof opts.onUnauthorized === 'function') opts.onUnauthorized();
                throw new Error('Session expired. Please log in again.');
            }
            if (!res.ok) {
                const err = new Error((data && data.error) || 'Request failed.');
                err.data = data;
                throw err;
            }
            return data;
        }

        function participantLink(code) {
            const sep = opts.participantUrl.includes('?') ? '&' : '?';
            return opts.participantUrl + sep + encodeURIComponent(opts.urlParam) + '=' + encodeURIComponent(code);
        }

        function selectedStudy() {
            return state.studies.find(s => s.prefix === state.selected) || null;
        }

        function renderStudies() {
            const list = q('[data-role="study-list"]');
            if (!state.studies.length) {
                list.innerHTML = '<div class="pla-empty">No studies yet. Create the first one above.</div>';
                return;
            }
            list.innerHTML = '<div class="pla-study-list">' + state.studies.map(s => `
                <button type="button" class="pla-study${s.prefix === state.selected ? ' pla-selected' : ''}" data-action="select-study" data-prefix="${esc(s.prefix)}">
                    <span class="pla-badge">${esc(s.prefix)}</span>
                    <span class="pla-study-name">${esc(s.name)}</span>
                    <span class="pla-study-meta">${s.participant_count} ${s.participant_count === 1 ? 'code' : 'codes'} · created ${esc(formatDate(s.created_at))}</span>
                </button>
            `).join('') + '</div>';
        }

        function hasDetail() {
            return typeof opts.renderDetail === 'function';
        }

        function columnCount() {
            return 4 + opts.extraColumns.length + (hasDetail() ? 1 : 0);
        }

        function renderTable() {
            const study = selectedStudy();
            const detail = q('[data-role="detail"]');
            if (!study) {
                detail.hidden = true;
                return;
            }
            detail.hidden = false;
            q('[data-role="detail-label"]').textContent = study.name + ' · ' + study.prefix;

            const heads = ['Code', 'PID'].concat(opts.extraColumns.map(c => c.header), ['Link', '']);
            if (hasDetail()) heads.push('');
            q('[data-role="thead"]').innerHTML = '<tr>' + heads.map(h => `<th>${esc(h)}</th>`).join('') + '</tr>';

            const tbody = q('[data-role="tbody"]');
            q('[data-role="no-codes"]').hidden = state.participants.length > 0;
            tbody.innerHTML = state.participants.map(p => {
                const extra = state.extra[p.pid];
                const link = participantLink(p.code);
                const cells = [
                    `<td class="pla-code">${esc(p.code)}</td>`,
                    `<td>${esc(p.pid)}</td>`
                ];
                opts.extraColumns.forEach(col => {
                    cells.push(`<td>${col.render(p, extra)}</td>`);
                });
                cells.push(`<td class="pla-link-cell">${esc(link)}</td>`);
                cells.push(`<td><button type="button" class="pla-mini" data-action="copy" data-link="${esc(link)}">Copy link</button></td>`);
                let detailHtml = '';
                if (hasDetail()) {
                    detailHtml = opts.renderDetail(p, extra) || '';
                    const open = state.expanded === p.pid;
                    cells.push(detailHtml
                        ? `<td><button type="button" class="pla-mini pla-quiet" data-action="toggle" data-pid="${esc(p.pid)}">${open ? 'Hide' : 'Details'}</button></td>`
                        : '<td></td>');
                }
                let html = `<tr class="${state.fresh.has(p.code) ? 'pla-fresh' : ''}">${cells.join('')}</tr>`;
                if (detailHtml && state.expanded === p.pid) {
                    html += `<tr class="pla-detail-row"><td colspan="${columnCount()}">${detailHtml}</td></tr>`;
                }
                return html;
            }).join('');
        }

        async function loadStudies() {
            try {
                state.studies = await request('GET', '/studies');
                if (state.selected && !selectedStudy()) state.selected = null;
                if (!state.selected && state.studies.length) {
                    const newest = state.studies.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a));
                    state.selected = newest.prefix;
                }
                renderStudies();
                await loadParticipants();
            } catch (e) {
                q('[data-role="study-list"]').innerHTML = `<div class="pla-empty">${esc(e.message)}</div>`;
            }
        }

        async function loadParticipants() {
            const study = selectedStudy();
            if (!study) {
                state.participants = [];
                state.extra = {};
                renderTable();
                return;
            }
            try {
                const [participants, extra] = await Promise.all([
                    request('GET', '/studies/' + encodeURIComponent(study.prefix) + '/participants'),
                    typeof opts.loadExtra === 'function' ? opts.loadExtra(study) : Promise.resolve({})
                ]);
                if (state.selected !== study.prefix) return;
                state.participants = participants;
                state.extra = extra || {};
                renderTable();
            } catch (e) {
                setMsg(genMsg, e.message, 'err');
            }
        }

        async function createStudy() {
            const name = nameInput.value.trim();
            const number = numberInput.value.trim();
            nameInput.classList.remove('pla-bad');
            numberInput.classList.remove('pla-bad');
            if (!name) {
                nameInput.classList.add('pla-bad');
                setMsg(studyMsg, 'Enter a study name.', 'err');
                nameInput.focus();
                return;
            }
            if (number.length !== 1 || !STUDY_NUMBERS.includes(number)) {
                numberInput.classList.add('pla-bad');
                setMsg(studyMsg, 'Pick a study number from 1 to 9.', 'err');
                numberInput.focus();
                return;
            }
            const taken = state.studies.find(s => s.prefix === 'S' + number);
            if (taken) {
                numberInput.classList.add('pla-bad');
                setMsg(studyMsg, 'S' + number + ' already belongs to "' + taken.name + '". Pick a number no study has used.', 'err');
                numberInput.select();
                return;
            }
            if (state.busy) return;
            state.busy = true;
            try {
                const study = await request('POST', '/studies', { name, number });
                nameInput.value = '';
                numberInput.value = '';
                state.selected = study.prefix;
                state.expanded = null;
                state.fresh = new Set();
                setMsg(studyMsg, 'Study "' + study.name + '" created with prefix ' + study.prefix + '.', 'ok');
                setMsg(genMsg, '');
                await loadStudies();
            } catch (e) {
                numberInput.classList.add('pla-bad');
                setMsg(studyMsg, e.message, 'err');
                await loadStudies();
            } finally {
                state.busy = false;
            }
        }

        async function generate(count) {
            const study = selectedStudy();
            if (!study || state.busy) return;
            if (!Number.isInteger(count) || count < 1 || count > opts.maxBulk) {
                setMsg(genMsg, 'Enter a number between 1 and ' + opts.maxBulk + '.', 'err');
                return;
            }
            state.busy = true;
            setMsg(genMsg, count === 1 ? 'Creating code…' : 'Creating ' + count + ' codes…');
            try {
                const result = await request('POST', '/studies/' + encodeURIComponent(study.prefix) + '/codes', { count });
                state.fresh = new Set(result.created.map(c => c.code));
                setMsg(genMsg, count === 1 ? 'Created ' + result.created[0].code + '.' : 'Created ' + result.created.length + ' codes.', 'ok');
            } catch (e) {
                const created = e.data && Array.isArray(e.data.created) ? e.data.created : [];
                state.fresh = new Set(created.map(c => c.code));
                setMsg(genMsg, e.message, 'err');
            } finally {
                state.busy = false;
            }
            await loadStudies();
            setTimeout(() => { state.fresh = new Set(); }, 1500);
        }

        function exportCsv() {
            const study = selectedStudy();
            if (!study) return;
            const rows = [['code', 'pid', 'study_prefix', 'study_name', 'link', 'created_at']];
            state.participants.slice().reverse().forEach(p => {
                rows.push([p.code, p.pid, study.prefix, study.name, participantLink(p.code), p.created_at ? new Date(p.created_at).toISOString() : '']);
            });
            const csv = rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'participant-codes-' + study.prefix + '.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        numberInput.addEventListener('input', () => {
            numberInput.value = numberInput.value.replace(/[^1-9]/g, '').slice(0, 1);
            numberInput.classList.remove('pla-bad');
            const taken = numberInput.value ? state.studies.find(s => s.prefix === 'S' + numberInput.value) : null;
            if (taken) {
                numberInput.classList.add('pla-bad');
                setMsg(studyMsg, 'S' + numberInput.value + ' is taken by "' + taken.name + '". Try another number.', 'err');
            } else if (studyMsg.classList.contains('pla-err')) {
                setMsg(studyMsg, '');
            }
        });

        nameInput.addEventListener('input', () => nameInput.classList.remove('pla-bad'));

        root.addEventListener('click', async e => {
            const target = e.target.closest('[data-action]');
            if (!target || !root.contains(target)) return;
            const action = target.dataset.action;
            if (action === 'create-study') {
                createStudy();
            } else if (action === 'select-study') {
                if (state.selected === target.dataset.prefix) return;
                state.selected = target.dataset.prefix;
                state.expanded = null;
                state.fresh = new Set();
                setMsg(genMsg, '');
                renderStudies();
                state.participants = [];
                state.extra = {};
                renderTable();
                await loadParticipants();
            } else if (action === 'generate-one') {
                generate(1);
            } else if (action === 'generate-bulk') {
                generate(Number(countInput.value));
            } else if (action === 'export') {
                exportCsv();
            } else if (action === 'copy') {
                const original = target.textContent;
                try {
                    await copyText(target.dataset.link);
                    target.textContent = 'Copied';
                } catch (err) {
                    target.textContent = 'Copy failed';
                }
                setTimeout(() => { target.textContent = original; }, 1200);
            } else if (action === 'toggle') {
                const pid = Number(target.dataset.pid);
                state.expanded = state.expanded === pid ? null : pid;
                renderTable();
            }
        });

        loadStudies();

        return { refresh: loadStudies };
    }

    global.ParticipantLoginAdmin = { mount };
})(window);
