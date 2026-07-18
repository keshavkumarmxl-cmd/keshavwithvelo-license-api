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

// --- 1. Database Connection (PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render DBs
});

// --- 2. Email Transporter Setup ---
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
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
            const paymentEntity = req.body.payload.payment.entity;
            const customerEmail = paymentEntity.email;
            
            if (!customerEmail) throw new Error("No email found in webhook payload");

            // Generate Key
            const newLicenseKey = generateLicenseKey();

            // Save to Database
            const insertQuery = `
                INSERT INTO licenses (key, email, machine_id, status)
                VALUES ($1, $2, null, 'active')
            `;
            await pool.query(insertQuery, [newLicenseKey, customerEmail]);
            console.log(`License generated for ${customerEmail}: ${newLicenseKey}`);

            // Send Email
            const downloadUrl = process.env.EXTENSION_DOWNLOAD_URL || 'https://keshavwithvelo.com/download';
            const mailOptions = {
                from: process.env.SMTP_FROM,
                to: customerEmail,
                subject: 'Your Keshav With Velo License Key',
                text: `Thank you for purchasing Keshav With Velo!\n\nYour Activation Key is:\n${newLicenseKey}\n\nYou can download the extension here:\n${downloadUrl}\n\nNote: This key will lock to the first device you use it on.\n\nRegards,\nTeam Keshav With Velo`
            };

            await transporter.sendMail(mailOptions);
            console.log(`Email sent to ${customerEmail}`);
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
        // Fetch license from DB
        const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [licenseKey]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ valid: false, message: 'Invalid License Key' });
        }

        const license = result.rows[0];

        if (license.status !== 'active') {
            return res.status(403).json({ valid: false, message: 'License is revoked or inactive' });
        }

        // Check Device Lock Logic
        if (!license.machine_id) {
            // First time activation: Bind to this PC
            await pool.query('UPDATE licenses SET machine_id = $1 WHERE key = $2', [machineId, licenseKey]);
            return res.json({ valid: true, message: 'License activated and bound to this device successfully!' });
        } else if (license.machine_id === machineId) {
            // Same PC: Allow access
            return res.json({ valid: true, message: 'License verified successfully.' });
        } else {
            // Different PC: Reject
            return res.status(403).json({ valid: false, message: 'License is already in use on another device.' });
        }

    } catch (error) {
        console.error('Validation Error:', error);
        res.status(500).json({ valid: false, message: 'Server error during validation' });
    }
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`License server is running on port ${PORT}`);
});
