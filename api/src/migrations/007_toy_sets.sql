-- 007: наборы игрушек и назначение аппарату/группе аппаратов.
--
-- toy_sets/toy_set_items — именованный комплект (набор) из игрушек и их количеств.
-- machines.default_toy_set_id — какой набор технику предлагается заправлять на этом аппарате по
-- умолчанию. Это подсказка для формы обслуживания, а не ограничение: реальное обслуживание может
-- содержать любые игрушки в любом количестве (toy_distributions как и раньше не ссылается на
-- набор). Наборы не удаляются физически — как и остальные бизнес-справочники в этой системе,
-- только переименовываются/меняют состав, чтобы ссылка на них из machines и из истории не рвалась.

ALTER TABLE toys
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE toy_sets (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER toy_sets_touch BEFORE UPDATE ON toy_sets
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at ();

CREATE TABLE toy_set_items (
    set_id   BIGINT NOT NULL REFERENCES toy_sets (id),
    toy_id   BIGINT NOT NULL REFERENCES toys (id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (set_id, toy_id)
);

ALTER TABLE machines
    ADD COLUMN IF NOT EXISTS default_toy_set_id BIGINT REFERENCES toy_sets (id);
