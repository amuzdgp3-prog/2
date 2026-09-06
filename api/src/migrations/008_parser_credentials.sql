-- DECISION-030: живая интеграция с провайдером безнала (iVend) наконец реализована — учётные
-- данные владелец аккаунта попросил хранить редактируемыми через админку, а не только в env
-- (это осознанное отступление от исходного комментария "Secrets live in runtime env, never
-- here" при 004_terminals_cashless.sql — так и должно быть, когда меняется явное требование).
ALTER TABLE parser_settings ADD COLUMN IF NOT EXISTS login TEXT;
ALTER TABLE parser_settings ADD COLUMN IF NOT EXISTS password TEXT;

INSERT INTO parser_settings (provider, is_enabled) VALUES ('ivend', FALSE)
    ON CONFLICT (provider) DO NOTHING;
