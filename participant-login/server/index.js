const crypto = require('crypto');

const STUDY_LETTER = 'S';
const STUDY_NUMBERS = '123456789';
const BODY_ALPHABET = 'ACDEFHJKMNPRTWXY3479';
const BODY_LENGTH = 3;
const CODE_LENGTH = 2 + BODY_LENGTH;
const STUDY_CAPACITY = Math.pow(BODY_ALPHABET.length, BODY_LENGTH);
const PREFIX_PATTERN = /^S[1-9]$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

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

function randomBody() {
    let body = '';
    for (let i = 0; i < BODY_LENGTH; i++) {
        body += BODY_ALPHABET[crypto.randomInt(BODY_ALPHABET.length)];
    }
    return body;
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function createParticipantLogin(options) {
    const opts = options || {};
    const pool = opts.pool;
    const express = opts.express;
    if (!pool) throw new Error('participant-login requires a pg pool.');
    if (!express) throw new Error('participant-login requires express.');

    const tokenTtlHours = Number.isInteger(opts.tokenTtlHours) && opts.tokenTtlHours > 0 ? opts.tokenTtlHours : 12;
    const maxFailedAttempts = Number.isInteger(opts.maxFailedAttempts) && opts.maxFailedAttempts > 0 ? opts.maxFailedAttempts : 10;
    const failedWindowMs = (Number.isInteger(opts.failedWindowMinutes) && opts.failedWindowMinutes > 0 ? opts.failedWindowMinutes : 15) * 60 * 1000;
    const maxBulk = Number.isInteger(opts.maxBulk) && opts.maxBulk > 0 ? opts.maxBulk : 200;
    const maxInsertTries = 50;

    const failures = new Map();

    function pruneFailures(now) {
        if (failures.size < 5000) return;
        for (const [key, entry] of failures) {
            if (entry.resetAt <= now) failures.delete(key);
        }
    }

    function isBlocked(ip) {
        const now = Date.now();
        const entry = failures.get(ip);
        if (!entry) return false;
        if (entry.resetAt <= now) {
            failures.delete(ip);
            return false;
        }
        return entry.count >= maxFailedAttempts;
    }

    function recordFailure(ip) {
        const now = Date.now();
        pruneFailures(now);
        const entry = failures.get(ip);
        if (!entry || entry.resetAt <= now) {
            failures.set(ip, { count: 1, resetAt: now + failedWindowMs });
        } else {
            entry.count += 1;
        }
    }

    async function init() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pl_studies (
                id         SERIAL PRIMARY KEY,
                prefix     TEXT UNIQUE NOT NULL CHECK (prefix ~ '^S[1-9]$'),
                name       TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pl_participants (
                pid        SERIAL PRIMARY KEY,
                code       TEXT UNIQUE NOT NULL CHECK (code ~ '^S[1-9][ACDEFHJKMNPRTWXY3479]{3}$'),
                study_id   INTEGER NOT NULL REFERENCES pl_studies(id),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS pl_participants_study_idx ON pl_participants(study_id)');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pl_tokens (
                token_hash TEXT PRIMARY KEY,
                pid        INTEGER NOT NULL REFERENCES pl_participants(pid),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            );
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS pl_tokens_expires_idx ON pl_tokens(expires_at)');
        await pool.query('DELETE FROM pl_tokens WHERE expires_at < NOW()');
    }

    async function reservePidsThrough(minPid) {
        const floor = Number(minPid) || 0;
        const maxRes = await pool.query('SELECT COALESCE(MAX(pid), 0)::bigint AS m FROM pl_participants');
        const target = Math.max(floor, Number(maxRes.rows[0].m));
        if (target < 1) return;
        const seqRes = await pool.query("SELECT pg_get_serial_sequence('pl_participants', 'pid') AS seq");
        const seq = seqRes.rows[0].seq;
        const cur = await pool.query('SELECT last_value, is_called FROM ' + seq);
        const lastValue = Number(cur.rows[0].last_value);
        const nextValue = cur.rows[0].is_called ? lastValue + 1 : lastValue;
        if (target >= nextValue) {
            await pool.query('SELECT setval($1::regclass, $2::bigint, true)', [seq, target]);
        }
    }

    async function requireParticipant(req, res, next) {
        const token = req.get('X-Participant-Token');
        if (!token || !TOKEN_PATTERN.test(token)) {
            return res.status(401).json({ error: 'Please enter your code again.' });
        }
        try {
            const result = await pool.query(`
                SELECT t.pid, p.code, s.id AS study_id, s.prefix AS study_prefix
                FROM pl_tokens t
                JOIN pl_participants p ON p.pid = t.pid
                JOIN pl_studies s ON s.id = p.study_id
                WHERE t.token_hash = $1 AND t.expires_at > NOW()
            `, [hashToken(token)]);
            if (result.rowCount === 0) {
                return res.status(401).json({ error: 'Please enter your code again.' });
            }
            const row = result.rows[0];
            req.participant = {
                pid: row.pid,
                code: row.code,
                studyId: row.study_id,
                studyPrefix: row.study_prefix
            };
            next();
        } catch (err) {
            console.error('participant-login auth error:', err);
            res.status(500).json({ error: 'Server error. Please try again.' });
        }
    }

    const publicRouter = express.Router();

    publicRouter.post('/login', async (req, res) => {
        const ip = req.ip || 'unknown';
        if (isBlocked(ip)) {
            return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
        }
        const code = normalizeCode(req.body && req.body.code);
        const formatError = validateCode(code);
        if (formatError) return res.status(400).json({ error: formatError });
        try {
            const found = await pool.query(`
                SELECT p.pid, p.code, s.prefix AS study_prefix
                FROM pl_participants p
                JOIN pl_studies s ON s.id = p.study_id
                WHERE p.code = $1
            `, [code]);
            if (found.rowCount === 0) {
                recordFailure(ip);
                return res.status(404).json({ error: 'We could not find that code. Please check it and try again.' });
            }
            failures.delete(ip);
            const row = found.rows[0];
            const token = crypto.randomBytes(32).toString('hex');
            await pool.query('DELETE FROM pl_tokens WHERE expires_at < NOW()');
            const inserted = await pool.query(`
                INSERT INTO pl_tokens (token_hash, pid, expires_at)
                VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 hour'))
                RETURNING expires_at
            `, [hashToken(token), row.pid, tokenTtlHours]);
            res.json({
                token,
                code: row.code,
                studyPrefix: row.study_prefix,
                expiresAt: inserted.rows[0].expires_at
            });
        } catch (err) {
            console.error('participant-login login error:', err);
            res.status(500).json({ error: 'Server error. Please try again.' });
        }
    });

    publicRouter.post('/logout', async (req, res) => {
        const token = req.get('X-Participant-Token');
        if (token && TOKEN_PATTERN.test(token)) {
            try {
                await pool.query('DELETE FROM pl_tokens WHERE token_hash = $1', [hashToken(token)]);
            } catch (err) {
                console.error('participant-login logout error:', err);
            }
        }
        res.json({ success: true });
    });

    const adminRouter = express.Router();

    async function findStudy(prefix) {
        if (!PREFIX_PATTERN.test(prefix)) return null;
        const result = await pool.query('SELECT id, prefix, name, created_at FROM pl_studies WHERE prefix = $1', [prefix]);
        return result.rows[0] || null;
    }

    adminRouter.get('/studies', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT s.id, s.prefix, s.name, s.created_at, COUNT(p.pid)::int AS participant_count
                FROM pl_studies s
                LEFT JOIN pl_participants p ON p.study_id = s.id
                GROUP BY s.id
                ORDER BY s.prefix
            `);
            res.json(result.rows);
        } catch (err) {
            console.error('participant-login studies error:', err);
            res.status(500).json({ error: 'DB error.' });
        }
    });

    adminRouter.post('/studies', async (req, res) => {
        const body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const number = String(body.number == null ? '' : body.number).trim();
        if (!name) return res.status(400).json({ error: 'Enter a study name.' });
        if (name.length > 120) return res.status(400).json({ error: 'Study names have at most 120 characters.' });
        if (number.length !== 1 || !STUDY_NUMBERS.includes(number)) {
            return res.status(400).json({ error: 'Pick a study number from 1 to 9.' });
        }
        const prefix = STUDY_LETTER + number;
        try {
            const existing = await pool.query('SELECT name FROM pl_studies WHERE prefix = $1', [prefix]);
            if (existing.rowCount > 0) {
                return res.status(409).json({ error: prefix + ' already belongs to "' + existing.rows[0].name + '". Pick a number no study has used.' });
            }
            const inserted = await pool.query(
                'INSERT INTO pl_studies (prefix, name) VALUES ($1, $2) RETURNING id, prefix, name, created_at',
                [prefix, name]
            );
            res.json(Object.assign({ participant_count: 0 }, inserted.rows[0]));
        } catch (err) {
            if (err && err.code === '23505') {
                return res.status(409).json({ error: prefix + ' is already in use. Pick a number no study has used.' });
            }
            console.error('participant-login create study error:', err);
            res.status(500).json({ error: 'DB error.' });
        }
    });

    adminRouter.get('/studies/:prefix/participants', async (req, res) => {
        try {
            const study = await findStudy(req.params.prefix);
            if (!study) return res.status(404).json({ error: 'Study not found.' });
            const result = await pool.query(
                'SELECT pid, code, created_at FROM pl_participants WHERE study_id = $1 ORDER BY pid DESC',
                [study.id]
            );
            res.json(result.rows);
        } catch (err) {
            console.error('participant-login participants error:', err);
            res.status(500).json({ error: 'DB error.' });
        }
    });

    adminRouter.post('/studies/:prefix/codes', async (req, res) => {
        const count = Number((req.body || {}).count);
        if (!Number.isInteger(count) || count < 1 || count > maxBulk) {
            return res.status(400).json({ error: 'Enter a number between 1 and ' + maxBulk + '.' });
        }
        try {
            const study = await findStudy(req.params.prefix);
            if (!study) return res.status(404).json({ error: 'Study not found.' });
            const used = await pool.query('SELECT COUNT(*)::int AS n FROM pl_participants WHERE study_id = $1', [study.id]);
            const remaining = STUDY_CAPACITY - used.rows[0].n;
            if (count > remaining) {
                return res.status(400).json({ error: 'This study has room for ' + remaining + ' more codes.' });
            }
            const created = [];
            for (let i = 0; i < count; i++) {
                let row = null;
                for (let attempt = 0; attempt < maxInsertTries && !row; attempt++) {
                    const code = study.prefix + randomBody();
                    const result = await pool.query(`
                        INSERT INTO pl_participants (code, study_id)
                        VALUES ($1, $2)
                        ON CONFLICT (code) DO NOTHING
                        RETURNING pid, code, created_at
                    `, [code, study.id]);
                    if (result.rowCount > 0) row = result.rows[0];
                }
                if (!row) {
                    return res.status(500).json({
                        error: 'Created ' + created.length + ' of ' + count + ' codes before running out of unused codes.',
                        created
                    });
                }
                created.push(row);
            }
            res.json({ created });
        } catch (err) {
            console.error('participant-login generate error:', err);
            res.status(500).json({ error: 'DB error.' });
        }
    });

    return {
        init,
        reservePidsThrough,
        requireParticipant,
        publicRouter,
        adminRouter,
        normalizeCode,
        validateCode
    };
}

module.exports = createParticipantLogin;
module.exports.normalizeCode = normalizeCode;
module.exports.validateCode = validateCode;
module.exports.BODY_ALPHABET = BODY_ALPHABET;
module.exports.STUDY_CAPACITY = STUDY_CAPACITY;
