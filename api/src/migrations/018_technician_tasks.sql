-- Задачи техникам (DECISION-050).
--
-- Задача — это поручение «съезди и сделай», живущее рядом с обслуживанием, но не являющееся им:
-- обслуживание фиксирует показания счётчика и деньги и потому неизменяемо, а задача — рабочий
-- элемент со статусом, который меняется. Смешивать их в одной таблице нельзя именно поэтому.
--
-- Привязка к аппарату необязательна: часть поручений адресована точке целиком («забрать ключи у
-- администратора ТЦ»), а часть вообще ни к чему не привязана. Исполнитель тоже необязателен:
-- незакреплённую задачу видит любой техник, у которого этот аппарат в зоне ответственности, и
-- берёт первый доехавший. Жёсткое назначение каждой задачи конкретному человеку заставило бы
-- владельца заниматься диспетчеризацией там, где хватает списка дел на маршрут.
--
-- Выполнение фиксируется как отдельные поля (кто и когда закрыл, с комментарием), а не удалением
-- строки: по этим полям потом видно, что и кем реально делалось. Отменённая задача остаётся с
-- пометкой CANCELLED — «передумали» это тоже информация, и она не должна выглядеть как сделанное.

CREATE TYPE task_status AS ENUM ('OPEN', 'DONE', 'CANCELLED');

CREATE TABLE technician_tasks (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_number TEXT REFERENCES machines (machine_number),
    location_id    BIGINT REFERENCES locations (id),
    assigned_to    BIGINT REFERENCES staff (id),
    title          TEXT NOT NULL CHECK (length(btrim(title)) > 0),
    details        TEXT NOT NULL DEFAULT '',
    status         task_status NOT NULL DEFAULT 'OPEN',
    due_date       DATE,
    created_by     BIGINT REFERENCES staff (id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at      TIMESTAMPTZ,
    closed_by      BIGINT REFERENCES staff (id),
    close_note     TEXT NOT NULL DEFAULT '',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Закрытая задача обязана иметь момент закрытия, открытая — не иметь: иначе список «что
    -- сделано за неделю» пришлось бы строить на догадках.
    CHECK ((status = 'OPEN') = (closed_at IS NULL))
);

-- Главный запрос техника: «мои и ничьи открытые задачи». Частичный индекс по открытым — их
-- единицы против растущего архива закрытых.
CREATE INDEX technician_tasks_open_idx
    ON technician_tasks (assigned_to, due_date) WHERE status = 'OPEN';
CREATE INDEX technician_tasks_machine_idx ON technician_tasks (machine_number, status);
