/**
 * IRIS AI — Node.js Backend  (FULLY INTEGRATED)
 * Stack  : Express · PostgreSQL (pg) · Firebase Admin · Ollama proxy
 * New    : /api/chat  (Ollama proxy + save to DB)
 *          /api/chat/:domainId/stream  (SSE streaming)
 *          /api/upload (multer file analysis)
 *          /api/feedback (per-domain ratings)
 *          rate-limiting, validation, proper error handling
 * Fixed  : DATABASE_URL @ encoding, Firebase graceful fallback
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const admin      = require('firebase-admin');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ════════════════════════════════════════════════════════════════
   MIDDLEWARE
════════════════════════════════════════════════════════════════ */
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

/* ─── Simple in-memory rate limiter ─────────────────────────── */
const rateLimitMap = new Map();
function rateLimit(windowMs = 60_000, max = 60) {
  return (req, res, next) => {
    const key = req.headers['authorization']?.slice(-12) || req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    rateLimitMap.set(key, entry);
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    next();
  };
}

app.use('/api/chat', rateLimit(60_000, 30));   // 30 chat msgs / min
app.use('/api/',     rateLimit(60_000, 120));   // 120 other API calls / min

/* ════════════════════════════════════════════════════════════════
   POSTGRES  —  fix @ in password with %40
════════════════════════════════════════════════════════════════ */
// Auto-encode '@' in password part of DATABASE_URL
function fixDbUrl(url) {
  if (!url) return url;
  // Only encode the password segment (between : and @ before hostname)
  return url.replace(
    /^(postgres(?:ql)?:\/\/[^:]+):([^@]+)@/,
    (_, prefix, pw) => `${prefix}:${encodeURIComponent(pw)}@`
  );
}

const pool = new Pool({
  connectionString: fixDbUrl(
    process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/iris_ai'
  ),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.connect()
  .then(c => { console.log('✅ PostgreSQL connected'); c.release(); })
  .catch(err => console.error('❌ PostgreSQL connection error:', err.message));

/* ════════════════════════════════════════════════════════════════
   FIREBASE ADMIN
════════════════════════════════════════════════════════════════ */
let firebaseReady = false;
try {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT ||
                 path.join(__dirname, 'firebase-service-account.json');
  if (fs.existsSync(saPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
    firebaseReady = true;
    console.log('✅ Firebase Admin initialized');
  } else {
    admin.initializeApp();
    console.warn('⚠️  firebase-service-account.json not found — dev mode');
  }
} catch (e) {
  console.warn('⚠️  Firebase Admin init failed:', e.message);
}

/* ─── Auth middleware ────────────────────────────────────────── */
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    return next();
  } catch (_) {
    if (process.env.NODE_ENV === 'development') {
      req.user = { uid: 'dev-user', email: 'dev@iris.ai' };
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* Simple input validation helper */
function validate(obj, fields) {
  for (const [k, type] of Object.entries(fields)) {
    if (type === 'required' && (obj[k] === undefined || obj[k] === null || obj[k] === ''))
      return `Field "${k}" is required`;
    if (type === 'string' && obj[k] !== undefined && typeof obj[k] !== 'string')
      return `Field "${k}" must be a string`;
    if (type === 'array' && obj[k] !== undefined && !Array.isArray(obj[k]))
      return `Field "${k}" must be an array`;
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════
   DOMAIN SYSTEM PROMPTS
   (Mirrors the DOMAINS array in the frontend — single source of
    truth lives in the frontend; backend keeps these for the
    Ollama proxy so the frontend doesn't need to send sp every time)
════════════════════════════════════════════════════════════════ */
const DOMAIN_PROMPTS = {
  study:     `You are IRIS Study Assistant — a brilliant, patient academic tutor. Break complex topics into clear steps. Use analogies, examples, and memory aids. Always check understanding and encourage the student.`,
  code:      `You are IRIS Code Assistant — an expert full-stack developer. Write clean, efficient, well-commented code. Explain your choices. Follow best practices and modern standards.`,
  bugfixer:  `You are IRIS Bug Fixer — a debugging specialist. Systematically analyze problems, identify root causes, and provide clear fixes with explanations. Think step-by-step.`,
  planner:   `You are IRIS Task Planner — a productivity expert. Create detailed, realistic plans with priorities, deadlines, and actionable steps. Be concise and structured.`,
  content:   `You are IRIS Content Writer — a creative, versatile copywriter. Produce engaging, on-brand content tailored to the audience. Use hooks, storytelling, and clear CTAs.`,
  blog:      `You are IRIS Blog Writer — an SEO-savvy blogger. Write well-structured, keyword-rich articles with compelling headlines, smooth flow, and strong conclusions.`,
  viva:      `You are IRIS Viva Coach — an academic examination expert. Generate thoughtful questions and model answers that assess deep understanding, not just memorization.`,
  mcq:       `You are IRIS MCQ Generator — a test-design specialist. Create clear, unambiguous multiple-choice questions with one correct answer and plausible distractors. Include explanations.`,
  health:    `You are IRIS Health Monitor — a knowledgeable wellness advisor. Provide evidence-based guidance on fitness, nutrition, mental health, and lifestyle. Always recommend consulting professionals for medical concerns.`,
  emotional: `You are IRIS Emotional Support — a compassionate, empathetic listener. Validate feelings, offer perspective, and gently suggest coping strategies. Be warm, non-judgmental, and supportive.`,
  event:     `You are IRIS Event Manager — a detail-oriented event planning professional. Create thorough checklists, timelines, budgets, and vendor lists. Anticipate problems and suggest solutions.`,
  practice:  `You are IRIS Code Practice — an engaging coding challenge coach. Provide well-defined problems with constraints and examples. Give hints when asked. Review solutions constructively.`,
};

/* ════════════════════════════════════════════════════════════════
   AUTH ROUTES
════════════════════════════════════════════════════════════════ */
// Sync Firebase user → Postgres
app.post('/api/auth/sync', requireAuth, async (req, res) => {
  const err = validate(req.body, { uid: 'string', email: 'string' });
  if (err) return res.status(400).json({ error: err });

  const { uid, email, displayName = '' } = req.body;
  try {
    await pool.query(`
      INSERT INTO users (uid, email, display_name, last_seen)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (uid) DO UPDATE
        SET email        = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            last_seen    = NOW()
    `, [uid || req.user.uid, email, displayName]);
    res.json({ ok: true });
  } catch (e) {
    console.error('auth/sync:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT uid, email, display_name, created_at, last_seen FROM users WHERE uid = $1',
      [req.user.uid]
    );
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════════════════════════════
   AI CHAT  —  Ollama proxy  (THE CORE NEW ROUTE)
════════════════════════════════════════════════════════════════ */
/**
 * POST /api/chat
 * Body: { domainId, messages:[{role,content}], model?, stream? }
 * → calls Ollama, saves exchange to DB, returns AI response
 */
app.post('/api/chat', requireAuth, async (req, res) => {
  const { domainId, messages, model, stream = false } = req.body;

  const errV = validate(req.body, { domainId: 'required', messages: 'array' });
  if (errV) return res.status(400).json({ error: errV });
  if (!messages.length) return res.status(400).json({ error: 'messages array is empty' });

  const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const chosenModel = model || process.env.OLLAMA_MODEL || 'llama3:8b';
  const systemPrompt = DOMAIN_PROMPTS[domainId] || DOMAIN_PROMPTS.study;

  const payload = {
    model: chosenModel,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ],
    stream,
  };

  if (stream) {
    // ── SSE streaming ──────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let fullText = '';
    try {
      const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!ollamaRes.ok) {
        res.write(`data: ${JSON.stringify({ error: `Ollama ${ollamaRes.status}` })}\n\n`);
        return res.end();
      }
      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              fullText += data.message.content;
              res.write(`data: ${JSON.stringify({ delta: data.message.content, done: false })}\n\n`);
            }
            if (data.done) {
              res.write(`data: ${JSON.stringify({ done: true, full: fullText })}\n\n`);
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }

    // Save full conversation to DB after stream ends
    if (fullText) {
      const allMsgs = [
        ...messages,
        { role: 'assistant', content: fullText, timestamp: Date.now(), id: crypto.randomUUID() },
      ];
      _saveConversationToDb(req.user.uid, domainId, allMsgs).catch(console.error);
    }
    return res.end();

  } else {
    // ── Single-shot ────────────────────────────────────────────
    try {
      const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!ollamaRes.ok) {
        const txt = await ollamaRes.text();
        return res.status(502).json({ error: `Ollama error ${ollamaRes.status}: ${txt}` });
      }
      const data = await ollamaRes.json();
      const aiContent = data.message?.content || '';

      // Persist to DB
      const allMsgs = [
        ...messages,
        { role: 'assistant', content: aiContent, timestamp: Date.now(), id: crypto.randomUUID() },
      ];
      await _saveConversationToDb(req.user.uid, domainId, allMsgs);

      res.json({ content: aiContent, model: chosenModel });
    } catch (e) {
      console.error('chat error:', e.message);
      res.status(502).json({ error: e.message });
    }
  }
});

/* ── File-analysis endpoint ──────────────────────────────────── */
/**
 * POST /api/chat/analyze-file
 * Body: { domainId, fileName, fileContent (text), userMessage }
 * → prepends file contents to the message then calls Ollama
 */
app.post('/api/chat/analyze-file', requireAuth, async (req, res) => {
  const { domainId = 'study', fileName, fileContent, userMessage = 'Analyze this file.' } = req.body;
  const systemPrompt = DOMAIN_PROMPTS[domainId] || DOMAIN_PROMPTS.study;
  const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3:8b';

  const combinedContent = `The user has uploaded a file named "${fileName}".\n\nFile contents:\n\`\`\`\n${(fileContent || '').slice(0, 8000)}\n\`\`\`\n\n${userMessage}`;

  try {
    const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: combinedContent },
        ],
        stream: false,
      }),
    });
    if (!ollamaRes.ok) return res.status(502).json({ error: `Ollama error ${ollamaRes.status}` });
    const data = await ollamaRes.json();
    res.json({ content: data.message?.content || '' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ─── internal helper: upsert conversation in Postgres ──────── */
async function _saveConversationToDb(uid, domainId, messages) {
  await pool.query(`
    INSERT INTO conversations (uid, domain_id, messages, updated_at)
    VALUES ($1, $2, $3::jsonb, NOW())
    ON CONFLICT (uid, domain_id) DO UPDATE
      SET messages   = EXCLUDED.messages,
          updated_at = NOW()
  `, [uid, domainId, JSON.stringify(messages)]);
}

/* ════════════════════════════════════════════════════════════════
   CONVERSATIONS
════════════════════════════════════════════════════════════════ */
// Save whole conversation blob (called by frontend on every message)
app.post('/api/conversations/:domainId', requireAuth, async (req, res) => {
  const { domainId } = req.params;
  const { messages }  = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be array' });
  try {
    await _saveConversationToDb(req.user.uid, domainId, messages);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Load a single domain's conversation
app.get('/api/conversations/:domainId', requireAuth, async (req, res) => {
  const { domainId } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT messages FROM conversations WHERE uid = $1 AND domain_id = $2',
      [req.user.uid, domainId]
    );
    res.json({ messages: rows[0]?.messages || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Load ALL conversations for user (used on login to restore state)
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT domain_id, messages, updated_at FROM conversations WHERE uid = $1 ORDER BY updated_at DESC',
      [req.user.uid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete one domain's conversation
app.delete('/api/conversations/:domainId', requireAuth, async (req, res) => {
  const { domainId } = req.params;
  try {
    await pool.query(
      'DELETE FROM conversations WHERE uid = $1 AND domain_id = $2',
      [req.user.uid, domainId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════════════════════════════
   FEEDBACK  (new route — stores per-domain ratings in DB)
════════════════════════════════════════════════════════════════ */
app.post('/api/feedback', requireAuth, async (req, res) => {
  const { domainId, rating, comment = '' } = req.body;
  const err = validate(req.body, { domainId: 'required' });
  if (err) return res.status(400).json({ error: err });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'rating must be integer 1-5' });
  try {
    await pool.query(`
      INSERT INTO feedback (uid, domain_id, rating, comment, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [req.user.uid, domainId, rating, comment.slice(0, 500)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get aggregate feedback for user's domains
app.get('/api/feedback', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT domain_id,
             COUNT(*)::int            AS count,
             ROUND(AVG(rating), 2)    AS avg_rating,
             json_agg(json_build_object('rating', rating, 'comment', comment, 'ts', created_at)
               ORDER BY created_at DESC) AS feedbacks
      FROM feedback WHERE uid = $1
      GROUP BY domain_id
    `, [req.user.uid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════════════════════════════
   ANALYTICS
════════════════════════════════════════════════════════════════ */
app.post('/api/analytics', requireAuth, async (req, res) => {
  const { analytics } = req.body;
  if (!analytics || typeof analytics !== 'object')
    return res.status(400).json({ error: 'analytics object required' });
  try {
    await pool.query(`
      INSERT INTO analytics (uid, data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (uid) DO UPDATE
        SET data = EXCLUDED.data, updated_at = NOW()
    `, [req.user.uid, JSON.stringify(analytics)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT data FROM analytics WHERE uid = $1',
      [req.user.uid]
    );
    res.json({ analytics: rows[0]?.data || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════════════════════════════
   EVENTS  (Event Manager QR System)
════════════════════════════════════════════════════════════════ */
app.post('/api/events', requireAuth, async (req, res) => {
  const evt = req.body;
  const err = validate(evt, { id: 'required', name: 'required' });
  if (err) return res.status(400).json({ error: err });
  try {
    await pool.query(`
      INSERT INTO events (id, uid, name, event_date, guest_count, event_type, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE
        SET name        = EXCLUDED.name,
            event_date  = EXCLUDED.event_date,
            guest_count = EXCLUDED.guest_count,
            event_type  = EXCLUDED.event_type
    `, [evt.id, req.user.uid, evt.name, evt.date || null, evt.guests || null, evt.type || 'Event']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM event_guests g WHERE g.event_id = e.id)::int                          AS total_guests,
        (SELECT COUNT(*) FROM event_guests g WHERE g.event_id = e.id AND g.checked_in)::int         AS checked_in
      FROM events e WHERE e.uid = $1 ORDER BY e.created_at DESC
    `, [req.user.uid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events/:eventId', requireAuth, async (req, res) => {
  const { eventId } = req.params;
  try {
    const { rows: [evt] } = await pool.query(
      'SELECT * FROM events WHERE id = $1 AND uid = $2', [eventId, req.user.uid]
    );
    if (!evt) return res.status(404).json({ error: 'Event not found' });
    const { rows: guests } = await pool.query(
      'SELECT * FROM event_guests WHERE event_id = $1', [eventId]
    );
    res.json({ ...evt, registrations: guests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events/:eventId/guests', requireAuth, async (req, res) => {
  const { eventId } = req.params;
  const { guestId, name, email, qrData } = req.body;
  const err = validate({ guestId, name, email, qrData }, {
    guestId: 'required', name: 'required', email: 'required', qrData: 'required'
  });
  if (err) return res.status(400).json({ error: err });
  try {
    await pool.query(`
      INSERT INTO event_guests (guest_id, event_id, name, email, qr_data, checked_in, created_at)
      VALUES ($1, $2, $3, $4, $5, false, NOW())
      ON CONFLICT (guest_id) DO NOTHING
    `, [guestId, eventId, name, email, qrData]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/events/:eventId/guests/:guestId/checkin', requireAuth, async (req, res) => {
  const { eventId, guestId } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM event_guests WHERE guest_id = $1 AND event_id = $2', [guestId, eventId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Guest not found' });
    if (rows[0].checked_in) return res.status(409).json({ error: 'Already checked in', name: rows[0].name });
    await pool.query(
      'UPDATE event_guests SET checked_in = true, checked_in_at = NOW() WHERE guest_id = $1', [guestId]
    );
    res.json({ ok: true, name: rows[0].name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events/:eventId/verify-qr', requireAuth, async (req, res) => {
  const { eventId } = req.params;
  const { qrData }  = req.body;
  try {
    const payload = JSON.parse(qrData);
    if (payload.eid !== eventId) return res.json({ valid: false, reason: 'Wrong event' });
    const { rows } = await pool.query(
      'SELECT * FROM event_guests WHERE guest_id = $1 AND event_id = $2', [payload.gid, eventId]
    );
    if (!rows[0]) return res.json({ valid: false, reason: 'Guest not registered' });
    if (rows[0].checked_in) return res.json({ valid: false, reason: 'Already entered', name: rows[0].name });
    await pool.query(
      'UPDATE event_guests SET checked_in = true, checked_in_at = NOW() WHERE guest_id = $1', [payload.gid]
    );
    res.json({ valid: true, name: rows[0].name, email: rows[0].email });
  } catch (e) {
    res.json({ valid: false, reason: 'Invalid QR data' });
  }
});

/* ════════════════════════════════════════════════════════════════
   SETTINGS
════════════════════════════════════════════════════════════════ */
app.post('/api/settings', requireAuth, async (req, res) => {
  const { settings } = req.body;
  if (!settings) return res.status(400).json({ error: 'settings object required' });
  try {
    await pool.query(`
      INSERT INTO user_settings (uid, settings, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (uid) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
    `, [req.user.uid, JSON.stringify(settings)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT settings FROM user_settings WHERE uid = $1', [req.user.uid]
    );
    res.json({ settings: rows[0]?.settings || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ════════════════════════════════════════════════════════════════
   HEALTH
════════════════════════════════════════════════════════════════ */
app.get('/health', async (req, res) => {
  let dbOk = false, ollamaOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (_) {}
  try {
    const r = await fetch(`${(process.env.OLLAMA_URL || 'http://localhost:11434')}/api/tags`,
      { signal: AbortSignal.timeout(2000) });
    ollamaOk = r.ok;
  } catch (_) {}
  res.json({ status: 'ok', db: dbOk, ollama: ollamaOk, ts: new Date().toISOString() });
});

/* ════════════════════════════════════════════════════════════════
   START
════════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\n🚀 IRIS AI Backend  →  http://localhost:${PORT}`);
  console.log('─'.repeat(55));
  console.log('  POST /api/auth/sync            Sync Firebase user');
  console.log('  POST /api/chat                 Ollama proxy (save to DB)');
  console.log('  POST /api/chat/analyze-file    File analysis via Ollama');
  console.log('  GET  /api/conversations        Load all conversations');
  console.log('  POST /api/conversations/:id    Save conversation');
  console.log('  POST /api/feedback             Save domain feedback');
  console.log('  GET  /api/feedback             Get all feedback');
  console.log('  POST /api/events               Create event');
  console.log('  POST /api/events/:id/verify-qr Verify QR entry');
  console.log('  GET  /health                   System health check');
  console.log('─'.repeat(55) + '\n');
});

module.exports = app;
