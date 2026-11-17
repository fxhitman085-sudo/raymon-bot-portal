# RAYMON BOT Portal

A separate website and WhatsApp worker. Email and password sign-in, private WhatsApp pairing codes, a one-time 10-coin starter grant, and owner controls for coin adjustments, bans and pauses. The site uses a local SQLite ledger. The worker runs an independent copy of the RAYMON BOT command runtime bundled in `bot-runtime.tar.gz`. The bundle includes source and UI assets, with no live sessions, tokens, or databases. Extract it with `npm run build`.

## Railway deployment

Deploy the portal from this repository using the supplied Dockerfile. On Railway, `npm start` or `node server.js` starts the website and its pairing worker together by default. Use one replica and the existing public domain and `WORKER_TOKEN`. Keep `PORTAL_DATA_DIR` pointed at its existing persistent volume so accounts and balances survive redeployments. By default, worker sessions are stored in the `worker` directory under `PORTAL_DATA_DIR`. If `WORKER_DATA_DIR` is set, point it at persistent storage too.

On the combined service, the default data directory is `/app/data/portal`. Before redeploying an existing service, verify that its volume covers the configured database and session paths. If the existing deployment uses ephemeral storage, take a consistent SQLite backup and a private backup of the `worker` directory before adding a volume or redeploying. Restore both into the persistent paths before allowing sign-ups or pairing. With no explicit `PORTAL_DATA_DIR`, the portal uses `RAILWAY_VOLUME_MOUNT_PATH` if the volume does not already cover the default directory. A new combined service can mount its volume at `/app/data/portal`. Startup logs warn when the configured directories are outside the Railway volume.

Set the health check to `/health`. After deployment, check the logs for `Portal pairing worker connected to the portal.` and request a fresh pairing code from the dashboard. The combined service uses a loopback connection and determines its port automatically.

### Optional separate worker service

For an existing two-service deployment, set `PORTAL_RUN_WORKER=0` on the website to keep running the worker separately. Use one replica per service.

| Setting | Portal (public) | Bot worker (private) |
| --- | --- | --- |
| Start command | `node server.js` | `node worker.js` |
| Networking | Generate an HTTPS public domain; keep the private address for the worker | No public domain |
| Volume | Mount a dedicated volume at `/data/portal` | Mount a different volume at `/data/worker` |
| Data variable | `PORTAL_DATA_DIR=/data/portal` | `WORKER_DATA_DIR=/data/worker` |
| Control token | `WORKER_TOKEN=<long random secret>` | Same `WORKER_TOKEN` |
| Portal address | `PUBLIC_ORIGIN=https://<portal-domain>` | `PORTAL_INTERNAL_URL=http://<portal-private-domain>:<portal-PORT>` |
| Other | Optional `MAX_BOTS` (default 8, supported 1–30) | Optional `GEMINI_API_KEY` dedicated to this project |

Set the portal service's health check to `/health`. Configure the worker's internal address with the exact private DNS name and port shown by Railway. Generate the shared control token with `openssl rand -hex 32`. Store both tokens in Railway service variables, outside Git. Consider starting with `MAX_BOTS=2` while testing host capacity.

The Founder is the existing account pinned in the SQLite `owner` table. Public signup creates regular accounts only. For an existing installation, retain the current database when deploying Version 3.0. The server no longer reads `OWNER_SIGNUP_TOKEN`.

The migration preserves account IDs, balances, bot deployments, and valid sessions on the existing database. A user still signed in from the old system can set a password in their dashboard. Password recovery is available for accounts with password sign-in configured.

### Password recovery and low-balance email

Set `RESEND_API_KEY` and `PORTAL_EMAIL_FROM` on the website service. Use an email address on a verified Resend sending domain for `PORTAL_EMAIL_FROM`, such as `Raymon Bot <portal@example.com>`. Keep the API key in Railway variables. `PUBLIC_ORIGIN` must match the live portal domain because reset emails link back to it.

Use **Forgot password?** on the sign-in page. Reset links expire after 30 minutes and a successful reset signs out existing sessions. The dashboard warns when an active bot has fewer than 10 coins within six hours of renewal. If email is configured, the portal also sends one warning per affected paid period to the account email. The dashboard warning works with no email configuration.

Use a spare WhatsApp number that is absent from your existing Bot-Hosting.net deployment. Check that pairing completes and `.ping` responds; verify the 10-coin first charge, pause/resume, owner grants and removal, and suspension. Keep the existing deployment's repository, environment, number, and session directories separate. Do not copy its authentication files to this project.

## Billing behavior

- A portal account receives the starter grant once. A verified WhatsApp number binds to one portal account. Pending attempts expire after three minutes.
- The worker must verify that the connected WhatsApp identity matches the requested number. A successfully connected, eligible bot buys a 24-hour period for 10 coins. Pairing requests and failed links do not debit coins.
- When paid time expires the worker renews only while connected and with enough coins. The same paid period cannot be charged twice. If the wallet cannot renew, the bot stops and saved credentials remain. Adding enough coins to an eligible low-balance bot lets it reconnect automatically.
- Pausing manually or being banned stops the bot. The existing paid period continues to elapse. Unbanning restores dashboard actions; the user chooses Resume. If WhatsApp unlinks the session the portal offers a new code.
- Owner coin adjustments require a reason and are audited. Buy Coins has no checkout. Authorized admins can adjust coins, and the Founder can issue promotional codes. The portal's owner role does not grant access to any user's WhatsApp messages or pairing code.
- Users can send whole coins to another active password-enabled account using its portal email. Both wallets get a ledger entry and the transfer completes as one transaction.
- The worker polls the web service and stops responding when its short authorization expires. Railway failures can affect portal bots; the existing Bot-Hosting.net deployment does not depend on the portal.

## Local checks

Use Node 24. Run `npm ci --ignore-scripts`, `npm run build`, and `npm test`. Set a random `WORKER_TOKEN` and run `npm start` for the website. Set `PORTAL_RUN_WORKER=1` to run both locally. To run the worker separately, set `PORTAL_INTERNAL_URL=http://localhost:3000` and run `npm run worker`. The tests exercise password sign-in and mock WhatsApp; they do not link a real number.

## Keep website-deployed bots on the same release

The **Sync RAYMON BOT** workflow reads `variefx-alt/raymon-whatsapp-bot/main`. It checks for changes approximately every 30 minutes and can also be run on demand from Actions. A `repository_dispatch` event of type `raymon-bot-updated` can trigger it immediately from the source repository. It only publishes a new portal commit after the tests and Docker build pass.

Add two secrets in the portal repository under **Settings → Secrets and variables → Actions**:

| Secret | GitHub account | Repository and permission |
| --- | --- | --- |
| `BOT_READ_TOKEN` | `variefx-alt` | `raymon-whatsapp-bot`, Contents read |
| `PORTAL_SYNC_TOKEN` | The portal GitHub account linked to Railway | `raymon-bot-portal`, Contents read and write |

Use repository-scoped fine-grained tokens. Paste the values into GitHub Actions secrets. Run **Sync RAYMON BOT** once and check the GitHub run and Railway deployment. Source dependency changes require a compatible portal lockfile before the workflow will publish. On success `bot-runtime-version.json` records the exact upstream commit; older bundles are unversioned. Visit the portal’s `/version` endpoint to see which source commit production is running.

Railway should remain connected to portal `main` with autodeploy enabled. The portal worker restarts on each deployment and opens eligible saved sessions from the existing volume with the new bundle, so website users keep their WhatsApp linking and settings.

## Version 3.0

- Open **Support Tickets** for the personal inbox and screenshots. Staff use **Admin Dashboard → Support inbox**. Reply, assign, and close permissions also require inbox access.
- Redeem promo codes in **My Coins**. The Founder configures codes and their activation, expiry, reward and redemption limit under **Founder Dashboard → Promotional Coin Codes**.
- New users can follow the setup guide from the dashboard. Restart it under **My Profile → Profile Information**.
- The referral leaderboard uses Lagos time. Weekly rounds start Monday. A referral qualifies when an invitee brings a unique WhatsApp number online with an active paid period. Historical qualification uses records available at migration. Existing referral bonuses retain their configured trigger. The Founder can set prizes independently for each period. Automatic awards run for closed daily, weekly, and monthly rounds. All-time awards use one Founder-approved settlement.
- The Founder can appoint staff through **Search users → Manage** and configure each rank independently under **Administrators and Permissions**. All ranks start with no permissions. The **Admin Activity Log** shows Version 3.0 staff changes and privileged actions.
