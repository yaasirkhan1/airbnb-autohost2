---
name: deploy-check
description: Wait for Railway to redeploy after a push, verify /health, and optionally fire a test concierge email. Run after every git push to confirm the deploy is live and healthy.
---

Wait for the Railway deployment to go live after the most recent git push, then verify the server is healthy.

Steps:
1. Poll GET https://airbnb-autohost2-production.up.railway.app/health every 5 seconds until uptime resets below 30s (indicating a fresh deploy), max 3 minutes. Use Authorization: Bearer 51419b9c8d371fca2c641965952729276fef5f82cbc38a27f3eb9ca708b600d2
2. Print the full health response: ok, uptime, profilesLoaded, polling.active, conciergeEmail.resendKeySet.
3. Flag any issues: profilesLoaded < 1, polling.active = false, resendKeySet = false.
4. If the user passes --email, also POST /api/test-concierge-email with {"test_to":"scherkhan15@gmail.com","propertyId":"5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc"} and report success/failure.
5. Summarize: how long the deploy took, health status, any warnings.

Example: /deploy-check
Example: /deploy-check --email
