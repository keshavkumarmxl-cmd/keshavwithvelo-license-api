require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const app = express();
app.use(cors());
// Raw body is required for accurate webhook signature verification
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const PORT = process.env.PORT || 3000;

// Keep webhook processing idempotent. Razorpay can deliver both `payment.captured`
// and `order.paid` for one purchase, and retries any non-2xx response.
async function ensureSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS processed_payments (
            payment_id TEXT PRIMARY KEY,
            license_key TEXT NOT NULL,
            email TEXT NOT NULL,
            email_sent_at TIMESTAMPTZ
        )
    `);
}

function normalizeLicenseKey(value) {
    return String(value || '').trim().toUpperCase();
}

function requireAdmin(req, res, next) {
    const header = String(req.headers.authorization || "");
    const credentials = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":") : [];
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || credentials[0] !== process.env.ADMIN_EMAIL || credentials.slice(1).join(":") !== process.env.ADMIN_PASSWORD) {
        res.set("WWW-Authenticate", 'Basic realm="KWV License Admin"');
        return res.status(401).send("Admin login required.");
    }
    next();
}

async function sendLicenseEmail(email, licenseKey) {
    const downloadUrl = process.env.EXTENSION_DOWNLOAD_URL || "https://keshavwithvelo.com/download";
    await transporter.sendMail({
        from: process.env.RESEND_FROM || process.env.SMTP_FROM,
        to: email,
        subject: "Your Keshav With Velo License Key",
        text: `Thank you for purchasing Keshav With Velo!\n\nYour Activation Key is:\n${licenseKey}\n\nYou can download the extension here:\n${downloadUrl}\n\nNote: This key will lock to the first device you use it on.\n\nRegards,\nTeam Keshav With Velo`
    });
}

async function validateLicense(licenseKey, machineId) {
    const key = normalizeLicenseKey(licenseKey);
    const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
    if (result.rows.length === 0) return { httpStatus: 404, valid: false, message: 'Invalid License Key' };

    const license = result.rows[0];
    if (license.status !== 'active') return { httpStatus: 403, valid: false, message: 'License is revoked or inactive' };
    if (!license.machine_id) {
        // The condition prevents two simultaneous first activations from binding
        // the same key to different devices.
        const bound = await pool.query(
            'UPDATE licenses SET machine_id = $1 WHERE key = $2 AND machine_id IS NULL RETURNING machine_id',
            [machineId, key]
        );
        if (bound.rows.length) return { httpStatus: 200, valid: true, message: 'License activated and bound to this device successfully!' };
        return validateLicense(key, machineId);
    }
    if (license.machine_id === machineId) return { httpStatus: 200, valid: true, message: 'License verified successfully.' };
    return { httpStatus: 403, valid: false, message: 'License is already in use on another device.' };
}

// --- 1. Database Connection (PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render DBs
});

// --- 2. Email Transporter Setup ---
// Resend is the primary production sender. SMTP_* stays as a fallback for
// local/testing setups so existing delivery configuration is not broken.
const usingResend = Boolean(process.env.RESEND_API_KEY);
const transporter = nodemailer.createTransport({
    host: usingResend ? "smtp.resend.com" : process.env.SMTP_HOST,
    port: Number(usingResend ? 465 : (process.env.SMTP_PORT || 587)),
    secure: usingResend || String(process.env.SMTP_PORT) === "465",
    auth: {
        user: usingResend ? "resend" : process.env.SMTP_USER,
        pass: usingResend ? process.env.RESEND_API_KEY : process.env.SMTP_PASS
    }
});

// --- Helper: Generate License Key ---
function generateLicenseKey() {
    const segment = () => crypto.randomBytes(2).toString('hex').toUpperCase();
    return `KWV-${segment()}-${segment()}-${segment()}-${segment()}`; // Format: KWV-XXXX-XXXX-XXXX-XXXX
}

// --- 3. Razorpay Webhook Endpoint ---
app.post('/v1/razorpay/webhook', async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    try {
        // Signature Verification
        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(req.rawBody) // using raw body for perfect match
            .digest('hex');

        if (expectedSignature !== signature) {
            console.error('Invalid Razorpay Signature');
            return res.status(400).send('Invalid signature');
        }

        const event = req.body.event;
        
        // Process only payment captured event
        if (event === 'payment.captured' || event === 'order.paid') {
            const paymentEntity = req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
            const orderEntity = req.body.payload && req.body.payload.order && req.body.payload.order.entity;
            if (!paymentEntity || !paymentEntity.id) throw new Error('Webhook has no payment entity');
            const customerEmail = paymentEntity.email || (paymentEntity.notes && paymentEntity.notes.email) || (orderEntity && orderEntity.notes && orderEntity.notes.email);
            
            if (!customerEmail) throw new Error("No email found in webhook payload");

            // One payment may result in multiple webhook events/retries. Reuse the
            // original key and retry only the delivery instead of issuing a new key.
            let delivery = await pool.query(
                'SELECT license_key, email, email_sent_at FROM processed_payments WHERE payment_id = $1',
                [paymentEntity.id]
            );
            if (!delivery.rows.length) {
                const newLicenseKey = generateLicenseKey();
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('INSERT INTO licenses (key, email, machine_id, status) VALUES ($1, $2, null, $3)', [newLicenseKey, customerEmail, 'active']);
                    await client.query('INSERT INTO processed_payments (payment_id, license_key, email) VALUES ($1, $2, $3)', [paymentEntity.id, newLicenseKey, customerEmail]);
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK');
                    if (error.code !== '23505') throw error;
                } finally {
                    client.release();
                }
                delivery = await pool.query('SELECT license_key, email, email_sent_at FROM processed_payments WHERE payment_id = $1', [paymentEntity.id]);
            }
            const record = delivery.rows[0];
            if (!record) throw new Error('Could not create or load payment delivery');

            if (!record.email_sent_at) {
                const downloadUrl = process.env.EXTENSION_DOWNLOAD_URL || 'https://keshavwithvelo.com/download';
                await transporter.sendMail({
                    from: process.env.SMTP_FROM,
                    to: record.email,
                    subject: 'Your Keshav With Velo License Key',
                    text: `Thank you for purchasing Keshav With Velo!\n\nYour Activation Key is:\n${record.license_key}\n\nYou can download the extension here:\n${downloadUrl}\n\nNote: This key will lock to the first device you use it on.\n\nRegards,\nTeam Keshav With Velo`
                });
                await pool.query('UPDATE processed_payments SET email_sent_at = NOW() WHERE payment_id = $1', [paymentEntity.id]);
                console.log(`Email sent to ${record.email}`);
            }
        }

        // Return 200 OK so Razorpay knows webhook was received
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- 4. Extension Endpoint: Validate & Bind License ---
app.post('/v1/license/validate', async (req, res) => {
    const { licenseKey, machineId } = req.body;

    if (!licenseKey || !machineId) {
        return res.status(400).json({ valid: false, message: 'Missing licenseKey or machineId' });
    }

    try {
        const outcome = await validateLicense(licenseKey, machineId);
        return res.status(outcome.httpStatus).json({ valid: outcome.valid, message: outcome.message });

    } catch (error) {
        console.error('Validation Error:', error);
        res.status(500).json({ valid: false, message: 'Server error during validation' });
    }
});

// Backwards-compatible routes used by the shipped CEP extension. Keep this
// contract until the extension's configured API URL is changed deliberately.
app.post('/api/activate', async (req, res) => {
    const { email, licenseKey, deviceFingerprint } = req.body || {};
    if (!email || !licenseKey || !deviceFingerprint) {
        return res.status(400).json({ status: 'failed', message: 'Missing email, license key or device fingerprint.' });
    }
    try {
        const owner = await pool.query('SELECT email FROM licenses WHERE key = $1', [normalizeLicenseKey(licenseKey)]);
        if (!owner.rows.length || String(owner.rows[0].email).toLowerCase() !== String(email).trim().toLowerCase()) {
            return res.status(403).json({ status: 'failed', code: 'INVALID_LICENSE', message: 'This license does not belong to this email address.' });
        }
        const outcome = await validateLicense(licenseKey, deviceFingerprint);
        if (!outcome.valid) return res.status(outcome.httpStatus).json({ status: 'failed', code: outcome.httpStatus === 403 ? 'DEVICE_ALREADY_BOUND' : 'INVALID_LICENSE', message: outcome.message });
        return res.json({ status: 'success', message: outcome.message });
    } catch (error) {
        console.error('Activation Error:', error);
        return res.status(500).json({ status: 'failed', message: 'Server error during activation.' });
    }
});

app.post('/api/verify-license', async (req, res) => {
    const { licenseKey, deviceFingerprint } = req.body || {};
    if (!licenseKey || !deviceFingerprint) return res.status(400).json({ status: 'invalid', message: 'Missing license key or device fingerprint.' });
    try {
        const outcome = await validateLicense(licenseKey, deviceFingerprint);
        if (!outcome.valid) return res.status(outcome.httpStatus).json({ status: 'invalid', message: outcome.message });
        return res.json({ status: 'valid', message: outcome.message });
    } catch (error) {
        console.error('Verification Error:', error);
        return res.status(500).json({ status: 'invalid', message: 'Server error during verification.' });
    }
});

app.get('/admin', requireAdmin, (req, res) => res.type('html').send(`<!doctype html><title>KWV License Admin</title><style>body{font:15px Arial;max-width:850px;margin:40px auto}input,button{padding:9px;margin:4px}pre{white-space:pre-wrap;background:#f4f4f4;padding:14px}</style><h1>Keshav With Velo — License Admin</h1><input id=q placeholder="Email or key" size=35><button onclick="search()">Search</button><button onclick="create()">Create + send</button><button onclick="reset()">Reset device</button><button onclick="resend()">Resend key</button><pre id=o>Ready.</pre><script>const o=document.querySelector('#o'),q=document.querySelector('#q');async function call(url,opts){let r=await fetch(url,opts);let x=await r.json();if(!r.ok)throw Error(x.error||'Request failed');o.textContent=JSON.stringify(x,null,2)}function search(){call('/admin/api/licenses?q='+encodeURIComponent(q.value))}function create(){let email=prompt('Customer email');if(email)call('/admin/api/licenses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})})}function resend(){call('/admin/api/licenses/'+encodeURIComponent(q.value)+'/resend',{method:'POST'})}function reset(){if(confirm('Reset device binding?'))call('/admin/api/licenses/'+encodeURIComponent(q.value)+'/reset-device',{method:'POST'})}</script>`));

app.get('/admin/api/licenses', requireAdmin, async (req, res, next) => {
    try { const q = `%${String(req.query.q || '').trim()}%`; const rows = await pool.query('SELECT key, email, machine_id, status FROM licenses WHERE email ILIKE $1 OR key ILIKE $1 ORDER BY email LIMIT 50', [q]); res.json(rows.rows); } catch (e) { next(e); }
});
app.post('/admin/api/licenses', requireAdmin, async (req, res, next) => {
    try { const email = String(req.body.email || '').trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required.' }); const key = generateLicenseKey(); await pool.query('INSERT INTO licenses (key,email,machine_id,status) VALUES ($1,$2,NULL,$3)', [key,email,'active']); await sendLicenseEmail(email,key); res.status(201).json({ key,email,delivered:true }); } catch (e) { next(e); }
});
app.post('/admin/api/licenses/:key/resend', requireAdmin, async (req, res, next) => {
    try { const row = await pool.query('SELECT key,email FROM licenses WHERE key=$1', [normalizeLicenseKey(req.params.key)]); if (!row.rows.length) return res.status(404).json({ error: 'License not found.' }); await sendLicenseEmail(row.rows[0].email,row.rows[0].key); res.json({ delivered:true,email:row.rows[0].email }); } catch (e) { next(e); }
});
app.post('/admin/api/licenses/:key/reset-device', requireAdmin, async (req, res, next) => {
    try { const result = await pool.query('UPDATE licenses SET machine_id=NULL WHERE key=$1 RETURNING key,email', [normalizeLicenseKey(req.params.key)]); if (!result.rows.length) return res.status(404).json({ error: 'License not found.' }); res.json({ reset:true,email:result.rows[0].email }); } catch (e) { next(e); }
});

// --- Start Server ---
ensureSchema().then(() => {
    app.listen(PORT, () => console.log(`License server is running on port ${PORT}`));
}).catch((error) => {
    console.error('Database initialization failed:', error);
    process.exit(1);
});
