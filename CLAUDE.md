# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start server (production)
node index.js <database_name>

# Start server (dev with auto-reload)
nodemon index.js <database_name>
# or via npm:
npm run dev   # requires nodemon installed globally

# database_name is required — e.g.:
node index.js anan_db

# Deploy Flutter web frontend: copy flutter build output here
# (run from anan/ Flutter project)
flutter build web
cp -r build/web ../anan_backend/build/web
```

## Architecture Overview

Node.js + Express backend for the **ANAN System** ERP. Uses PostgreSQL via the `pg` library. Runs on port **8888** (configurable via `PORT` env var).

### Multi-Database Architecture

The system supports multiple company databases on the same PostgreSQL server. Each API request carries an `X-Database-Name` header; `middlewares/dbMiddleware.js` resolves this to a pooled `pg.Pool` instance stored in `req.dbPool`. `services/saDatabaseService.js` maintains a dictionary of pools keyed by database name and uses a master `postgres` database connection to enumerate available databases.

### Project Structure

```
index.js              # Express app entry point — mounts routes, serves Flutter web static files
config/db.js          # Single-pool config (legacy, not used by multi-db middleware)
middlewares/
  dbMiddleware.js     # Injects req.dbPool from X-Database-Name header
routes/
  sa.js               # /api/sa — System Admin
  cd.js               # /api/cd — Common Data
  gl.js               # /api/gl — General Ledger
controllers/
  sa/                 # saAuthController, saUserController, saMenuController, ...
  cd/                 # cdBranchController, cdCurrencyController, ...
  gl/                 # glEntryController, glPeriodController, glFinancialReportEngineController, ...
services/
  saDatabaseService.js   # Multi-db pool management + getDatabases()
  saBackupService.js     # Scheduled backup jobs via node-schedule
  saPasswordPolicyService.js
utils/
public/               # Uploaded files (company logos, etc.)
build/web/            # Flutter web static output (served by Express)
```

### Module Routes

| Prefix | Module | Key resources |
|--------|--------|---------------|
| `/api/sa` | System Admin | `/auth/login`, `/auth/check_token`, `/sa_user`, `/sa_group`, `/sa_menu`, `/sa_company`, `/sa_module_document`, `/databases` |
| `/api/cd` | Common Data | `/cd_branch`, `/cd_currency`, `/cd_business_unit`, `/cd_project`, `/cd_zipcode` |
| `/api/gl` | General Ledger | `/gl_entry`, `/gl_period`, `/gl_account`, `/gl_beginning_balance`, `/gl_trial_balance`, `/gl_financial_report`, `/gl_general_ledger` |

### Authentication

JWT-based. `saAuthController.login` issues a token; `saAuthController.verifyToken` is called by the Flutter app on startup to validate stored tokens. Auth middleware (in `routes/sa.js`) protects all routes except `/auth/login`, `/auth/check_token`, and `/databases`.

### Serving the Frontend

`index.js` serves `build/web/` as static files and uses `connect-history-api-fallback` to support Flutter web's client-side routing, with a rewrite rule to exclude `/api/*` paths from the fallback.

**Deploy frontend (production):**
```bash
# รันจาก anan/ Flutter project
flutter build web
xcopy /E /Y build\web\* ..\anan_backend\build\web\
```
เมื่อ deploy แล้วต้องแก้ `lib/config/app_config.dart` ใน Flutter ให้ `baseHost = ''` ก่อน build

**Dev mode:** Flutter รันบน port ของตัวเอง ต้องตั้ง `baseHost = 'http://localhost:8888'` ใน `app_config.dart` เพื่อให้ชี้มาที่ backend ได้ถูกต้อง

### Environment Variables (`.env`)

```
DB_USER=
DB_HOST=localhost
DB_NAME=          # default database for startup checks
DB_PASSWORD=
DB_PORT=5432
PORT=8888
TZ=Asia/Bangkok
JWT_SECRET=
```
