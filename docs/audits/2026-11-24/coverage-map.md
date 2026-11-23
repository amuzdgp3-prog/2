# Карта покрытия: подготовительный этап ревью, 24.11.2026

Проверяемая исходная версия: `master`, `6be7f16da7afbcfe8234ed520cedfa9a217e132b`.
Ниже зафиксированы точки входа и существующие тесты. Статус «инвентаризировано»
означает чтение регистрации/исходников; он не означает успешную проверку бизнес-сценариев.
Результаты новых прогонов фиксируются отдельно в отчёте этапа.

## API: регистрация и HTTP-поверхность

`api/src/server.ts:182–192` вызывает все 11 регистраторов маршрутов без дополнительного
`prefix`. Через TypeScript AST найдены 153 явных объявления прикладных маршрутов.
Автоматические Fastify `HEAD` и CORS `OPTIONS` в число не входят. Полный перечень с
методами, путями, точными строками объявления и механизмом аутентификации:
[api-routes.tsv](api-routes.tsv).

| Источник | Маршрутов | Назначение |
| --- | ---: | --- |
| `api/src/server.ts:177` | 1 | Health |
| `api/src/routes/auth.ts:24` | 6 | Вход, refresh/logout, управление собственными сессиями |
| `api/src/routes/catalog.ts:86` | 70 | Локации, каталоги, аппараты, игрушки, маршруты, сотрудники, терминалы, типы аппаратов |
| `api/src/routes/services.ts:72` | 24 | Обслуживания, фото счётчика, черновики, административные проверки, задачи |
| `api/src/routes/serviceVisitPhotos.ts:18` | 3 | Два фото аппарата и галерея |
| `api/src/routes/cashless.ts:12` | 10 | Безнал, импорт, повторное сопоставление, iVend |
| `api/src/routes/reports.ts:38` | 15 | Отчёты, dashboard, аудит, аномалии и отправки |
| `api/src/routes/telegramOutbox.ts:19` | 5 | Очередь внешнего Telegram-релея |
| `api/src/routes/expenses.ts:20` | 10 | Закрытие дня и расходы |
| `api/src/routes/cashCollections.ts:5` | 4 | Инкассация |
| `api/src/routes/clientEvents.ts:5` | 1 | Телеметрия клиента |
| `api/src/routes/counterPhotoChecks.ts:25` | 4 | Очередь OCR и административный разбор |

Путь запроса: `server.ts` → `routes/` → `commands/` и/или `domain/` → `db/pool.ts` →
миграции и SQL. Часть чтения и проверок находится непосредственно в роутерах;
расчёты не ограничиваются каталогом `domain/`, их продолжение нужно проверять в SQL.

Общие механизмы: `lib/scope.ts` — область доступа и guards, `lib/locks.ts` — блокировки,
`lib/audit.ts` — аудит, `lib/photos.ts` — нормализация/хранение фото,
`db/pool.ts:20` — `withTransaction`, `db/migrate.ts:9,17` — контроль/применение миграций.
Внешние интеграции выделены в `integrations/ivend.ts`, `telegram.ts`, `email.ts`.

## Аутентификация и точки входа в права

Обозначения TSV описывают подключённый механизм аутентификации, а не доказанный
перечень разрешённых ролей. Роли/владение/scope проверяются дополнительно в обработчиках,
командах и домене; для их подтверждения нужны прямые HTTP-запросы следующего этапа.

- `health`: публичный health, выполняющий чтение времени БД.
- `login`: Origin, throttling, пароль, активность сотрудника.
- `cookie-origin`: refresh/logout через cookie устройства с проверкой Origin.
- `JWT`: `app.authenticate` (`server.ts:100`) проверяет JWT и актуальную роль/активность
  сотрудника из БД, а при наличии `sid` — неотозванную и неистёкшую сессию.
- `worker`: отдельный Bearer token службы OCR (`counterPhotoChecks.ts:17–22`).
- Для `GET /api/photos/*` JWT может быть взят из query token только при
  `acceptLegacySessions=true` и отсутствии заголовка Authorization (`services.ts:333–338`).

| Область | Прочитанные проверки | Что подтвердить запросами |
| --- | --- | --- |
| Scope | `lib/scope.ts:95`: ADMIN видит всё; TECHNICIAN — выданную область; BOSS без назначений — всё, с назначениями — область | Полную матрицу ID, фильтров, истории и переназначений |
| Общий запрет BOSS | `lib/scope.ts:137` вызывается адресно, глобального запрета мутаций нет | Все записывающие маршруты, включая самообслуживание |
| Обслуживания | `commands/services.ts:257–258` — запрет BOSS и scope; `:478,557` — ADMIN для правки/удаления | Повтор, конкурентные запросы, чужой localId, исторический scope |
| Инкассация | `commands/cashCollections.ts:75,84,111,122` — ADMIN на всех четырёх операциях | Запрет ролям и гонки между получателями |
| Безнал/iVend | ADMIN на мутациях; чтение безнала использует scope; проверки parser частично в `commands/ivendSync.ts` | Прямые запросы всех ролей и исторические привязки |
| Отчёты | Общие отчёты используют scope; owner-month запрещает TECHNICIAN (`routes/reports.ts:290`); audit/аномалии требуют ADMIN (`:219,230`) | Матрицу каждого формата и отправки; комментарии к monthly-excel сами по себе права не доказывают |
| Сотрудники | `catalog.ts:959–965`: BOSS получает сокращённый список техников, ADMIN — полный; staff/scope мутации требуют ADMIN | Подмену staff ID, блокировку, отзыв сессий и последнего ADMIN |
| Фото аппарата | Upload: TECHNICIAN + scope; галерея: ADMIN; отдельное фото: ADMIN либо uploader | Доступ после переназначения и замены фото |
| OCR | pending/result — worker token; reviews/resolve — ADMIN в commands | Устаревший результат, повторная обработка, замена фото |
| Разбор обслуживаний | Административные операции — ADMIN; mine/seen связаны с сотрудником | Чужой localId, повтор одобрения/отклонения |
| Закрытие дня | JWT, `actor.id`; удаление собственной записи (`commands/dayClose.ts:171–178`) | Допустимые роли, чужие записи и повторы |
| Задачи | Создание/переоткрытие/отмена — ADMIN; список ограничивается сотрудником/scope; закрытие проверяет исполнителя | Назначение, смену роли, чужие задачи |
| Telegram-релей | ADMIN в routes/commands | Все маршруты и допустимые внешние действия |

Уточнение для сверки бизнес-правил: возврат BOSS к полной видимости после удаления
последнего назначения прямо описан в `scope.ts:86–93` как намеренное поведение.
На подготовительном этапе это не классифицируется как дефект.

## Существующие тесты API

Найдено 60 файлов `api/tests/*.test.ts`. В 55 есть вызов `bootstrap()`;
без него — `claw_advice`, `date_format`, `monthly_expense_items`,
`technician_effectiveness`, `telegram_timeout`. Наличие тестового файла не доказывает
полноту сценариев или успешность текущего прогона.

Все имена в таблице — файлы `api/tests/<имя>.test.ts`.

| Блок | Существующие тестовые файлы |
| --- | --- |
| Обслуживания и цепочка | `lifecycle`, `counter_cascade`, `counter_divisor`, `counter_monotonicity`, `counter_jump`, `future_occurred_at`, `service_log`, `context_at`, `admin_backfill_technician` |
| Финансы и отчёты | `owner_month_report`, `owner_month_roi`, `monthly_report`, `monthly_expense_items`, `cash_collections`, `expenses`, `day_close`, `dashboard`, `technician_report`, `rent_location_filter` |
| Права и сессии | `rbac_cashless_reports`, `device_sessions`, `staff_management`, `staff_list_boss`, `login_throttle`, `photo_security` |
| Конкуренция и rollback | `concurrency` |
| Черновики, разбор и задачи | `service_reviews`, `service_reviews_telegram`, `draft_issues`, `gaps_closure`, `tasks` |
| Фото и OCR | `photo_security`, `service_visit_photos`, `counter_photo_checks` |
| Безнал | `ivend_sync`, `ivend_timeout`, `ivend_html_error`, `terminal_transfer`, `terminal_similar_serial`, `terminal_unmatched_summary`, `rbac_cashless_reports` |
| Аппараты, локации и справочники | `move_machine`, `location_history`, `locationRent`, `classifiers`, `machine_types`, `machine_card`, `toy_sets` |
| Игрушки, клешня и эффективность | `toy_analysis`, `claw_settings`, `claw_advice`, `technician_effectiveness`, `technician_effectiveness_api` |
| Уведомления и диагностика | `daily_summary`, `daily_summary_queue`, `telegram_outbox`, `telegram_timeout`, `email_timeout`, `client_events`, `ui_feedback`, `design_screens`, `date_format` |

`concurrency.test.ts` уже содержит сценарии одновременного создания обслуживаний,
create/delete, деактивации, закрытия локации, переназначения терминала, rollback,
порядка блокировок нескольких аппаратов и повторного `local_id`
(`:60,95,127,173,220,286,328,352`). Их наличие опровергает старое описание
об отсутствии конкурентных тестов, но не доказывает отсутствие иных гонок.

## Границы доказательств подготовительного этапа

- Полная матрица ролей на 153 маршрутах, независимые финансовые расчёты и сверка
  решений с поведением ещё не выполнены этой инвентаризацией.
- Численное/ветвевое покрытие не измерялось; отсутствующий по названию тест не является
  доказательством отсутствия проверки внутри другого файла.
- API-тесты не доказывают IndexedDB, service worker и browser offline.
- `api/tests/helpers.ts:4–7` использует `??=` для DATABASE_URL/PHOTO_DIR; унаследованные
  значения имеют приоритет. `:26` удаляет и пересоздаёт схему `public`. До запуска
  необходимо доказать изоляцию БД и явно задать тестовое хранилище фото.
- `buildServer()` не запускает production scheduler'ы (`server.ts:197–201`), однако это
  само по себе не доказывает отсутствие прямой отправки из отдельных HTTP-сценариев.
- Это карта исходников; фактическое состояние продовой БД, ACL, таймеров и бэкапов
  данным чтением не проверено.
