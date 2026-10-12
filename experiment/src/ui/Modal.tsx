import { useEffect, useRef, type ReactNode } from 'react';

/** Native <dialog> wrapper: focus trapping, Esc and inert background come from the browser. */
export function Modal(props: { open: boolean; onClose: () => void; labelledBy: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
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
      aria-labelledby={props.labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      {props.open ? props.children : null}
    </dialog>
  );
}
