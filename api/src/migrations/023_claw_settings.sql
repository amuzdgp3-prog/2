-- Настройки клешни и целевая отдача (DECISION-090).
--
-- На плате аппарата есть меню Crane Setting → Claw Set: п.1 Strong, п.2 Medium, п.3 Weak (сила
-- клешни в вольтах) и Prize Set (игр на приз). От них зависит, сколько игрушек аппарат отдаёт.
-- Владелец задаёт целевую отдачу — долю затрат на игрушки в выручке — на типе аппарата и при
-- необходимости на самом аппарате, а система по истории настроек и отдаче советует технику, куда
-- подвинуть Weak.

-- Тип аппарата: есть ли у него это меню, цель, шаги платы и границы значений. Шаги и границы
-- Strong/Medium по умолчанию взяты из инструкции к плате; шаг Weak 0,2 В — со слов владельца;
-- границ Weak в инструкции нет, их задают на карточке типа.
ALTER TABLE machine_types
    ADD COLUMN has_claw_settings     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN target_payout_percent NUMERIC(5, 2)
        CHECK (target_payout_percent IS NULL OR (target_payout_percent > 0 AND target_payout_percent < 100)),
    ADD COLUMN claw_weak_step        NUMERIC(4, 2) NOT NULL DEFAULT 0.2 CHECK (claw_weak_step > 0),
    ADD COLUMN claw_strong_step      NUMERIC(4, 2) NOT NULL DEFAULT 1.0 CHECK (claw_strong_step > 0),
    ADD COLUMN claw_medium_step      NUMERIC(4, 2) NOT NULL DEFAULT 1.0 CHECK (claw_medium_step > 0),
    ADD COLUMN claw_weak_min         NUMERIC(5, 1),
    ADD COLUMN claw_weak_max         NUMERIC(5, 1),
    ADD COLUMN claw_strong_min       NUMERIC(5, 1) NOT NULL DEFAULT 10,
    ADD COLUMN claw_strong_max       NUMERIC(5, 1) NOT NULL DEFAULT 45,
    ADD COLUMN claw_medium_min       NUMERIC(5, 1) NOT NULL DEFAULT 10,
    ADD COLUMN claw_medium_max       NUMERIC(5, 1) NOT NULL DEFAULT 35,
    ADD CONSTRAINT machine_types_claw_weak_range
        CHECK (claw_weak_min IS NULL OR claw_weak_max IS NULL OR claw_weak_min < claw_weak_max),
    ADD CONSTRAINT machine_types_claw_strong_range CHECK (claw_strong_min < claw_strong_max),
    ADD CONSTRAINT machine_types_claw_medium_range CHECK (claw_medium_min < claw_medium_max);

-- Меню Claw Set есть у кранов с клешнёй; у Прищепки его нет (владелец, 22.10.2026). Названия —
-- как в проде; на чистой базе этих типов нет, и флаг включают на карточке типа.
UPDATE machine_types SET has_claw_settings = TRUE WHERE name IN ('МиникХ', 'Большая Хватайка');

-- Своя цель аппарата. NULL — берётся цель типа. Массовое назначение цели типу перезаписывает её.
ALTER TABLE machines
    ADD COLUMN target_payout_percent NUMERIC(5, 2)
        CHECK (target_payout_percent IS NULL OR (target_payout_percent > 0 AND target_payout_percent < 100));

-- Задача «выставить настройки клешни» при массовом назначении на тип: какие значения выставить.
-- Значение становится действующим, только когда техник подтвердит при закрытии, что выставил.
ALTER TABLE technician_tasks ADD COLUMN claw_plan JSONB;

CREATE TYPE claw_setting_source AS ENUM ('SERVICE', 'CARD', 'TASK');

-- История настроек. Строка — снимок всех значений с момента effective_at, а не одно изменённое
-- поле: действующая настройка — последняя строка, и её не нужно собирать из кусочков. NULL в
-- значении — его ещё ни разу не вносили.
--
-- Запись появляется только при изменении (так решил владелец: техник вносит показания, когда
-- поменял их на аппарате), поэтому сброс настроек платы, о котором никто не сказал, система не
-- видит — это осознанный компромисс.
CREATE TABLE claw_settings (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Идемпотентность записи с карточки при повторной отправке; у записи из обслуживания её роль
    -- играет service_id.
    local_id       UUID UNIQUE,
    machine_number TEXT NOT NULL REFERENCES machines (machine_number),
    effective_at   TIMESTAMPTZ NOT NULL,
    strong         NUMERIC(5, 1) CHECK (strong IS NULL OR strong >= 0),
    medium         NUMERIC(5, 1) CHECK (medium IS NULL OR medium >= 0),
    weak           NUMERIC(5, 1) CHECK (weak IS NULL OR weak >= 0),
    prize_set      INTEGER CHECK (prize_set IS NULL OR (prize_set >= 0 AND prize_set <= 499)),
    source         claw_setting_source NOT NULL,
    -- Обслуживание, вместе с которым пришло изменение. Удаление обслуживания администратором не
    -- стирает историю настроек: аппарат и после этого стоял с новыми значениями.
    service_id     BIGINT REFERENCES services (id) ON DELETE SET NULL,
    task_id        BIGINT REFERENCES technician_tasks (id),
    -- Совет, который система давала в момент изменения: по нему журнал пишет «по совету»,
    -- «без совета» или «против совета».
    advice         JSONB,
    entered_by     BIGINT REFERENCES staff (id),
    note           TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX claw_settings_service_uniq ON claw_settings (service_id) WHERE service_id IS NOT NULL;
CREATE INDEX claw_settings_machine_idx ON claw_settings (machine_number, effective_at DESC, id DESC);

-- История не удаляется: ошибку исправляют новой строкой.
CREATE TRIGGER claw_settings_no_delete BEFORE DELETE ON claw_settings
    FOR EACH ROW EXECUTE FUNCTION forbid_delete ();
