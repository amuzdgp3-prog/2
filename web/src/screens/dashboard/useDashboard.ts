import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { DailySummary, DashboardData } from './types';

/** One refresh at a time, no background polling in hidden tabs, no writes or Telegram sends. */
export function useDashboard(userId: number | undefined, isAdmin: boolean) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [daily, setDaily] = useState<DailySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let running = false;
    setData(null);
    setDaily(null);
    setError(null);
    setDailyError(null);
    const refresh = async () => {
      if (running || !active) return;
      running = true;
      try {
        const [dashboardResult, dailyResult] = await Promise.allSettled([
          api.get<DashboardData>('/api/dashboard'),
          isAdmin ? api.get<DailySummary>('/api/admin/daily-summary') : Promise.resolve(null),
        ]);
        if (!active) return;
        if (dashboardResult.status === 'fulfilled') {
          setData(dashboardResult.value);
          setError(null);
        } else setError('Не удалось обновить сводку. Повторяем автоматически.');
        if (dailyResult.status === 'fulfilled') {
          setDaily(dailyResult.value);
          setDailyError(null);
        } else setDailyError('Не удалось обновить итоги дня. Повторяем автоматически.');
      } finally { running = false; }
    };
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    const timer = window.setInterval(resume, 5000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
    };
  }, [userId, isAdmin]);
  return { data, daily, error, dailyError };
}
