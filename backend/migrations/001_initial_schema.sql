-- 001_initial_schema.sql

-- Audit and App Config
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    action VARCHAR(255) NOT NULL,
    entity_type VARCHAR(255) NOT NULL,
    entity_id INTEGER,
    before_state JSONB,
    after_state JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_config (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- RBAC Foundation
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL, -- Format: module:action
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    mobile VARCHAR(20) UNIQUE,
    email VARCHAR(255) UNIQUE,
    employee_id VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'ACTIVE', -- ACTIVE, INACTIVE, LOCKED
    must_change_password BOOLEAN DEFAULT TRUE,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP,
    last_login TIMESTAMP,
    refresh_token VARCHAR(512),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Master Data
CREATE TABLE IF NOT EXISTS zones (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS divisions (
    id SERIAL PRIMARY KEY,
    zone_id INTEGER REFERENCES zones(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(zone_id, code)
);

CREATE TABLE IF NOT EXISTS sections (
    id SERIAL PRIMARY KEY,
    division_id INTEGER REFERENCES divisions(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(division_id, code)
);

CREATE TABLE IF NOT EXISTS stations (
    id SERIAL PRIMARY KEY,
    section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(section_id, code)
);

CREATE TABLE IF NOT EXISTS level_crossings (
    id SERIAL PRIMARY KEY,
    station_id INTEGER REFERENCES stations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    lc_number VARCHAR(100) UNIQUE NOT NULL,
    cluster_id INTEGER, -- Virtual group logic, usually separate table but let's assume it maps to clusters later
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Clusters (To support scope groups)
CREATE TABLE IF NOT EXISTS clusters (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Scope Groups
CREATE TABLE IF NOT EXISTS scope_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Scope Group Members (Nested groups or clusters)
CREATE TABLE IF NOT EXISTS scope_group_members (
    id SERIAL PRIMARY KEY,
    scope_group_id INTEGER REFERENCES scope_groups(id) ON DELETE CASCADE,
    member_type VARCHAR(50) NOT NULL, -- 'CLUSTER' or 'SCOPE_GROUP'
    member_cluster_id INTEGER REFERENCES clusters(id) ON DELETE CASCADE,
    member_scope_group_id INTEGER REFERENCES scope_groups(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Ensure exactly one of member_cluster_id or member_scope_group_id is NOT NULL
    CHECK (
        (member_type = 'CLUSTER' AND member_cluster_id IS NOT NULL AND member_scope_group_id IS NULL) OR
        (member_type = 'SCOPE_GROUP' AND member_scope_group_id IS NOT NULL AND member_cluster_id IS NULL)
    ),
    -- Prevent a scope group from directly containing itself
    CHECK (scope_group_id != member_scope_group_id)
);

-- Flattened Scope Group Clusters (Populated asynchronously/synchronously by engine)
CREATE TABLE IF NOT EXISTS scope_group_clusters_flat (
    scope_group_id INTEGER REFERENCES scope_groups(id) ON DELETE CASCADE,
    cluster_id INTEGER REFERENCES clusters(id) ON DELETE CASCADE,
    PRIMARY KEY (scope_group_id, cluster_id)
);

-- User Assignments
CREATE TABLE IF NOT EXISTS user_assignments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    scope_group_id INTEGER REFERENCES scope_groups(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, role_id, scope_group_id)
);
