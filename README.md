# Keshav With Velo Licensing System

Production-style licensing backend for selling an Adobe After Effects extension.

## What It Includes

- Purchase confirmation API
- Automatic user creation
- Secure random license generation
- Hashed license storage
- Device-bound activation
- Periodic license verification
- Protected extension download
- Admin login with JWT
- Customer/license/device/failed-attempt views
- Block/unblock licenses
- Reset device binding
- Manual license generation
- Extension version management
- SMTP email delivery
- Stripe/Razorpay verification hooks
- Rate limiting, Helmet, CORS, input validation

## Quick Start

```bash
cd backend
copy .env.example .env
npm install
npm run init-db
npm run dev
```

API runs on `http://localhost:4000`.

Open admin dashboard:

```text
http://localhost:4000/admin
```

## Production Notes

- Put the backend behind HTTPS using Nginx, Caddy, Cloudflare, Render, Railway, Fly.io, or a VPS reverse proxy.
- Replace SQLite with Postgres for higher scale. The schema is intentionally simple and portable.
- Never expose `JWT_SECRET`, `LICENSE_HASH_SECRET`, payment secrets, or SMTP credentials to frontend code.
- Set strong `ADMIN_PASSWORD` and rotate it after first deploy.
- Upload your real extension ZIP to `EXTENSION_ZIP_PATH`.
- Configure Stripe/Razorpay webhooks to call backend webhook URLs.

## Core API

### POST `/api/purchase`

Confirms payment, creates user, generates license, sends email.

```json
{
  "name": "Customer Name",
  "email": "customer@gmail.com",
  "productId": "keshav-with-velo",
  "paymentProvider": "manual",
  "paymentId": "dev-payment-123",
  "licenseType": "standard"
}
```

Returns:

```json
{
  "status": "success",
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "downloadUrl": "http://localhost:4000/api/download"
}
```

### POST `/api/activate`

```json
{
  "email": "customer@gmail.com",
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "deviceFingerprint": "sha256-hardware-fingerprint"
}
```

If the license is already bound to another device:

```json
{
  "status": "failed",
  "reason": "License already activated on another device"
}
```

### POST `/api/verify-license`

```json
{
  "licenseKey": "XXXX-XXXX-XXXX-XXXX",
  "deviceFingerprint": "sha256-hardware-fingerprint"
}
```

Returns `valid`, `invalid`, `blocked`, or `expired`.

### POST `/api/download`

```json
{
  "email": "customer@gmail.com",
  "licenseKey": "XXXX-XXXX-XXXX-XXXX"
}
```

Returns the ZIP file only for valid purchased users.

## Admin API

Admin login:

```http
POST /api/admin/login
```

```json
{
  "email": "admin@example.com",
  "password": "change-this-admin-password"
}
```

Use returned JWT:

```http
Authorization: Bearer <token>
```

Admin routes:

- `GET /api/admin/users`
- `GET /api/admin/licenses?q=email-or-key-fragment`
- `POST /api/admin/licenses/:id/block`
- `POST /api/admin/licenses/:id/unblock`
- `POST /api/admin/licenses/:id/reset-device`
- `GET /api/admin/activation-attempts`
- `POST /api/admin/manual-license`
- `GET /api/admin/versions`
- `POST /api/admin/versions`

## Extension Integration

Your After Effects extension should:

1. Collect email, license key, and hardware fingerprint.
2. Call `/api/activate` on first activation.
3. Store a short-lived local activation token only after success.
4. Call `/api/verify-license` on launch and periodically.
5. Disable premium UI if response is `invalid`, `blocked`, or `expired`.
