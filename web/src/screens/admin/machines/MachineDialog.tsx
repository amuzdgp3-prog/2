import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native dialog traps focus, makes the background inert and restores focus on close. */
export function MachineDialog({ title, children, onClose, pending }: {
  title: string; children: ReactNode; onClose: () => void; pending: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => { dialog.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  return (
    <dialog className="am-dialog" ref={ref} aria-labelledby={titleId} aria-busy={pending}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="am-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label="Закрыть окно" disabled={pending} onClick={onClose}>×</button></div>
      {children}
    </dialog>
  );
}
