# Purchase Shipment Alert — backend

Express API + SQL Server (`Purchase_Alert`) for the Purchase Shipment Alert web app.
It sits next to `frontend/`, `database/schema.sql` and `ข้อมูล/` (see the project README).

## Run (local)
```powershell
copy .env.example .env               # then fill JWT_SECRET / SESSION_SECRET / SQL_*
npm install
npm run db:init                      # DB + ../database/schema.sql + admin@local.test / Admin@12345
npm run db:seed-master -- "../ข้อมูล/Power App for Export process R1 - backup.xlsx"
npm run db:seed-demo                 # optional demo POs and users
npm run dev                          # http://127.0.0.1:4340
npm test                             # needs a LOCAL SQL Server (uses Purchase_Alert_Test)
```

## Sign in with Microsoft 365
Off until all four `MS_*` values are set in `.env`; the login page shows the button only then.

1. Entra admin center › **App registrations › New registration**
   - Supported account types: *Accounts in this organizational directory only*
   - Redirect URI, platform **Web**: `http://127.0.0.1:4340/api/auth/microsoft/callback`
     (in production the public API address, e.g. `https://psa.company.com/api/auth/microsoft/callback`)
2. **Certificates & secrets › New client secret**, copy the *Value*.
3. **API permissions**: Microsoft Graph › delegated `openid`, `profile`, `email` (default `User.Read` can stay).
4. `.env`:
   ```
   MS_TENANT_ID=<Directory (tenant) ID>
   MS_CLIENT_ID=<Application (client) ID>
   MS_CLIENT_SECRET=<secret Value>
   MS_REDIRECT_URI=<exactly the redirect URI from step 1>
   ```

Who gets in: only people already on the **Users** page, active, with the **same email** as their
Microsoft account (`email`, or the UPN). Microsoft proves identity; this app still decides access.
Password sign-in keeps working alongside it. Lockouts, audit log (`LOGIN` with `method: MICROSOFT`),
PDPA consent and section access all apply exactly as for a password sign-in.

How it works (`src/services/microsoftAuth.js`): authorization code + PKCE, run by the API. The
id_token is verified against the tenant's signing keys (issuer, audience, tenant, nonce, expiry);
the browser then comes back to the app with a one-time, 60-second ticket that the app trades for a
normal session (`POST /api/auth/microsoft/exchange`).

## Production
Turn on the hardening flags in `.env`: `NODE_ENV=production FORCE_HTTPS=true ENABLE_HSTS=true
SESSION_COOKIE_SECURE=true SQL_ENCRYPT=true TRUST_PROXY_HOPS=<proxies in front>`.

**One origin with CSP:** the API can serve the Flutter build itself, so the browser talks to a
single origin and every page gets a strict Content-Security-Policy:
```powershell
cd ..\frontend
flutter build web --release --csp --no-web-resources-cdn --dart-define=API_BASE_URL=/api
```
then in `backend/.env`: `WEB_ROOT=../frontend/build/web` and restart. Open the app at the API
address (e.g. `https://psa.company.com/`). With a reverse proxy in front, forward `/`, `/api` and
`/ws` (WebSocket) to the API.

- `--csp`: no runtime code generation in the build. `--no-web-resources-cdn`: CanvasKit is
  bundled instead of loaded from gstatic, so nothing comes from outside (offline PCs work too).
- The CSP for the web pages is in `src/app.js` (`webCsp`): `default-src 'self'`,
  `script-src 'self' 'wasm-unsafe-eval'`, `frame-ancestors 'none'`, WebSocket only to the same host.
  API responses keep `default-src 'none'`.
- Sessions live in memory: run **one** API process.
