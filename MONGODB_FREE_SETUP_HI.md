# AuraPay – Free MongoDB Atlas setup (Hindi)

**Production payments are disabled until a genuine bank/PSP verification integration is configured and tested.** Database connection alone does not authorize live payments.

## Fastest free method: Vercel Marketplace

Your existing project: `santosh-s-projects-0d86dda4/dev-payment-gateway`  
Repository: `bjendermisra-ops/Dev-payment-gateway-`

1. Sign in to Vercel and open https://vercel.com/marketplace/mongodbatlas/atlas.
2. Click **Install** and select the Vercel team **Santosh 's projects**.
3. Choose **Create New MongoDB Atlas Account**, **Free plan ($0)** and **Free M0 cluster**. Do not choose Flex or Dedicated tiers, which are paid. MongoDB documentation says the Free installation plan does not require a credit card.
4. Choose a supported cloud region appropriate for your Vercel functions, enter a database name such as `aurapay`, and complete the creation.
5. In the integration's **Projects** section, connect the cluster to the existing **dev-payment-gateway** Vercel project (not a new template deployment).
6. The native integration should set the secret **MONGODB_URI** automatically in the linked Vercel project. Verify that its **name** is present under **Project → Settings → Environment Variables**; DO NOT share or commit its value.
7. Redeploy the Vercel project after adding the environment variable. Check `/api/health` for `storage: "mongodb"`. Check `paymentReady` remains `false` until a verified bank/PSP integration is ready.
8. Create your own merchant account with a unique strong password. No default merchant / password is provisioned.

Official guides:
- https://www.mongodb.com/docs/atlas/reference/partner-integrations/vercel/
- https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/
- https://vercel.com/docs/environment-variables/managing-environment-variables

## Manual Atlas setup (alternative)

If the Vercel integration cannot be installed, sign up at https://cloud.mongodb.com, create a project, choose **M0 Free**, create a separate app database user and an IP network access rule, then get the **Drivers → Node.js** connection string. Store it **only** as the secret `MONGODB_URI` in Vercel. Set the database name in the URI to `aurapay`. URL-encode special characters in the database password. Never paste this URI into GitHub or a ChatGPT message.

**Security tradeoff:** Vercel's dynamic outbound IPs cause the MongoDB native integration to set Atlas IP access to `0.0.0.0/0`; this allows network reachability from any IP, so strong credentials, TLS, least-privilege database roles, credential rotation, and monitoring are essential. Prefer restricted egress/private networking when available.

## Verify without exposing credentials

With a local environment variable set, run:

```bash
npm ci
npm run db:check
npm test
```

`db:check` prints status information but does not print the connection string or database password. On Vercel, inspect **Functions / Runtime Logs** and `https://dev-payment-gateway.vercel.app/api/health`.

## Before live money can be accepted

- Payment verification must come from an authenticated, authoritative bank/PSP credit event and must be tested for replay and duplicate UTRs.
- Do not enable `PAYMENT_VERIFICATION_ENABLED` until this external trusted verifier exists and has passed end-to-end checks.
- Keep `ENABLE_SIMULATIONS=false` on live deployments.
- Confirm atomic order allocation/settlement, durable audit logs, rate limits, and user authentication.
- Keep merchant API keys server-side; don't embed them in public websites.
- Gmail notification text or a manually supplied UTR is **not** authoritative proof of bank credit.
- The app currently uses temporary storage for user-uploaded QR images on Vercel. Use durable object storage before treating merchant QR uploads as production-ready.

**Current state:** Project source and Vercel build are deployed. Database connection can only be confirmed after Atlas has been provisioned and connected to Vercel.
