import { useState, type ReactNode } from 'react';
import { formatDate, formatTime } from '../../dateFormat';
import { formatGames, formatMoney } from '../../calc';
import { PhotoThumbnail } from '../../components/ui/PhotoLightbox';
import type { ServiceRow } from './types';

interface Props {
  rows: ServiceRow[];
  isAdmin: boolean;
  editing: number | null;
  onEdit: (id: number | null) => void;
  onRemove: (id: number) => void;
  renderEditor: (row: ServiceRow) => ReactNode;
}

/** One table DOM becomes service cards on a narrow screen; values and actions are shared. */
export function ServiceHistory({ rows, isAdmin, editing, onEdit, onRemove, renderEditor }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <table className="mch-log" aria-label="История обслуживаний аппарата">
      <thead>
        <tr>
          <th scope="col">Обслуживание</th>
          <th scope="col" className="mch-num">Выручка, ₽</th>
          <th scope="col" className="mch-num">Нал / безнал, ₽</th>
          <th scope="col" className="mch-num">Игры</th>
          <th scope="col" className="mch-num">Игрушки, ₽</th>
          <th scope="col" className="mch-num" title="Выручка / себестоимость игрушек предыдущего обслуживания">ROI</th>
          <th scope="col"><span className="mch-sr-only">Подробности</span></th>
        </tr>
      </thead>
      {rows.map((row) => {
        const open = expanded === row.id || editing === row.id;
        return (
          <tbody key={row.id} className="mch-service">
            <tr className="mch-summary-row">
              <td className="mch-service-date">
                <span className="mch-date">{formatDate(row.service_date)} <span className="mch-time">· {formatTime(row.occurred_at)}</span></span>
                <span className="mch-sub">{row.technician_name || 'Техник не указан'}</span>
                {row.kind === 'FINAL' && <span className="mch-final">Финальное</span>}
                {row.is_financial_anomaly && <span className="mch-anomaly-flag">Расхождение безнала</span>}
              </td>
              <td className="mch-num mch-service-revenue"><span className="mch-mobile-label">Выручка</span><strong>{formatMoney(row.revenue)}<span className="mch-mobile-unit"> ₽</span></strong></td>
              <td className="mch-num"><span className="mch-mobile-label">Нал / безнал, ₽</span>{formatMoney(row.cash_amount)} / {formatMoney(row.cashless_amount)}</td>
              <td className="mch-num"><span className="mch-mobile-label">Новые игры</span>{formatGames(row.new_games)}</td>
              <td className="mch-num"><span className="mch-mobile-label">Игрушки добавлены, ₽</span>{formatMoney(row.toy_cost)}</td>
              <td className="mch-num"><span className="mch-mobile-label">Выручка / себестоимость</span><span className="mch-roi">{row.revenue_to_cost_ratio === null ? 'нет данных' : Number(row.revenue_to_cost_ratio).toFixed(2)}</span></td>
              <td className="mch-expand-cell">
                <button
                  className="mch-expand"
                  type="button"
                  aria-label={`${open ? 'Скрыть' : 'Показать'} подробности обслуживания ${formatDate(row.service_date)}`}
                  aria-expanded={open}
                  aria-controls={`mch-service-${row.id}`}
                  onClick={() => {
                    setExpanded(open ? null : row.id);
                    if (open && editing === row.id) onEdit(null);
                  }}
                ><span className="mch-mobile-label">Показания и подробности</span><span aria-hidden="true" className={open ? 'mch-chevron mch-chevron-open' : 'mch-chevron'}>⌄</span></button>
              </td>
            </tr>
            <tr id={`mch-service-${row.id}`} className="mch-detail-row" hidden={!open}>
              <td colSpan={7}>
                {open && <ServiceDetails row={row} isAdmin={isAdmin} editing={editing === row.id} onEdit={() => onEdit(editing === row.id ? null : row.id)} onRemove={() => onRemove(row.id)}>
                  {editing === row.id && renderEditor(row)}
                </ServiceDetails>}
              </td>
            </tr>
          </tbody>
        );
      })}
    </table>
  );
}

function ServiceDetails({ row, isAdmin, editing, onEdit, onRemove, children }: {
  row: ServiceRow;
  isAdmin: boolean;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const [showPhoto, setShowPhoto] = useState(false);
  return (
    <div className="mch-service-details">
      {row.is_financial_anomaly && <div className="alert warn">Безнал больше выручки — расхождение отмечено, значения не подгонялись.</div>}
      <dl className="mch-detail-grid">
        <div><dt>Счётчик игр</dt><dd>{row.game_counter}</dd></div>
        <div><dt>Счётчик призов</dt><dd>{row.prize_counter}</dd></div>
        <div><dt>Тестовые игры</dt><dd>{row.test_games}</dd></div>
        <div><dt>Цена игры при записи</dt><dd>{formatMoney(row.price_per_game_snapshot)} ₽</dd></div>
        <div><dt>Делитель счётчика</dt><dd>{Number(row.counter_divisor_applied)}</dd></div>
        <div><dt>Игрушки добавлены</dt><dd>{row.toys?.length ? row.toys.map((toy) => <span className="mch-toy-item" key={toy.toyId}>{toy.name} · {toy.quantity} шт. × {formatMoney(toy.unitCost)} ₽</span>) : Number(row.toy_cost) > 0 ? `${formatMoney(row.toy_cost)} ₽ · состав не указан` : 'Не добавлялись'}</dd></div>
      </dl>
      {row.notes && <p className="mch-service-note">{row.notes}</p>}
      <div className="mch-detail-actions">
        <button type="button" onClick={() => setShowPhoto(!showPhoto)}>{showPhoto ? 'Скрыть фото' : 'Фото счётчика'}</button>
        {isAdmin && <>
          <button type="button" onClick={onEdit}>{editing ? 'Отмена' : 'Изменить'}</button>
          <button type="button" className="mch-delete" onClick={onRemove}>Удалить</button>
        </>}
      </div>
      {showPhoto && row.photo_object_key && <PhotoThumbnail objectKey={row.photo_object_key} alt="Фото счётчика" />}
      {children}
    </div>
  );
}
