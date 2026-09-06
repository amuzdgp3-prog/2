import { useState, type FormEvent } from 'react';
import { api } from '../api';

/**
 * Замена аппарата (10_ТЗ §5): закрывает старый Placement финальным обслуживанием и одной
 * атомарной операцией устанавливает новый физический аппарат со своими начальными счётчиками.
 * Показания старого и нового аппарата никогда не сравниваются между собой.
 */
export function ReplaceMachineForm({
  oldMachineNumber,
  onDone,
  onError,
}: {
  oldMachineNumber: string;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [finalGameCounter, setFinalGameCounter] = useState('');
  const [finalPrizeCounter, setFinalPrizeCounter] = useState('');
  const [testGames, setTestGames] = useState('0');
  const [photo, setPhoto] = useState<File | null>(null);
  const [newMachineNumber, setNewMachineNumber] = useState('');
  const [machineType, setMachineType] = useState('CRANE');
  const [model, setModel] = useState('');
  const [pricePerGame, setPricePerGame] = useState('');
  const [counterDivisor, setCounterDivisor] = useState('1.00');
  const [initialGameCounter, setInitialGameCounter] = useState('0');
  const [initialPrizeCounter, setInitialPrizeCounter] = useState('0');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!photo) {
      onError(new Error('Фото финального показания счётчика обязательно'));
      return;
    }

    setBusy(true);
    try {
      const localId = crypto.randomUUID();
      const occurredAt = new Date().toISOString();

      const form = new FormData();
      form.append('localId', localId);
      form.append('file', photo, `${localId}.jpg`);
      const uploaded = await api.upload<{ objectKey: string }>('/api/photos', form);

      await api.post('/api/machines/replace', {
        oldMachineNumber,
        occurredAt,
        finalGameCounter: Number(finalGameCounter),
        finalPrizeCounter: Number(finalPrizeCounter),
        testGames: Number(testGames) || 0,
        localId,
        photoObjectKey: uploaded.objectKey,
        newMachine: {
          machineNumber: newMachineNumber,
          machineType,
          model,
          pricePerGame,
          counterDivisor,
          initialGameCounter: Number(initialGameCounter),
          initialPrizeCounter: Number(initialPrizeCounter),
        },
      });

      onDone(`Аппарат № ${oldMachineNumber} заменён на № ${newMachineNumber}`);
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-pad" style={{ marginBottom: 16 }}>
      <div className="section-head" style={{ marginTop: 0 }}>
        <span className="num">1</span><h3>Финальные показания старого аппарата № {oldMachineNumber}</h3><span className="line" />
      </div>
      <div className="row3">
        <div>
          <label className="field-label">Счётчик игр</label>
          <input type="number" className="mono-input" value={finalGameCounter} onChange={(e) => setFinalGameCounter(e.target.value)} required />
        </div>
        <div>
          <label className="field-label">Тест игры</label>
          <input type="number" className="mono-input" value={testGames} onChange={(e) => setTestGames(e.target.value)} />
        </div>
        <div>
          <label className="field-label">Счётчик призов</label>
          <input type="number" className="mono-input" value={finalPrizeCounter} onChange={(e) => setFinalPrizeCounter(e.target.value)} required />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label className="field-label">Фото финального показания (обязательно)</label>
        <input type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} required />
      </div>

      <div className="section-head"><span className="num">2</span><h3>Новый физический аппарат</h3><span className="line" /></div>
      <div className="stack">
        <div className="grid-2">
          <div>
            <label className="field-label">Номер нового аппарата</label>
            <input value={newMachineNumber} onChange={(e) => setNewMachineNumber(e.target.value)} required />
          </div>
          <div>
            <label className="field-label">Тип</label>
            <input value={machineType} onChange={(e) => setMachineType(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="field-label">Модель / название</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="grid-2">
          <div>
            <label className="field-label">Цена игры, ₽</label>
            <input type="number" step="0.01" value={pricePerGame} onChange={(e) => setPricePerGame(e.target.value)} required />
          </div>
          <div>
            <label className="field-label">Коэффициент счётчика</label>
            <input type="number" step="0.01" min="0.01" value={counterDivisor} onChange={(e) => setCounterDivisor(e.target.value)} />
          </div>
        </div>
        <div className="grid-2">
          <div>
            <label className="field-label">Начальный счётчик игр</label>
            <input type="number" value={initialGameCounter} onChange={(e) => setInitialGameCounter(e.target.value)} />
          </div>
          <div>
            <label className="field-label">Начальный счётчик призов</label>
            <input type="number" value={initialPrizeCounter} onChange={(e) => setInitialPrizeCounter(e.target.value)} />
          </div>
        </div>
        <p className="field-hint" style={{ margin: 0 }}>
          Новый аппарат встаёт на ту же точку, что и старый. Показания старого и нового счётчиков
          нигде не сравниваются — это разные физические устройства.
        </p>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Замена…' : 'Заменить аппарат'}
        </button>
      </div>
    </form>
  );
}
