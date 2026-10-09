# Generic Login and User Onboarding Module

This module provides a generic, reusable user onboarding and login system consisting of a Backend API, Web App, and Mobile App (Flutter). It implements an admin-approval flow where new users must be approved and assigned a role by a "Developer" before they can log in.

## Project Structure

- `backend/`: Node.js Express API using Prisma ORM.
- `web/`: React frontend (Vite).
- `mobile/`: Flutter mobile app.

## Prerequisites

- Node.js & npm
- Flutter SDK
- SQLite (Configured for local use by default. Can easily switch to PostgreSQL).

## Getting Started

### 1. Backend Setup

```bash
cd backend
npm install
npx prisma db push
npm run db:seed
npm run dev
```

**Environment Variables (`backend/.env`)**
- `PORT`: Server port (default: 5000)
- `DATABASE_URL`: Connection string. Defaults to `file:./dev.db` for local SQLite. Switch to `postgresql://...` for production.
- `JWT_SECRET`: Secret for signing access tokens.
- `JWT_REFRESH_SECRET`: Secret for signing refresh tokens.
- `DEFAULT_ADMIN_EMAIL`: Developer email seeded on first run (default: admin@lcgate.in).
- `DEFAULT_ADMIN_PASSWORD`: Developer password (default: admin123). **MUST change before production.**

### 2. Web App Setup

```bash
cd web
npm install
npm run dev
```
The web app runs on `http://localhost:5173`.

### 3. Mobile App Setup

```bash
cd mobile
flutter run
```

## Reusability & Configuration

To integrate this module into a new product:

1. **Branding**: Update `web/src/index.css` design tokens (`--primary`, `--secondary`, etc.) and `mobile/lib/main.dart` `AppColors`.
2. **Roles**: Update the `roles` array in `backend/prisma/seed.ts` with the specific roles required for the new product. The `Developer` role is the only mandatory role.
3. **Departments**: Modify the `<select>` options in `web/src/screens/Register.tsx` and `mobile/lib/screens/register_screen.dart`.
4. **Database**: Change the provider in `backend/prisma/schema.prisma` from `sqlite` to `postgresql` and provide a valid connection string.

## Definition of Done Validation
1. Seed script successfully seeds `admin@lcgate.in` and roles.
2. Web and Flutter use the same branding and color variables.
3. Users can register with pending status and cannot log in until approved.
4. Admin can view pending users, approve them with a role, or reject.
5. Users grouped by role in an accordion UI in existing users tab.
