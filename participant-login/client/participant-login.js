(function (global) {
    'use strict';

    const STUDY_LETTER = 'S';
    const STUDY_NUMBERS = '123456789';
    const BODY_ALPHABET = 'ACDEFHJKMNPRTWXY3479';
    const CODE_LENGTH = 5;
    const STORAGE_KEY = 'participantLogin.recentCodes';
    const DAY_MS = 24 * 60 * 60 * 1000;

    function normalizeCode(raw) {
        return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    function validateCode(code) {
        if (code.length !== CODE_LENGTH) return 'Codes have ' + CODE_LENGTH + ' characters.';
        if (code[0] !== STUDY_LETTER) return 'Codes start with the letter ' + STUDY_LETTER + '.';
        if (!STUDY_NUMBERS.includes(code[1])) return 'The second character is a number from 1 to 9.';
        for (const ch of code.slice(2)) {
            if (!BODY_ALPHABET.includes(ch)) return 'Codes never use the character ' + ch + '.';
        }
        return null;
    }

    function readSaved() {
        try {
            const list = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || '[]');
            if (!Array.isArray(list)) return [];
            return list.filter(item => item && typeof item.code === 'string' && !validateCode(item.code) && typeof item.at === 'number');
        } catch (e) {
            return [];
        }
    }

    function writeSaved(list) {
        try {
            global.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        } catch (e) {
            return;
        }
    }

    function timeAgo(at) {
        const days = Math.floor((Date.now() - at) / DAY_MS);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 7) return days + ' days ago';
        if (days < 30) {
            const weeks = Math.floor(days / 7);
            return weeks === 1 ? '1 week ago' : weeks + ' weeks ago';
        }
        if (days < 365) {
            const months = Math.floor(days / 30);
            return months === 1 ? '1 month ago' : months + ' months ago';
        }
        const years = Math.floor(days / 365);
        return years === 1 ? '1 year ago' : years + ' years ago';
    }

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function mount(container, options) {
        if (!container) throw new Error('ParticipantLogin.mount needs a container element.');
        const opts = Object.assign({
            apiBase: '/api/participant-login',
            title: 'Welcome',
            subtitle: 'Enter your participant code',
            confirmSubtitle: 'Your code',
            startLabel: 'Start',
            busyLabel: 'Checking…',
            savedLabel: 'Codes used on this device',
            forgetLabel: 'Forget saved codes',
            differentCodeLabel: 'Use a different code',
            placeholder: 'S14K7',
            urlParam: 'code',
            rememberCodes: true,
            maxSavedCodes: 5,
            onLogin: null
        }, options || {});

        let token = null;
        let currentCode = null;
        let busy = false;

        const root = make('div', 'pl-root');

        const entry = make('div', 'pl-view');
        const entryTitle = make('h1', 'pl-title', opts.title);
        const entrySubtitle = make('div', 'pl-subtitle', opts.subtitle);
        const input = make('input', 'pl-input');
        input.type = 'text';
        input.setAttribute('inputmode', 'text');
        input.setAttribute('autocapitalize', 'characters');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('aria-label', opts.subtitle);
        input.placeholder = opts.placeholder;
        const entryError = make('div', 'pl-error');
        entryError.setAttribute('role', 'alert');
        entryError.setAttribute('aria-live', 'polite');
        const entryStart = make('button', 'pl-primary', opts.startLabel);
        entryStart.type = 'button';

        const saved = make('div', 'pl-saved');
        const savedLabel = make('div', 'pl-saved-label', opts.savedLabel);
        const savedList = make('div', 'pl-saved-list');
        const forget = make('button', 'pl-link', opts.forgetLabel);
        forget.type = 'button';
        saved.append(savedLabel, savedList, forget);

        entry.append(entryTitle, entrySubtitle, input, entryError, entryStart, saved);

        const confirm = make('div', 'pl-view');
        confirm.hidden = true;
        const confirmTitle = make('h1', 'pl-title', opts.title);
        const confirmSubtitle = make('div', 'pl-subtitle', opts.confirmSubtitle);
        const confirmCode = make('div', 'pl-big-code');
        const confirmError = make('div', 'pl-error');
        confirmError.setAttribute('role', 'alert');
        confirmError.setAttribute('aria-live', 'polite');
        const confirmStart = make('button', 'pl-primary', opts.startLabel);
        confirmStart.type = 'button';
        const different = make('button', 'pl-link', opts.differentCodeLabel);
        different.type = 'button';
        confirm.append(confirmTitle, confirmSubtitle, confirmCode, confirmError, confirmStart, different);

        root.append(entry, confirm);
        container.appendChild(root);

        function renderSaved() {
            savedList.textContent = '';
            const list = opts.rememberCodes ? readSaved() : [];
            saved.hidden = list.length === 0;
            list.forEach(item => {
                const btn = make('button', 'pl-saved-btn');
                btn.type = 'button';
                btn.append(make('span', 'pl-saved-code', item.code), make('span', 'pl-saved-when', timeAgo(item.at)));
                btn.addEventListener('click', () => {
                    input.value = item.code;
                    submit(item.code, entryError, entryStart);
                });
                savedList.appendChild(btn);
            });
        }

        function rememberCode(code) {
            if (!opts.rememberCodes) return;
            const list = readSaved().filter(item => item.code !== code);
            list.unshift({ code, at: Date.now() });
            writeSaved(list.slice(0, opts.maxSavedCodes));
        }

        function setBusy(state, button) {
            busy = state;
            entryStart.disabled = state;
            confirmStart.disabled = state;
            button.textContent = state ? opts.busyLabel : opts.startLabel;
            if (!state) {
                entryStart.textContent = opts.startLabel;
                confirmStart.textContent = opts.startLabel;
            }
            savedList.querySelectorAll('button').forEach(b => { b.disabled = state; });
        }

        function showError(target, message) {
            target.textContent = message || '';
            if (target === entryError) input.classList.toggle('pl-invalid', !!message);
        }

        function showEntry() {
            confirm.hidden = true;
            entry.hidden = false;
            renderSaved();
        }

        function showConfirm(code) {
            confirmCode.textContent = code;
            showError(confirmError, '');
            entry.hidden = true;
            confirm.hidden = false;
        }

        async function submit(rawCode, errorTarget, button) {
            if (busy) return;
            const code = normalizeCode(rawCode);
            const formatError = validateCode(code);
            if (formatError) {
                showError(errorTarget, formatError);
                return;
            }
            showError(errorTarget, '');
            setBusy(true, button);
            try {
                const res = await fetch(opts.apiBase + '/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });
                let data = null;
                try { data = await res.json(); } catch (e) { data = null; }
                if (!res.ok || !data || !data.token) {
                    showError(errorTarget, (data && data.error) || 'Something went wrong. Please try again.');
                    setBusy(false, button);
                    return;
                }
                token = data.token;
                currentCode = data.code;
                rememberCode(data.code);
                setBusy(false, button);
                if (typeof opts.onLogin === 'function') {
                    opts.onLogin({ token: data.token, code: data.code, studyPrefix: data.studyPrefix, expiresAt: data.expiresAt });
                }
            } catch (e) {
                showError(errorTarget, 'Cannot reach the server. Check the internet connection and try again.');
                setBusy(false, button);
            }
        }

        input.addEventListener('input', () => {
            const clean = normalizeCode(input.value).slice(0, CODE_LENGTH);
            if (input.value !== clean) input.value = clean;
            showError(entryError, '');
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') submit(input.value, entryError, entryStart);
        });
        entryStart.addEventListener('click', () => submit(input.value, entryError, entryStart));
        confirmStart.addEventListener('click', () => submit(confirmCode.textContent, confirmError, confirmStart));
        different.addEventListener('click', () => {
            input.value = '';
            showError(entryError, '');
            showEntry();
        });
        forget.addEventListener('click', () => {
            writeSaved([]);
            renderSaved();
        });

        function reset() {
            input.value = '';
            showError(entryError, '');
            showError(confirmError, '');
            setBusy(false, entryStart);
            showEntry();
        }

        function logout() {
            const old = token;
            token = null;
            currentCode = null;
            reset();
            if (!old) return Promise.resolve();
            return fetch(opts.apiBase + '/logout', {
                method: 'POST',
                headers: { 'X-Participant-Token': old }
            }).then(() => undefined, () => undefined);
        }

        function clearToken() {
            token = null;
            currentCode = null;
        }

        function authFetch(url, init) {
            const request = Object.assign({}, init || {});
            request.headers = Object.assign({}, request.headers || {});
            if (token) request.headers['X-Participant-Token'] = token;
            return fetch(url, request);
        }

        const params = new URLSearchParams(global.location.search);
        const linked = normalizeCode(params.get(opts.urlParam));
        if (linked && !validateCode(linked)) {
            renderSaved();
            showConfirm(linked);
        } else {
            if (linked) {
                input.value = linked.slice(0, CODE_LENGTH);
                showError(entryError, validateCode(linked));
            }
            showEntry();
        }

        return {
            reset,
            logout,
            clearToken,
            authFetch,
            getToken: () => token,
            getCode: () => currentCode,
            focus: () => { if (!entry.hidden) input.focus(); }
        };
    }

    global.ParticipantLogin = { mount, normalizeCode, validateCode, BODY_ALPHABET };
})(window);
