import { type ReactNode } from 'react';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
