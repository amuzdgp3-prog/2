import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  calcNewGames,
  calcRevenue,
  computeOverdue,
  daysSince,
  formatGames,
  formatMoney,
  normalizeDivisor,
} from '../calc';
import { MachineTag } from '../components/ui/MachineTag';
import { RoiBadge } from '../components/ui/RoiBadge';
import {
  enqueueService,
  getQueuedByLocalId,
  readCachedMachines,
  readCachedToys,
  type CachedMachine,
} from '../db';
import { syncOutbox } from '../sync';

interface ToyLine {
  toyId: number;
  quantity: string;
}

const pad = (value: number) => String(value).padStart(2, '0');
const toDateInput = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const toTimeInput = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

function RoiSparkline({ points }: { points: Array<{ service_date: string; revenue_to_cost_ratio: string | null } >; }) {
  const values = points.map((point) => Number(point.revenue_to_cost_ratio)).filter(Number.isFinite);
  if (values.length < 2) {
    return <p className="muted" style={{ margin: 0 }}>Недостаточно истории для тренда.</p>;
  }

  const width = 140;
  const height = 40;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const coords = values.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const trendUp = values[values.length - 1] >= values[0];
  const color = trendUp ? 'var(--good)' : 'var(--bad)';

  return (
    <div className="roi-card">
      <div className="val">
        <div className="num">{values[values.length - 1].toFixed(1)}</div>
        <div className="lbl">текущий ROI</div>
      </div>
      <svg className="spark" viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
        <polyline
          points={coords.join(' ')}
          fill="none"
          stroke={trendUp ? '#2E6B4C' : '#A23F30'}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="trend" style={{ color }}>
        {trendUp ? '▲ растёт' : '▼ снижается'}
      </div>
    </div>
  );
}

export default function ServiceFormScreen({ onQueued }: { onQueued: () => void }) {
  const { machineNumber = '', localId: editLocalId } = useParams();
  const navigate = useNavigate();

  const [machine, setMachine] = useState<CachedMachine | null>(null);
  const [toys, setToys] = useState<Array<{ id: number; name: string; unit_cost: string }>>([]);
  const [roiTrend, setRoiTrend] = useState<Array<{ service_date: string; revenue_to_cost_ratio: string | null }>>([]);
  const [dateContext, setDateContext] = useState<{
    previous: { occurred_at: string; game_counter: number; prize_counter: number };
    next: { occurred_at: string; game_counter: number } | null;
  } | null>(null);

  const now = useState(() => new Date())[0];
  const [date, setDate] = useState(toDateInput(now));
  const [time, setTime] = useState(toTimeInput(now));
  const [gameCounter, setGameCounter] = useState('');
  const [prizeCounter, setPrizeCounter] = useState('');
  const [testGames, setTestGames] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<ToyLine[]>([]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [existingPhoto, setExistingPhoto] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readCachedMachines().then((cached) => {
      setMachine(cached.find((item) => item.machine_number === machineNumber) ?? null);
    });
    void readCachedToys().then(setToys);
  }, [machineNumber]);

  // Строки игрушек по умолчанию: какие игрушки вообще заправляют на этом аппарате — из набора,
  // назначенного администратором, а если набора нет — из последнего обслуживания. Количество —
  // это фактический сегодняшний расход, а не то, что было в прошлый раз, поэтому поле всегда
  // начинается пустым; техник видит подсказку «было N» рядом и вводит новое значение сам.
  // Пустое поле при отправке — это ноль (см. submit: строки с пустым/нулевым количеством не
  // попадают в список).
  useEffect(() => {
    if (!machine || editLocalId) return;
    const lastQuantities = machine.last_toy_quantities ?? {};

    if (machine.default_toy_set_id && machine.default_toy_set_items) {
      const fromSet = Object.keys(machine.default_toy_set_items).map((toyId) => ({
        toyId: Number(toyId),
        quantity: '',
      }));
      setLines(fromSet);
      return;
    }

    const previousToys = Object.keys(lastQuantities);
    if (previousToys.length > 0) {
      setLines(previousToys.map((toyId) => ({ toyId: Number(toyId), quantity: '' })));
    }
  }, [machine, editLocalId]);

  // Редактирование уже поставленного в очередь черновика: подставляем всё, что было введено.
  useEffect(() => {
    if (!editLocalId) return;
    void getQueuedByLocalId(editLocalId).then((draft) => {
      if (!draft) return;
      const occurred = new Date(draft.occurredAt);
      setDate(toDateInput(occurred));
      setTime(toTimeInput(occurred));
      setGameCounter(String(draft.gameCounter));
      setPrizeCounter(String(draft.prizeCounter));
      setTestGames(String(draft.testGames));
      setNotes(draft.notes);
      setLines(draft.toys.map((line) => ({ toyId: line.toyId, quantity: String(line.quantity) })));
      setExistingPhoto(draft.photo);
    });
  }, [editLocalId]);

  useEffect(() => {
    if (!navigator.onLine) return;
    api
      .get<Array<{ service_date: string; revenue_to_cost_ratio: string | null }>>(
        `/api/machines/${encodeURIComponent(machineNumber)}/roi-trend`,
      )
      .then(setRoiTrend)
      .catch(() => setRoiTrend([]));
  }, [machineNumber]);

  // «Было N» и расчёт прироста должны отталкиваться от обслуживания, которое реально предшествует
  // ВЫБРАННОЙ дате, а не от последнего обслуживания аппарата вообще — иначе при вставке записи
  // задним числом между существующими подсказка вводит в заблуждение (сервер посчитает верно в
  // любом случае, но техник во время ввода увидит не те цифры). Офлайн эта проверка недоступна —
  // тогда используется последнее известное показание, как раньше.
  useEffect(() => {
    if (!date || !time || !navigator.onLine) {
      setDateContext(null);
      return;
    }
    const occurredAt = new Date(`${date}T${time}`);
    if (Number.isNaN(occurredAt.getTime())) return;

    api
      .get<typeof dateContext>(
        `/api/machines/${encodeURIComponent(machineNumber)}/context-at?occurredAt=${encodeURIComponent(occurredAt.toISOString())}`,
      )
      .then(setDateContext)
      .catch(() => setDateContext(null));
  }, [machineNumber, date, time]);

  const previousGameCounter = dateContext?.previous.game_counter ?? machine?.previous_game_counter ?? 0;
  const previousPrizeCounter = dateContext?.previous.prize_counter ?? machine?.previous_prize_counter ?? 0;

  const preview = useMemo(() => {
    if (!machine) return null;
    const current = Number(gameCounter);
    if (!gameCounter || !Number.isFinite(current)) return null;

    const growth = current - previousGameCounter;
    const divisor = normalizeDivisor(machine.counter_divisor);
    const fromCounter = calcNewGames(growth, divisor, 0);
    const newGames = calcNewGames(growth, divisor, Number(testGames) || 0);
    const revenue = calcRevenue(newGames, machine.price_per_game);

    const toyCost = lines.reduce((total, line) => {
      const toy = toys.find((item) => item.id === line.toyId);
      if (!toy || !line.quantity) return total;
      return total + Number(toy.unit_cost) * Number(line.quantity);
    }, 0);

    const periodDays = daysSince(machine.last_service_at);
    const gamesPerDay =
      periodDays && periodDays > 0 && Number(newGames) >= 0 ? Number(newGames) / periodDays : null;

    const previousToyCost = machine.last_toy_cost === null ? null : Number(machine.last_toy_cost);
    const roi =
      previousToyCost && previousToyCost > 0 ? (Number(revenue) / previousToyCost).toFixed(1) : null;

    return { growth, divisor, fromCounter, newGames, revenue, toyCost, periodDays, gamesPerDay, roi };
  }, [machine, gameCounter, testGames, lines, toys, previousGameCounter]);

  const isFutureDate = useMemo(() => {
    const occurredAt = new Date(`${date}T${time || '00:00'}`);
    return !Number.isNaN(occurredAt.getTime()) && occurredAt.getTime() > Date.now() + 60_000;
  }, [date, time]);

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (!machine) return list;

    if (isFutureDate) {
      list.push('Дата и время в будущем — сервер отклонит такое обслуживание.');
    }
    if (preview && preview.growth < 0) {
      list.push('Показание меньше предыдущего — проверьте счётчик.');
    }
    if (preview && Number(preview.newGames) < 0) {
      list.push('Тестовых игр больше, чем начислено по счётчику: сервер отклонит такое обслуживание.');
    }
    if (prizeCounter && Number(prizeCounter) < previousPrizeCounter) {
      list.push('Счётчик призов меньше предыдущего значения.');
    }
    if (dateContext?.next) {
      list.push(
        `Между выбранной датой и ${new Date(dateContext.next.occurred_at).toLocaleString('ru-RU')} уже есть обслуживание — вся цепочка после сохранения будет пересчитана.`,
      );
    }

    const overdue = computeOverdue(machine);
    const days = daysSince(machine.last_service_at);
    if (days !== null && machine.min_service_days !== null && days < machine.min_service_days) {
      list.push(`С прошлого обслуживания прошло ${days} дн. при минимуме ${machine.min_service_days}.`);
    }
    if (overdue.isOverdue) {
      list.push(`Просрочка: ${days} дн. при максимуме ${machine.max_service_days}.`);
    }
    if (machine.location_status && machine.location_status !== 'ACTIVE') {
      list.push(`Точка в статусе ${machine.location_status}: сервер запретит обслуживание.`);
    }
    return list;
  }, [machine, preview, prizeCounter, previousPrizeCounter, dateContext, isFutureDate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!machine || (!photo && !existingPhoto)) {
      setError('Фотография счётчика обязательна.');
      return;
    }
    if (isFutureDate) {
      setError('Дата и время не могут быть в будущем.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const occurredAt = new Date(`${date}T${time}`).toISOString();
      const chosenPhoto = photo ?? (existingPhoto as Blob);

      await enqueueService({
        localId: editLocalId ?? crypto.randomUUID(),
        machineNumber: machine.machine_number,
        occurredAt,
        gameCounter: Number(gameCounter),
        prizeCounter: prizeCounter ? Number(prizeCounter) : previousPrizeCounter,
        testGames: Number(testGames) || 0,
        notes,
        toys: lines
          .filter((line) => line.toyId && Number(line.quantity) > 0)
          .map((line) => ({ toyId: line.toyId, quantity: Number(line.quantity) })),
        photo: chosenPhoto,
        photoType: photo ? photo.type : 'image/jpeg',
        queuedAt: new Date().toISOString(),
        status: 'PENDING',
      });

      onQueued();
      // Queue first, send second: the record survives a dead connection either way.
      if (navigator.onLine) await syncOutbox();
      onQueued();
      navigate('/queue');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!machine) {
    return <p className="muted">Аппарат не найден в локальном каталоге. Обновите список на главном экране.</p>;
  }

  return (
    <form onSubmit={submit}>
      <div className="row" style={{ marginBottom: 12 }}>
        <div>
          <div style={{ fontFamily: 'var(--f-display)', fontWeight: 600, fontSize: 16 }}>
            {machine.model || machine.machine_type}
          </div>
          <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>
            <MachineTag number={machine.machine_number} /> · {machine.location_name}
          </div>
        </div>
        <div className="right muted" style={{ fontSize: 12 }}>
          цена игры {machine.price_per_game} ₽
          {Number(machine.counter_divisor) !== 1 && <div>делитель {Number(machine.counter_divisor)}</div>}
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {warnings.map((warning) => (
        <div className="alert warn" key={warning}>{warning}</div>
      ))}

      {machine.last_service_at && (
        <div className="readonly-prev">
          <div className="lbl">
            ПРОШЛОЕ ОБСЛУЖИВАНИЕ · {new Date(machine.last_service_at).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          <div className="grid">
            <div className="cell">
              <b className="mono">{machine.previous_game_counter}</b>
              <span>счётчик игр</span>
            </div>
            <div className="cell">
              <b className="mono">
                {machine.last_new_games ? `+${formatGames(machine.last_new_games)}` : '—'}
              </b>
              <span>новых игр</span>
            </div>
            <div className="cell">
              <b className="mono">{machine.last_revenue ? `${formatMoney(machine.last_revenue)} ₽` : '—'}</b>
              <span>выручка</span>
            </div>
            <div className="cell">
              <b className="mono">{daysSince(machine.last_service_at) ?? '—'} дн.</b>
              <span>период</span>
            </div>
            <div className="cell">
              <b className="mono">{machine.last_toy_cost ? `${formatMoney(machine.last_toy_cost)} ₽` : '—'}</b>
              <span>игрушки</span>
            </div>
            <div className="cell">
              <RoiBadge value={machine.last_revenue_to_cost_ratio} />
            </div>
          </div>
        </div>
      )}

      <div className="section-head"><span className="num">1</span><h3>Дата и время</h3><span className="line" /></div>
      <div className="row2">
        <div>
          <label className="field-label">Дата</label>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} max={toDateInput(new Date())} required />
        </div>
        <div>
          <label className="field-label">Время</label>
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
        </div>
      </div>

      <div className="section-head"><span className="num">2</span><h3>Счётчики</h3><span className="line" /></div>
      <div className="row3">
        <div className="counter-field">
          <label className="field-label">Счётчик игр</label>
          <input
            type="number"
            className="mono-input"
            inputMode="numeric"
            value={gameCounter}
            onChange={(event) => setGameCounter(event.target.value)}
            placeholder="0"
            required
          />
          <div className="field-hint">было {previousGameCounter}</div>
        </div>
        <div className="counter-field">
          <label className="field-label">Тест игры</label>
          <input
            type="number"
            className="mono-input"
            inputMode="numeric"
            min={0}
            value={testGames}
            onChange={(event) => setTestGames(event.target.value)}
          />
        </div>
        <div className="counter-field">
          <label className="field-label">Счётчик призов</label>
          <input
            type="number"
            className="mono-input"
            inputMode="numeric"
            value={prizeCounter}
            onChange={(event) => setPrizeCounter(event.target.value)}
            placeholder={String(previousPrizeCounter)}
          />
          <div className="field-hint">было {previousPrizeCounter} — оставьте пустым, если без изменений</div>
        </div>
      </div>

      {roiTrend.length > 0 && (
        <>
          <div className="section-head"><span className="num">3</span><h3>Тренд ROI</h3><span className="line" /></div>
          <RoiSparkline points={roiTrend} />
        </>
      )}

      {preview && (
        <>
          <div className="section-head"><span className="num">4</span><h3>Предварительный расчёт</h3><span className="line" /></div>
          <div className="preview-card">
            <div className="lbl">◉ РАСЧЁТ ОНЛАЙН</div>
            <div className="grid">
              <div className="cell"><b>+{formatGames(preview.newGames)}</b><span>новых игр</span></div>
              <div className="cell"><b>{preview.periodDays ?? '—'} дн.</b><span>период</span></div>
              <div className="cell">
                <b>{preview.gamesPerDay !== null ? preview.gamesPerDay.toFixed(0) : '—'}</b>
                <span>игр/день</span>
              </div>
              <div className="cell"><b>{formatMoney(preview.revenue)} ₽</b><span>выручка</span></div>
              <div className="cell"><b>{formatMoney(preview.toyCost)} ₽</b><span>себестоимость</span></div>
              <div className="cell"><b>{preview.roi ?? 'нет данных'}</b><span>ROI</span></div>
            </div>
          </div>
          <p className="field-hint" style={{ marginTop: 6 }}>
            Итоговые значения рассчитывает сервер; здесь — предварительный результат.
          </p>
        </>
      )}

      <div className="section-head"><span className="num">5</span><h3>Игрушки</h3><span className="line" /></div>
      {machine.default_toy_set_name && (
        <p className="field-hint" style={{ marginTop: -6 }}>
          Набор по умолчанию: {machine.default_toy_set_name}
        </p>
      )}
      <div className="card card-pad">
        {lines.map((line, index) => {
          const toy = toys.find((item) => item.id === line.toyId);
          return (
            <div className="toy-row" key={index}>
              <div className="info">
                <select
                  value={line.toyId}
                  onChange={(event) => {
                    const next = [...lines];
                    next[index] = { ...line, toyId: Number(event.target.value) };
                    setLines(next);
                  }}
                  style={{ border: 'none', padding: 0, background: 'transparent', fontWeight: 600 }}
                >
                  <option value={0}>— выберите игрушку —</option>
                  {toys.map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
                {toy && <div className="price mono">{formatMoney(toy.unit_cost)} ₽ / шт</div>}
              </div>
              {machine.last_toy_quantities?.[line.toyId] !== undefined && (
                <div className="prevqty">было {machine.last_toy_quantities[line.toyId]}</div>
              )}
              <input
                className="qty mono"
                type="number"
                min={0}
                value={line.quantity}
                onChange={(event) => {
                  const next = [...lines];
                  next[index] = { ...line, quantity: event.target.value };
                  setLines(next);
                }}
              />
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ marginTop: lines.length > 0 ? 10 : 0 }}
          onClick={() => setLines([...lines, { toyId: 0, quantity: '0' }])}
        >
          + Добавить игрушку
        </button>
        {preview && lines.length > 0 && (
          <div className="toy-total">
            <div className="lbl">Итого затраты на игрушки</div>
            <div className="val mono">{formatMoney(preview.toyCost)} ₽</div>
          </div>
        )}
      </div>

      <div className="section-head"><span className="num">6</span><h3>Фото</h3><span className="line" /></div>
      <div style={{ maxWidth: 160 }}>
        <label
          htmlFor="photo"
          className="photo-slot"
          style={{ cursor: 'pointer', ...(photo || existingPhoto ? { borderStyle: 'solid', borderColor: 'var(--good)', background: 'var(--good-soft)', color: 'var(--good)' } : {}) }}
        >
          <div className="ic">{photo || existingPhoto ? '✓' : '📷'}</div>
          <div className="lbl">{photo || existingPhoto ? 'Счётчик снят' : 'Счётчик игр'}</div>
        </label>
        <input
          id="photo"
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
        />
      </div>

      <div className="section-head"><span className="num">7</span><h3>Комментарий</h3><span className="line" /></div>
      <textarea
        rows={3}
        placeholder="Необязательно — что заметили на точке"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />

      <div style={{ height: 90 }} />
      <div className="formbar">
        <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
          Отмена
        </button>
        <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy || isFutureDate}>
          {busy ? 'Сохранение…' : 'Сохранить в черновики'}
        </button>
      </div>
    </form>
  );
}
