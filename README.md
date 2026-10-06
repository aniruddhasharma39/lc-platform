# Level Crossing Device Lifecycle Platform

This monorepo contains the infrastructure for managing AWS IoT devices for level crossings.

## Architecture
- **Console**: React web application (Vite)
- **Mobile**: Flutter application for field workers
- **Backend**: Node.js API and Event Worker
- **Simulator**: Node.js IoT Device Simulator

## Data Model (Aurora PostgreSQL)
- Users, Roles, RBAC
- Devices, Clusters, Scopes
- Telemetry & Alerts

## Setup Phase 0
1. Set up AWS IoT Core and provision certificates.
2. Register SMS DLT templates for notifications.
3. Configure Aurora PostgreSQL cluster.

## Getting Started
Run `./setup.sh` to initialize the project dependencies.
