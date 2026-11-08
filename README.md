# RAYMON BOT Portal

A separate website and WhatsApp worker. Google sign-in, private WhatsApp pairing codes, a one-time 10-coin starter grant, and owner controls for coin adjustments, bans and pauses. The site uses a local SQLite ledger. The worker runs an independent copy of the RAYMON BOT command runtime bundled in `bot-runtime.tar.gz`. The bundle includes source and UI assets, with no live sessions, tokens, or databases. Extract it with `npm run build`.

## Railway deployment

Create a **new** Railway project and two services from this repository. Use one replica per service. Both services use the supplied Dockerfile.

| Setting | Portal (public) | Bot worker (private) |
| --- | --- | --- |
| Start command | `node server.js` | `node worker.js` |
| Networking | Generate an HTTPS public domain; keep the private address for the worker | No public domain |
| Volume | Mount a dedicated volume at `/data/portal` | Mount a different volume at `/data/worker` |
| Data variable | `PORTAL_DATA_DIR=/data/portal` | `WORKER_DATA_DIR=/data/worker` |
| Control token | `WORKER_TOKEN=<long random secret>` | Same `WORKER_TOKEN` |
| Portal address | `PUBLIC_ORIGIN=https://<portal-domain>` | `PORTAL_INTERNAL_URL=http://<portal-private-domain>:<portal-PORT>` |
| Other | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; optional `MAX_BOTS` (default 8, supported 1–30) | Optional `GEMINI_API_KEY` dedicated to this project |

Set the portal service's health check to `/health`. Configure the worker's internal address with the exact private DNS name and port shown by Railway. Generate the shared control token with `openssl rand -hex 32`. Store the OAuth client secret and token in Railway service variables, outside Git. Consider starting with `MAX_BOTS=2` while testing host capacity.

Create a Google OAuth **Web application** client with authorized redirect URI `https://<portal-domain>/auth/callback`. For a private test, add the owner Google account and spare test Google account to the OAuth app's test users. The first verified sign-in from the configured owner Gmail, defined in `store.js`, binds owner privileges to that Google account's immutable ID. Users sign in through Google and never provide a password to the portal.

Use a spare WhatsApp number that is absent from your existing Bot-Hosting.net deployment. Check that pairing completes and `.ping` responds; verify the 10-coin first charge, pause/resume, owner grants and removal, and suspension. Keep the existing deployment's repository, environment, number, and session directories separate. Do not copy its authentication files to this project.

## Billing behavior

- A Google account receives the starter grant once. A verified WhatsApp number binds to one portal account. Pending attempts expire after three minutes.
- The worker must verify that the connected WhatsApp identity matches the requested number. A successfully connected, eligible bot buys a 24-hour period for 10 coins. Pairing requests and failed links do not debit coins.
- When paid time expires the worker renews only while connected and with enough coins. The same paid period cannot be charged twice. If the wallet cannot renew, the bot stops and saved credentials remain. Adding enough coins to an eligible low-balance bot lets it reconnect automatically.
- Pausing manually or being banned stops the bot. The existing paid period continues to elapse. Unbanning restores dashboard actions; the user chooses Resume. If WhatsApp unlinks the session the portal offers a new code.
- Owner coin adjustments require a reason and are audited. V1 has no checkout; the owner grants and removes coins. The portal's owner role does not grant access to any user's WhatsApp messages or pairing code.
- The worker polls the web service and stops responding when its short authorization expires. Railway failures can affect portal bots; the existing Bot-Hosting.net deployment does not depend on the portal.

## Local checks

Use Node 24. Run `npm ci --ignore-scripts`, `npm run build`, and `npm test`. For a local landing page, set a random `WORKER_TOKEN` and run `npm start`. Google sign-in requires an OAuth client even locally. To start the worker locally, also set `PORTAL_INTERNAL_URL=http://localhost:3000` and run `npm run worker`. The tests mock Google and WhatsApp; they do not link a real number.
