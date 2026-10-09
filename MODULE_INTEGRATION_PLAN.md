# Dynamic Role-Based Module System: Integration & Development Plan

This document outlines the architecture and workflow for developing and integrating dynamic modules (e.g., "Cluster") into the LC Platform. It is designed to allow team members to develop features in parallel, which can then be dynamically assigned to roles via the Developer Console.

## 1. Architecture Overview

To achieve a dynamic, role-based sidebar where features (Modules) appear only if the user's role has access to them, we need to shift from hardcoded sidebar links to a configuration-driven UI.

### Database (Prisma)
We will introduce two new entities to the schema:
- **`Module`**: Represents a feature (e.g., `id: 1, name: 'Cluster', slug: 'cluster', icon: 'server'`).
- **`RoleModuleAccess`**: A mapping table linking `Role` to `Module`.

### Backend (Node.js/Express)
- **Developer Console APIs**: Endpoints to create/edit modules and assign them to roles.
- **User Context API**: When a user logs in (or fetches their profile), the backend will return a list of `allowedModules` based on their role.

### Frontend (React Web & Flutter Mobile)
- **Dynamic Sidebar**: The sidebar will no longer hardcode links (except for 'Home' and 'Logout'). Instead, it will iterate over the `allowedModules` array received from the backend and render the respective options.
- **Component Mapping**: A central registry/switch statement will map a module's `slug` (e.g., `'cluster'`) to its corresponding UI Component/Screen.

---

## 2. Guide for Team Members: Developing a New Module (e.g., "Cluster")

When assigned to develop a new module, follow these steps to ensure seamless integration:

### Step 1: Backend Development
1. **Routes & Controllers**: Create a new file in `backend/src/routes/cluster.ts` for the module's specific APIs.
2. **Database Models**: If the module requires new tables (e.g., `Cluster`, `ClusterNode`), define them in `schema.prisma`.
3. **Integration**: Export the router and mount it in `backend/src/index.ts` (e.g., `app.use('/api/v1/cluster', clusterRoutes)`).

### Step 2: Web Application (React)
1. **Component Creation**: Create your feature in a self-contained folder: `web/src/screens/Cluster/`.
2. **Entry Point**: Ensure there is a main entry component (e.g., `ClusterDashboard.tsx`) that handles all sub-navigation and UI for that module.
3. **Integration Ready**: Expose this component so it can be plugged into the main `Dashboard.tsx` view switcher.

### Step 3: Mobile Application (Flutter)
1. **Screen Creation**: Create your feature in `mobile/lib/screens/cluster/`.
2. **Entry Point**: Create a main widget (e.g., `ClusterMainScreen.dart`).
3. **Integration Ready**: Ensure it accepts necessary props (like the user token) and can be plugged into the `dashboard_screen.dart` view logic.

---

## 3. How We Will Integrate Your Module

Once the team member finishes the module, the Lead/Integrator will perform the following "wiring" steps:

### A. Register the Module in Developer Console
Through the Developer Console UI, we will add a new Module:
- **Name**: Cluster
- **Slug**: `cluster`
Then, we will assign this module to specific roles (e.g., "System Admin", "IT Support").

### B. UI Wiring (Web - `Dashboard.tsx`)
```tsx
// 1. Add the component import
import ClusterDashboard from './Cluster/ClusterDashboard';

// 2. The sidebar will automatically render the 'Cluster' button if the user has access.
// (Sidebar dynamically maps through user.allowedModules)

// 3. Add to the view switcher in the main content area:
{currentView === 'cluster' && <ClusterDashboard user={user} />}
```

### C. UI Wiring (Mobile - `dashboard_screen.dart`)
```dart
// 1. Add the import
import 'cluster/cluster_main_screen.dart';

// 2. The Drawer will automatically render the 'Cluster' tile if the user has access.

// 3. Add to the body switcher:
Widget _buildBody() {
  if (_currentView == 'cluster') return ClusterMainScreen();
  // ... existing views
}
```

## Summary
By following this plan, developers can work on the UI and backend logic of their specific modules in complete isolation. The core application acts as a "shell" that dynamically loads these modules based on the access controls defined in the Developer Console.
