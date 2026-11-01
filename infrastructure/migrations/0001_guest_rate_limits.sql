-- Migration 0001: Rate limit tracking for public guest questions (2 questions per hour per IP)
CREATE TABLE IF NOT EXISTS guest_rate_limits (
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guest_rate_limits_ip_time ON guest_rate_limits(ip_hash, created_at DESC);
