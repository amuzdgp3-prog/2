# Карта web и офлайн-процессов

Дата: 24.11.2026. Проверяемая ревизия: `6be7f16da7afbcfe8234ed520cedfa9a217e132b`, ветка `master`.
Метод этого подраздела: чтение исходников и поиск в tracked-файлах. Приложение и тесты
в рамках составления карты не запускались. Пользовательские `README.md`,
`sync-from-prod.sh`, `reports/`, `research_notes/` не изменялись.

**Статус бизнес-сценариев:** точки входа установлены; поведение в этой ревизии ещё
не проверено. Ни одна описанная ниже граница покрытия сама по себе не считается дефектом.

## Экраны и роли

Регистрация маршрутов: [App.tsx:301](../../../web/src/App.tsx#L301).
Общий барьер входа — `App.tsx:162`; роли — `web/src/auth.tsx:7`.
Начальный переход ADMIN → `/log`, BOSS → `/dashboard` — `App.tsx:87`.
Клиентские ограничения не доказывают серверную авторизацию.

| Маршрут | Экран/процесс | Ограничение клиента |
| --- | --- | --- |
| `/` | `Machines.tsx`; у BOSS — `BossMachines.tsx` | Все вошедшие |
| `/sessions` | `DeviceSessions.tsx` | Все вошедшие |
| `/service/:machineNumber/:localId?` | `ServiceForm.tsx`, новое обслуживание/редактирование черновика | На уровне регистрации отдельной проверки роли нет |
| `/history/:machineNumber` | `History.tsx`, карточка, история, маршруты аппарата | На уровне регистрации отдельной проверки роли нет; изменение/удаление истории показывается ADMIN |
| `/tasks` | `Tasks.tsx`, закрытие задач | TECHNICIAN/ADMIN |
| `/queue` | `Queue.tsx`, локальные черновики и ответы администратора | TECHNICIAN/ADMIN |
| `/forgotten` | `Forgotten.tsx` | TECHNICIAN |
| `/money` | `Money.tsx`, закрытие дня, другие расходы | TECHNICIAN |
| `/cash-collections` | `CashCollections.tsx`, расчёт инкассации/получение/пересчёт | ADMIN |
| `/dashboard` | `Dashboard.tsx` | ADMIN/BOSS |
| `/owner-report` | `OwnerReport.tsx`, отчёт и xlsx | ADMIN/BOSS |
| `/log` | `ServiceLog.tsx`, фильтры/выгрузка/удаление обслуживаний | ADMIN/BOSS; доступность отдельных действий записи сверять отдельно |
| `/reports` | `Reports.tsx`, финансовый/месячный отчёты, CSV/xlsx/отправка | ADMIN |
| `/admin` | `screens/admin/index.tsx`, ленивый чанк | ADMIN |

Админка содержит 16 вкладок (`web/src/screens/admin/index.tsx:20`, `:38`): фото,
аппараты, проверка, задачи, типы, адреса, каталог, терминалы, сотрудники, игрушки,
расход, затраты, сводка расходов, безнал, расхождения, аудит.
Установка/редактирование/аренда — `screens/admin/machines/`; замена —
`screens/ReplaceMachine.tsx:49`. Фото счётчиков разбираются в
`screens/admin/CounterPhotoReview.tsx:40`: сначала PATCH обслуживания, затем POST resolve.

## Локальные данные

| Область | Реализация и ключевые точки |
| --- | --- |
| IndexedDB | Одна БД `apixspb-monitor`, версия 4; добавление хранилищ без пересоздания: `web/src/db.ts:153` |
| Каталог | `machines`, `toys`, `tasks`, `meta`: `db.ts:81`; обновление `/api/machines`, `/api/toys`, `/api/tasks?status=OPEN`: `sync.ts:168` |
| Обслуживания | `outbox`, ключ `localId`, статусы PENDING/REJECTED: `db.ts:40`, `:205`, `:273` |
| Незавершённые фото | `photoDrafts`, ключ machineNumber: `db.ts:230`, `:239`, `:255` |
| Фотографии | Фото счётчика и два фото аппарата хранятся байтами; восстановление Blob: `db.ts:69`, `:205`; защита от пустого файла/совместимость Safari: `photoBytes.ts:19` |
| Закрытие задач | `taskOutbox`, ключ taskId; локально задача сразу DONE: `db.ts:348` |
| Закрытие дня | `dayCloseOutbox`, ключ workDate: `db.ts:364` |
| Авторизация | Профиль/старый токен/маркер device session в localStorage; access token device session в памяти: `auth.tsx:25`, `api.ts:23` |
| Журнал клиента | `apixspb.clientEvents`, `apixspb.openOperations`, до 200 событий, POST порциями по 20: `clientLog.ts:32`, `:174` |

Все краткие пути в этой и следующих таблицах относятся к `web/src/`, если явно не указан другой корень.

## Полный путь синхронизации обслуживания

1. `screens/ServiceForm.tsx:363` проверяет форму, создаёт/повторно использует `localId`,
   сначала сохраняет запись и три фото в IndexedDB (`:386`).
2. При наличии сети вызывает `syncOutbox` (`:409`). Автоматический запуск также происходит
   при восстановлении сети/пользователя — `App.tsx:155`.
3. В пределах экземпляра модуля один общий `inFlight` — `sync.ts:41`.
4. Сначала отправляются закрытия задач и дня (`sync.ts:60`), затем обслуживания.
5. Фото счётчика → POST `/api/photos`; два фото аппарата → POST `/api/service-photos`;
   затем POST `/api/services`: `sync.ts:125`.
6. При успехе, включая передачу на проверку администратора, запись удаляется из outbox
   (`sync.ts:65`). Ошибка сети оставляет запись; 401 прерывает отправку; прочие 4xx
   отмечают REJECTED и сообщают `/api/draft-issues` (`:72`).
7. Завершение полной синхронизации сверяет серверный список проблем с локальными ID
   (`sync.ts:119`). Старые REJECTED по REVIEWABLE_CODES возвращаются в очередь (`db.ts:294`).
8. `screens/Queue.tsx` показывает локальные записи и `/api/service-reviews/mine`;
   ручной повтор — `:43`; удаление сопровождается best-effort DELETE draft issue (`:106`, `:153`).

API-клиент: тайм-аут обычного запроса 10 с, загрузки 60 с (`api.ts:20`), единый refresh
device session и контроль поколения сессии (`:57`, `:99`). PWA регистрируется сразу
(`main.tsx:10`); Workbox использует NetworkOnly для `/api/`, явный офлайн реализован
IndexedDB (`web/vite.config.ts:41`).

Схема порядка операций в коде:

```text
форма → IndexedDB outbox → фото счётчика → фото аппарата 1 → фото аппарата 2
      → POST /api/services → успешный ответ/IN_REVIEW → удаление из outbox → UI
```

Отдельные очереди закрытий задач и дня не используют `localId` обслуживания:
идентификаторы — taskId и workDate соответственно (`db.ts:143`, `:115`).

## Зеркальные расчёты и контракты

| Клиент | Сервер/связь | Что сверять далее |
| --- | --- | --- |
| `web/src/calc.ts:24`, `:38` | `api/src/domain/referenceCalc.ts:23`, `:56`; фактическая серверная цепочка `counterChain.ts` | Делитель, округление, цена, крупные и граничные суммы |
| `screens/ServiceForm.tsx:240` | Исторический контекст API + серверный расчёт | Превью использует `machine.price_per_game`, текущие цены игрушек и `machine.last_toy_cost`; отдельно проверить обслуживание задним числом |
| `web/src/clawAdvice.ts:105`, `:132` | `api/src/domain/clawAdvice.ts:116`, `:151` | Пороги, интервалы, советы, отображение |
| `web/src/ownerMonthReport.ts:7` | `api/src/domain/ownerMonthReport.ts:12` | Явно поддерживаемое зеркало типов; отсутствует общий пакет |
| `db.ts:294` REVIEWABLE_CODES | `api/src/commands/serviceReviews.ts` | Одинаковый набор переводимых на проверку ошибок |
| `web/src/serviceReviews.ts`, `screens/history/types.ts`, `screens/admin/types.ts`, `db.ts:5` | Контракты соответствующих API | Совместимость при обновлении API/web |
| `serviceToyCost.ts:40`, `toyCostStatus.ts:33`, `roiSplit.ts:8` | Серверные суммы и ROI | Клиентская интерпретация отсутствующих значений, пороги/цвета и представление ROI |

## Существующие проверки и пределы

- В `web/package.json:6` только `dev`, `build`, `preview`; нет test/e2e-команды,
  клиентского тестового фреймворка или браузерного runner.
- По tracked-файлам не найден повторяемый контур Playwright/Puppeteer/Cypress/Vitest/Selenium.
  Playwright фигурирует в исторических решениях и документации. Старые прогоны
  не подтверждают новую проверку этой ревизии.
- `api/tests/date_format.test.ts:3` напрямую импортирует клиентский `web/src/dateFormat.ts`.
- `api/tests/design_screens.test.ts:18` — API inject для данных экранов (ROI, список
  аппаратов, тренд); не проверяет React, DOM, прокрутку или офлайн.
- `api/tests/ui_feedback.test.ts:17` — API inject для scope/snapshot цен и делителя;
  не браузер.
- `api/tests/draft_issues.test.ts`, `service_reviews.test.ts`, `service_reviews_telegram.test.ts`,
  `device_sessions.test.ts`, `service_visit_photos.test.ts`, `photo_security.test.ts`,
  `counter_photo_checks.test.ts` — серверная база для сквозного прогона,
  но не доказательство работы browser queue.
- `api/tests/claw_advice.test.ts:4` тестирует серверную копию, не равенство клиентской.

Браузерные сценарии для следующих этапов: сохранение без сети + reload; потеря ответа
после записи; одновременная отправка из разных вкладок; разрыв между загрузками трёх
фото/сохранением обслуживания; истечение сессии на каждом шаге; смена аккаунта;
quota/ошибка IndexedDB; обновление старой версии локальной БД; Safari camera/gallery;
восстановление черновика/замена фото; визуальная проверка ролей и статусов.

## Гипотеза для проверки: принадлежность очереди

**Статус: не воспроизведено, дефект не объявлен.** Выдача `node scripts/memory.mjs topic offline`
утверждает принадлежность кэша и очереди пользователю. В текущем коде поля владельца
в `QueuedService`, `QueuedTaskClose`, `QueuedDayClose` отсутствуют (`web/src/db.ts:40`,
`:115`, `:143`), `readOutbox`/`readTaskOutbox`/`readDayCloseOutbox` читают все записи
(`:273`, `:355`, `:373`), а logout намеренно сохраняет очереди (`web/src/auth.tsx:67`,
`web/src/db.ts:381`).

Нужна отдельная проверка смены аккаунта с неотправленными данными и сверка
действующего решения: относятся ли записи к прежнему пользователю, доступны ли новому,
под чьим actor они отправляются и что делает сервер. Проверить отдельно обслуживания,
закрытия задач, закрытия дня, незавершённые фото и несколько вкладок.

Навигация по связанным решениям: тема `offline` → DECISION-003/052/085/086;
прочитать конкретные решения и поздние уточнения перед выводом о дефекте.
