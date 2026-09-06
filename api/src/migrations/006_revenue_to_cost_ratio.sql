-- 006: «Отношение выручка / себестоимость» (10_ТЗ §10, 19_REMAINING_GAPS_CLOSURE_v2 §1).
--
-- ratio = revenue текущего Service / toy_cost предыдущего Service того же Placement.
-- Для первого Service Placement знаменателем является стоимость начальных игрушек Placement.
-- Если знаменатель отсутствует или равен нулю, значение остаётся NULL — «нет данных»;
-- ноль или подставное значение здесь были бы искажением финансовой картины.
--
-- Метрика вычисляется тем же расчётным слоем, что и остальная цепочка, и хранится на Service,
-- поэтому Reports, Dashboard и Export читают одно и то же число, а клиенты его не считают сами.

ALTER TABLE services
    ADD COLUMN IF NOT EXISTS revenue_to_cost_ratio NUMERIC(14, 4);

COMMENT ON COLUMN services.revenue_to_cost_ratio IS
    'Отношение выручка/себестоимость: revenue / toy_cost предыдущего Service (для первого — стоимость начальных игрушек Placement). NULL = нет данных.';
