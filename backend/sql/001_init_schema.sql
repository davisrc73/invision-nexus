-- ============================================================================
-- INVISION NEXUS (FNAC & DARTY) - POSTGRESQL 16 ENTERPRISE SCHEMA
-- Fase 2: DDL Completo + Particionamento Mensal + Dados Seed Iniciais
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. HIERARQUIA ORGANIZACIONAL & PARQUE DE DISPOSITIVOS
-- ----------------------------------------------------------------------------

CREATE TABLE brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL CHECK (code IN ('FNAC', 'DARTY')),
    name VARCHAR(100) NOT NULL,
    theme_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE regions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'Europe/Lisbon',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    region_id UUID NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
    store_code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    -- Horário de funcionamento para supressão inteligente de alertas OFFLINE em bancadas Expo
    opening_hours JSONB NOT NULL DEFAULT '{"open": "09:00", "close": "23:00", "days": [1,2,3,4,5,6,7]}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE store_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    zone_type VARCHAR(50) NOT NULL CHECK (zone_type IN (
        'ENTRANCE_LEDWALL', 'IT_COMPUTERS', 'TELECOM_MOBILES',
        'TV_VIDEO', 'GAMING', 'CHECKOUT', 'CULTURE_BOOKS', 'APPLIANCES'
    )),
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE screen_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) UNIQUE NOT NULL,
    width_px INT NOT NULL CHECK (width_px > 0),
    height_px INT NOT NULL CHECK (height_px > 0),
    aspect_ratio VARCHAR(20) NOT NULL,
    orientation VARCHAR(20) NOT NULL CHECK (orientation IN ('LANDSCAPE', 'PORTRAIT', 'CUSTOM_LED')),
    aspect_tolerance_pct NUMERIC(4,2) NOT NULL DEFAULT 2.00,
    allowed_codecs TEXT[] NOT NULL DEFAULT ARRAY['h264', 'hevc', 'vp9', 'webp', 'png', 'jpeg'],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sync_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_zone_id UUID NOT NULL REFERENCES store_zones(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    master_device_id UUID NULL,
    sync_mode VARCHAR(30) NOT NULL DEFAULT 'NTP_TIMECODE' CHECK (sync_mode IN ('NTP_TIMECODE', 'WS_BROADCAST')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NULL REFERENCES stores(id) ON DELETE SET NULL,
    store_zone_id UUID NULL REFERENCES store_zones(id) ON DELETE SET NULL,
    sync_group_id UUID NULL REFERENCES sync_groups(id) ON DELETE SET NULL,
    screen_profile_id UUID NULL REFERENCES screen_profiles(id) ON DELETE RESTRICT,
    device_category VARCHAR(30) NOT NULL DEFAULT 'ANDROID_BOX' CHECK (device_category IN (
        'ANDROID_BOX', 'LEDWALL', 'TV_DEMO', 'LAPTOP_EXPO', 'TABLET_EXPO', 'SMARTPHONE_EXPO'
    )),
    hardware_uid VARCHAR(128) UNIQUE NOT NULL,
    pairing_code VARCHAR(16) UNIQUE NULL,
    pairing_expires_at TIMESTAMPTZ NULL,
    device_token_hash TEXT NULL,
    name VARCHAR(150) NOT NULL DEFAULT 'Terminal Não Emparelhado',
    interaction_mode VARCHAR(30) NOT NULL DEFAULT 'PASSIVE' CHECK (interaction_mode IN (
        'PASSIVE', 'IDLE_SCREENSAVER', 'INTERACTIVE_CATALOG'
    )),
    idle_timeout_sec INT NOT NULL DEFAULT 45,
    status VARCHAR(25) NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN (
        'PENDING_APPROVAL', 'ONLINE', 'OFFLINE', 'MAINTENANCE'
    )),
    storage_free_bytes BIGINT NOT NULL DEFAULT 0,
    storage_total_bytes BIGINT NOT NULL DEFAULT 68719476736, -- 64GB default
    current_manifest_hash VARCHAR(64) NULL,
    app_version VARCHAR(30) NULL,
    last_seen_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_devices_store_status ON devices(store_id, status);
CREATE INDEX idx_devices_pairing_code ON devices(pairing_code) WHERE pairing_code IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. UTILIZADORES, RBAC & INCIDENTES DE LOJA
-- ----------------------------------------------------------------------------

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN (
        'GLOBAL_ADMIN', 'IT_OPS', 'MEDIA_MANAGER', 'STORE_MANAGER', 'DEPT_HEAD'
    )),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_scopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    brand_id UUID NULL REFERENCES brands(id) ON DELETE CASCADE,
    store_id UUID NULL REFERENCES stores(id) ON DELETE CASCADE,
    store_zone_id UUID NULL REFERENCES store_zones(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_scopes_user ON user_scopes(user_id);

CREATE TABLE device_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    reported_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    incident_type VARCHAR(40) NOT NULL CHECK (incident_type IN (
        'SCREEN_OFF', 'WRONG_CONTENT', 'OUTDATED_PRICE', 'SYNC_DRIFT', 'HARDWARE_DAMAGE'
    )),
    description TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
    resolved_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    resolution_notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_incidents_device_status ON device_incidents(device_id, status);

CREATE TABLE device_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    issued_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    command_type VARCHAR(40) NOT NULL CHECK (command_type IN (
        'REBOOT', 'CLEAR_CACHE', 'FORCE_SYNC', 'KILL_SWITCH', 'SET_ORIENTATION'
    )),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'EXECUTED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ NULL
);

-- ----------------------------------------------------------------------------
-- 3. MEDIA ASSETS, CAMPANHAS, PLAYLISTS (SLOTS & SOV) & AGENDAMENTOS
-- ----------------------------------------------------------------------------

CREATE TABLE media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    title VARCHAR(200) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    thumb_path TEXT NULL,
    sha256_hash CHAR(64) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    mime_type VARCHAR(60) NOT NULL,
    width_px INT NOT NULL,
    height_px INT NOT NULL,
    aspect_ratio VARCHAR(20) NOT NULL,
    duration_ms INT NOT NULL DEFAULT 10000,
    codec_info VARCHAR(100) NOT NULL,
    valid_from TIMESTAMPTZ NULL,
    valid_until TIMESTAMPTZ NULL,
    is_fallback_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    uploaded_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_brand_hash ON media_assets(brand_id, sha256_hash);

CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    supplier_reference VARCHAR(100) NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE playlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    campaign_id UUID NULL REFERENCES campaigns(id) ON DELETE SET NULL,
    name VARCHAR(200) NOT NULL,
    target_screen_profile_id UUID NOT NULL REFERENCES screen_profiles(id) ON DELETE RESTRICT,
    priority_level VARCHAR(20) NOT NULL DEFAULT 'NORMAL' CHECK (priority_level IN (
        'EXCLUSIVA', 'PRIORITARIA', 'NORMAL', 'FALLBACK'
    )),
    scheduling_mode VARCHAR(25) NOT NULL DEFAULT 'FIXED_SLOTS' CHECK (scheduling_mode IN (
        'FIXED_SLOTS', 'DYNAMIC_SOV'
    )),
    total_slots INT NULL CHECK (total_slots IS NULL OR total_slots > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE playlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    slot_position INT NULL,
    sov_percentage NUMERIC(5,2) NULL CHECK (sov_percentage IS NULL OR (sov_percentage > 0 AND sov_percentage <= 100)),
    custom_duration_ms INT NULL,
    scaling_policy VARCHAR(20) NOT NULL DEFAULT 'CONTAIN' CHECK (scaling_policy IN ('CONTAIN', 'COVER', 'STRETCH')),
    force_format_override BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id);

CREATE TABLE schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    target_type VARCHAR(30) NOT NULL CHECK (target_type IN (
        'BRAND_ALL', 'REGION', 'STORE', 'STORE_ZONE', 'SYNC_GROUP', 'DEVICE_CATEGORY', 'DEVICE'
    )),
    target_id UUID NULL,
    target_device_category VARCHAR(30) NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_of_week SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
    daypart_start_time TIME NOT NULL DEFAULT '00:00:00',
    daypart_end_time TIME NOT NULL DEFAULT '23:59:59',
    pre_download_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_schedules_target ON schedules(target_type, target_id, start_date, end_date);

-- ----------------------------------------------------------------------------
-- 4. CATÁLOGO INTERATIVO PARA TVS EM EXPOSIÇÃO (TV DEMO MODE)
-- ----------------------------------------------------------------------------

CREATE TABLE tv_demo_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    icon_name VARCHAR(50) NOT NULL DEFAULT 'tv',
    display_order INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tv_demo_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES tv_demo_categories(id) ON DELETE CASCADE,
    media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    highlight_specs JSONB NOT NULL DEFAULT '{"resolution": "4K UHD", "fps": "60fps"}'::jsonb,
    display_order INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 5. TELEMETRIA PARTICIONADA (PROOF OF PLAY & INTERAÇÕES TOUCH/DEMO - 1 ANO)
-- ----------------------------------------------------------------------------

CREATE TABLE pop_logs_hourly (
    hour_bucket TIMESTAMPTZ NOT NULL,
    device_id UUID NOT NULL,
    store_id UUID NOT NULL,
    brand_id UUID NOT NULL,
    campaign_id UUID NULL,
    playlist_id UUID NOT NULL,
    media_asset_id UUID NOT NULL,
    play_count INT NOT NULL DEFAULT 0,
    total_duration_ms BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (hour_bucket, device_id, playlist_id, media_asset_id)
) PARTITION BY RANGE (hour_bucket);

CREATE TABLE interaction_logs_hourly (
    hour_bucket TIMESTAMPTZ NOT NULL,
    device_id UUID NOT NULL,
    store_id UUID NOT NULL,
    brand_id UUID NOT NULL,
    device_category VARCHAR(30) NOT NULL,
    interaction_type VARCHAR(40) NOT NULL CHECK (interaction_type IN (
        'TOUCH_WAKE', 'TV_CATEGORY_SELECT', 'TV_VIDEO_PLAY'
    )),
    reference_key VARCHAR(64) NOT NULL DEFAULT 'GLOBAL',
    interaction_count INT NOT NULL DEFAULT 0,
    total_engaged_seconds INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (hour_bucket, device_id, interaction_type, reference_key)
) PARTITION BY RANGE (hour_bucket);

-- Partições Default e Ano Corrente (2026 / 2027) para arranque imediato
CREATE TABLE pop_logs_hourly_2026_11 PARTITION OF pop_logs_hourly
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE pop_logs_hourly_2026_12 PARTITION OF pop_logs_hourly
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE pop_logs_hourly_default PARTITION OF pop_logs_hourly DEFAULT;

CREATE TABLE interaction_logs_hourly_2026_11 PARTITION OF interaction_logs_hourly
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE interaction_logs_hourly_2026_12 PARTITION OF interaction_logs_hourly
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE interaction_logs_hourly_default PARTITION OF interaction_logs_hourly DEFAULT;

-- ----------------------------------------------------------------------------
-- 6. SEED DATA INICIAL (FNAC & DARTY + PERFIS DE ECRÃ + LOJAS PILOTO)
-- ----------------------------------------------------------------------------

INSERT INTO brands (id, code, name, theme_config) VALUES
    ('11111111-1111-1111-1111-111111111111', 'FNAC', 'Fnac', '{"primaryColor": "#E1A924", "bgColor": "#111111"}'),
    ('22222222-2222-2222-2222-222222222222', 'DARTY', 'Darty', '{"primaryColor": "#E30613", "bgColor": "#FFFFFF"}')
ON CONFLICT (code) DO NOTHING;

INSERT INTO screen_profiles (id, name, width_px, height_px, aspect_ratio, orientation, aspect_tolerance_pct) VALUES
    ('aaaa1111-1111-1111-1111-111111111111', 'Standard TV / Box Landscape (16:9 FullHD)', 1920, 1080, '16:9', 'LANDSCAPE', 1.50),
    ('aaaa2222-2222-2222-2222-222222222222', 'TV Exposição 4K UHD (16:9)', 3840, 2160, '16:9', 'LANDSCAPE', 1.50),
    ('aaaa3333-3333-3333-3333-333333333333', 'Mupi Digital / Smartphone Vertical (9:16)', 1080, 1920, '9:16', 'PORTRAIT', 2.00),
    ('aaaa4444-4444-4444-4444-444444444444', 'LEDwall Entrada Loja Ultra-Wide (32:9)', 3840, 1080, '32:9', 'CUSTOM_LED', 0.50)
ON CONFLICT (name) DO NOTHING;

