# AuraPay database connection and rollout status

Updated: 2026-11-21

## Deployment
- GitHub: https://github.com/bjendermisra-ops/Dev-payment-gateway-
- Vercel: https://dev-payment-gateway.vercel.app
- Atlas project: AuraPay Payment Gateway
- Atlas project ID: `6b01696868e9fda276fc3952`
- Free cluster: `AuraPayFree` (AWS Mumbai, `AP_SOUTH_1`)
- Database: `aurapay`
- Collections: `merchants`, `orders`
- Dedicated application database user: `aurapay_vercel_app` (readWrite on `aurapay` only)
- Vercel environment: `MONGODB_URI` stored as an encrypted project environment variable. Never commit its value to GitHub.

## Readiness
- The free database cluster and application database account have been provisioned.
- A successful Atlas connector connection and collection creation do not by themselves prove that the running Vercel app can access Atlas. Check /api/health and deployment logs after deploying with the new environment variable.
- Payment verification stays OFF. Database connectivity is not proof of a bank credit.
- Hosted checkout creation returns 503 until durable storage and an independently trusted bank/PSP verifier are configured.
- Do not accept real customer payments before end-to-end testing and a security review.

## Vercel diagnostic
Open `https://dev-payment-gateway.vercel.app/api/health`.
Expected with a working DB connection: `"storage":"mongodb"` and `"paymentReady":false`.
If storage is not mongodb or API requests return 503, inspect Vercel Runtime Logs. Make sure Atlas M0 is ready, its network access allows the function egress, and the URI is correct. Environment changes must be included in a new Vercel deployment.

## Network access warning
Atlas currently allows `0.0.0.0/0` because Vercel Hobby functions have non-static outbound IP addresses. This is not suitable as a preferred long-term financial system network boundary. The application database account is constrained to readWrite on the one app database and the connection uses TLS. Plan private networking, static egress or stricter IP allowlisting before production. Always rotate credentials if exposure is suspected.

## Remaining before live UPI
1. Demonstrate server-side persisted registration and order records across different function instances and cold starts.
2. Implement a verifiable, authorized bank/PSP event source that can attest to actual credits; do not interpret customer-supplied UTR or simulated notifications as proof.
3. Verify idempotency, replay protections, exact amount matching and reconciliation under concurrency.
4. Run end-to-end tests with test credentials and approved bank/PSP test events; resolve any security findings.
5. Only after independently confirming all gates, turn on `PAYMENT_VERIFICATION_ENABLED` and configure the verifier secret server-side.

## Secrets
Keep MongoDB credentials, bank/PSP credentials, session signing keys and webhook HMAC secrets only in their approved secret stores. Do not share secrets over chat or copy them into source files.
