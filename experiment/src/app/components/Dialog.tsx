import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native <dialog>: focus trapping, Esc and the inert background come from the browser. */
export function Dialog(props: { open: boolean; title: string; onClose: () => void; className?: string; hideTitle?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!props.open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${props.className ?? ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); props.onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      {props.open ? (
        <div className="modal-body">
          <h2 id={titleId} className={props.hideTitle ? 'sr-only' : undefined}>{props.title}</h2>
          {props.children}
        </div>
      ) : null}
    </dialog>
  );
}
