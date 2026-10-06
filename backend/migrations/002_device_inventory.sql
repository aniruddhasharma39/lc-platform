-- 002_device_inventory.sql

CREATE TABLE IF NOT EXISTS master_devices (
    id SERIAL PRIMARY KEY,
    factory_device_id VARCHAR(255) UNIQUE NOT NULL,
    thing_name VARCHAR(255) UNIQUE,
    thing_arn VARCHAR(255),
    certificate_id VARCHAR(255),
    certificate_arn VARCHAR(255),
    firmware_version VARCHAR(50),
    status VARCHAR(50) DEFAULT 'FLASHED', -- FLASHED, PROVISIONED, INVENTORY, ASSIGNED, CONFIGURED, INSTALLED, ACTIVE, FAULTY, MAINTENANCE, DECOMMISSIONED
    assigned_cluster_id INTEGER,
    provisioned_at TIMESTAMP,
    last_connected TIMESTAMP,
    last_disconnected TIMESTAMP,
    connectivity_status VARCHAR(50) DEFAULT 'UNKNOWN', -- ONLINE, OFFLINE, UNKNOWN
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_events (
    id SERIAL PRIMARY KEY,
    device_id INTEGER REFERENCES master_devices(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    event_source VARCHAR(100),
    payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_allowlist (
    id SERIAL PRIMARY KEY,
    factory_device_id VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    allowed BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS device_certificates (
    id SERIAL PRIMARY KEY,
    device_id INTEGER REFERENCES master_devices(id) ON DELETE CASCADE,
    certificate_id VARCHAR(255) NOT NULL,
    certificate_arn VARCHAR(255),
    status VARCHAR(50) DEFAULT 'ACTIVE',
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP
);

-- RBAC Seed for devices
INSERT INTO permissions (name, description) VALUES
    ('devices:view', 'Allows viewing devices'),
    ('devices:create', 'Allows creating devices'),
    ('devices:update', 'Allows updating devices'),
    ('devices:decommission', 'Allows decommissioning devices'),
    ('devices:provision', 'Allows provisioning devices'),
    ('devices:connect', 'Allows connecting devices'),
    ('devices:disconnect', 'Allows disconnecting devices')
ON CONFLICT (name) DO NOTHING;

-- Assign new permissions to Super Admin role
DO $$ 
DECLARE
  superadmin_id INTEGER;
  perm_id INTEGER;
BEGIN
  SELECT id INTO superadmin_id FROM roles WHERE name = 'Super Admin';
  IF superadmin_id IS NOT NULL THEN
    FOR perm_id IN SELECT id FROM permissions WHERE name LIKE 'devices:%'
    LOOP
      INSERT INTO role_permissions (role_id, permission_id) VALUES (superadmin_id, perm_id) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;
