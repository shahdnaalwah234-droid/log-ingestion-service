CREATE TABLE logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL,
    level TEXT NOT NULL,
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_logs_timestamp_id
ON logs (timestamp DESC, id DESC);

CREATE INDEX idx_logs_service_timestamp
ON logs (service, timestamp DESC);

CREATE INDEX idx_logs_level_timestamp
ON logs (level, timestamp DESC);
