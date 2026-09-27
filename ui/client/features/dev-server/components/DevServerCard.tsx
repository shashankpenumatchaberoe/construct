import type { DevServerHandlers, DevServerView } from '../types';
import { DevServerActions } from './DevServerActions';
import { DevServerConfirm } from './DevServerConfirm';

type DevServerCardProps = DevServerHandlers & { view: DevServerView; error: string | null };

// One card per state of the live preview's server (`ia-preview-states`): what is happening, why, and the one
// or two things to do about it. Every string and flag arrives already decided by the domain layer.
export function DevServerCard({ view, error, ...handlers }: DevServerCardProps) {
  return (
    <div className="dev-server__card" data-testid="dev-server-card" data-card={view.card}>
      <p className="dev-server__title">{view.title}</p>
      <p className="dev-server__message" data-testid="dev-server-message">{view.message}</p>
      {error && <p className="status-error" role="alert">{error}</p>}
      {view.networkWarning && (
        <p className="dev-server__network-warning" role="alert" data-testid="dev-server-network-warning">{view.networkWarning}</p>
      )}
      {view.command && (
        <p className="dev-server__command hint">
          Runs <code data-testid="dev-server-command">{view.command.display}</code>, which is <code data-testid="dev-server-script">{view.command.text}</code> in this project&apos;s package.json.
        </p>
      )}
      {view.confirming && <DevServerConfirm busy={view.busy} onConfirm={handlers.onConfirm} onCancel={handlers.onCancel} />}
      <DevServerActions view={view} {...handlers} />
    </div>
  );
}
