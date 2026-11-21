# AuraPay — testing, production requirements, and website integration

## Current deployment

- Source: https://github.com/bjendermisra-ops/Dev-payment-gateway-
- Site: https://dev-payment-gateway.vercel.app
- State: **testing build, not a production payment processor**.
- GitHub Actions runs Node HTTP smoke tests on every push.
- This repository includes an Express API, merchant dashboard, QR generation, checkout pages, and an optional IMAP email-alert parser.

### Important: never send live payments to the current Vercel demo

Vercel's serverless process cannot guarantee a long-lived Gmail IMAP connection or shared writable local storage. Live order creation is disabled by default. It can only be enabled with persistent MongoDB storage, `PAYMENT_VERIFICATION_ENABLED=true`, and an authenticated verifier secret. A real bank/PSP must then deliver verified settlement events; setting variables alone does NOT establish real verification. QR images inherited from a third-party demo must NOT be paid; public landing-page imagery uses a non-scannable DEMO placeholder.

The original code's bank-email parser has NOT been certified to authenticate bank transactions. Email screenshots, UTR text, and sender-provided notes are not proof of receipt. Only an authoritative, authenticated provider feed or independently reconciled bank credits should be allowed to change a real order to `PAID`.

## Run locally

Requires Node.js 22 or higher and npm. Do not commit secrets.

```bash
git clone https://github.com/bjendermisra-ops/Dev-payment-gateway-.git
cd Dev-payment-gateway-
npm ci
cp .env.example .env
npm test
npm start
```

Open http://localhost:3000. Without `MONGODB_URI`, local data remains a **non-durable developer-only test store**. The UI can be reviewed; payment creation remains off.

## Required configuration for merchant accounts

1. Create a MongoDB Atlas database, ideally an M0 free cluster for development, with a dedicated restricted database user. Copy the connection URI to the `MONGODB_URI` environment variable in Vercel Project Settings → Environment Variables (production, preview). Keep it secret; do not paste credentials into ChatGPT/GitHub.
2. Configure a randomly generated `SESSION_SECRET` (at least 32 random bytes) in the same Vercel project. It is used for signed HttpOnly login cookies.
3. Redeploy and visit `/api/health`. Confirm `storage: mongodb`; if not, review Vercel function logs and database access rules.
4. Register on the site and complete onboarding with **your own UPI ID**. Do NOT use any demonstration UPI handle.
5. For actual payments, deploy a persistent Node backend and a trusted transaction verifier. Configure the backend with `MONGODB_URI`, `SESSION_SECRET`, `PAYMENT_VERIFICATION_ENABLED=true` **only after a trusted verification method is working and tested**. This flag must never be used to bypass bank reconciliation.
6. Route your Vercel frontend's API requests to that trusted backend. Protect credentials, enable appropriate CORS and cookies, configure TLS, and test end-to-end before enabling real orders.
7. For Gmail-based bank alerts, if supported by your bank, use a restricted mailbox and encrypted credentials managed by your backend. This code's current email-alert parser is *not* an authoritative bank payment confirmation and should not be used alone for real-money fulfillment.

Do not store a Gmail App Password in Vercel demo onboarding. `GMAIL_APP_PASS` and other secrets should remain in the persistent service's environment, not in a repository or browser.

## What is implemented

| Feature | Current state |
|---|---|
| GitHub source + CI | Available |
| Vercel frontend/Express deployment | Available |
| Authenticated merchant sessions | Signed HttpOnly cookies, PBKDF2 passwords |
| Tenant authorization | Merchant identity taken from session, not user-supplied header |
| QR/UPI URI generator | Validates merchant UPI handle and amount |
| Persistence | MongoDB support; requires user connection/configuration |
| Sandbox demo | Visual-only; no funds transferred |
| Website API | `POST /api/v1/checkout/create`, `GET /api/v1/checkout/status/:orderId` |
| Verified money confirmation | Not available until trustworthy bank/PSP integration |
| Gmail IMAP on Vercel | Explicitly disabled; not suitable for serverless |

## Using AuraPay from a website

Do not call the gateway with `x-api-key` directly in browser JavaScript; keep it in your **website server**. See `examples/website-integration.js` for a sample integration.

```http
POST /api/v1/checkout/create
x-api-key: <YOUR_SECRET_MERCHANT_API_KEY>
content-type: application/json

{"amount":100,"customerName":"Demo Customer","note":"Order #123"}
```

A successful response (once a trusted backend is configured) includes `checkoutUrl`. Redirect your customer to it. Then query the status on your backend. **Never fulfill an order on a URL callback, unverified UTR, frontend success animation, or screenshots alone.**

## Security tasks before real customer use

- Replace the demo's static original QR images rather than allowing users to scan someone else's UPI ID.
- Use a trusted bank/PSP-verified event source and cryptographically authenticated server-side notifications.
- Encrypt any sensitive mailbox tokens at rest, or use OAuth with minimal scope.
- Add robust payment reconciliation, duplicate UTR checks, request throttling, audit logs, webhook retries, and monitoring.
- Add durable object storage for QR uploads (Vercel `/tmp` is ephemeral).
- Perform independent security review and real integration tests before accepting funds.

**No claim of 100% payment success is made.** Compilation and HTTP smoke tests do not validate money settlement or banking compliance.

## Trusted bank/PSP webhook adapter

The gateway now supports `POST /api/internal/verified-payment` for **independently verified real bank credits**. This is an *adapter*, not an actual bank integration. Bank-provider credentials, onboarding, and external verification must be established separately. Never send unsigned customer claims to this endpoint.

Set a strong random `VERIFIER_WEBHOOK_SECRET` in the server's secret environment (not client code) and enable `PAYMENT_VERIFICATION_ENABLED=true` only once your approved provider's server is ready. After the provider independently confirms an actual credit, its trusted server signs the **exact JSON bytes** using HMAC SHA-256:

```text
X-AuraPay-Timestamp: <current Unix epoch seconds>
X-AuraPay-Signature: sha256=<hex(HMAC_SHA256(secret, timestamp + "." + rawBody))>
Content-Type: application/json
```

Event body:

```json
{
  "eventId": "bank-event-unique-001",
  "status": "CREDIT_CONFIRMED",
  "orderId": "PAY-00000000-0000-4000-8000-000000000000",
  "merchantId": "merch_actual_merchant_id",
  "amount": 100,
  "utr": "123456789012",
  "transactionId": "BANK_TXN_REFERENCE"
}
```

The handler validates signature and timestamp freshness (5-minute window), merchant ownership, exact amount, 12-digit UTR, duplicate references, and payment status. If it succeeds, `GET /api/v1/checkout/status/:orderId` returns `verified:true`.

**Important:** A valid HMAC proves that a holder of the webhook secret submitted the event. It does **not** independently prove a banking transaction. Only an approved provider with authoritative settlement access should hold the secret. Configure provider-level replay protection, deduplication, durable event logs and bank reconciliation before handling customer money.

The legacy Gmail/IMAP parsing and manual customer-entered UTR pathways are not accepted as authoritative payment confirmation in this build.
