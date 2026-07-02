import { useState, type ReactNode } from 'react';

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  requireText?: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog(props: ConfirmProps) {
  const [typed, setTyped] = useState('');
  const blocked = props.requireText !== undefined && typed !== props.requireText;

  return (
    <div className="modal-backdrop" onClick={props.onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{props.title}</h3>
        <div className="modal-body">{props.message}</div>
        {props.requireText !== undefined && (
          <div className="form-row">
            <label>
              Type <code>{props.requireText}</code> to confirm:
            </label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              placeholder={props.requireText}
            />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className={props.danger ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={blocked}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
