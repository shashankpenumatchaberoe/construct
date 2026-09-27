import { GlassPanel } from '@/components/ui';
import type { LivePreviewView } from '../types';
import { LivePreviewEmpty } from './LivePreviewEmpty';
import { LivePreviewNotes } from './LivePreviewNotes';
import { LivePreviewToolbar } from './LivePreviewToolbar';

// Live preview of the target app in an iframe. Click an element (the target
// must run the Construct preview plugin, which annotates elements with their
// source position) to select the matching node in the tree/inspector.
//
// #456: the frame fills the stage at a chosen device size, and can take the
// whole viewport — full screen is the app and one way back, because the shell
// has already hidden the rail, panes, top bar and drawer. The iframe element is
// the same one in both states (same place in the tree; only the classes around
// it change), which is why the app never reloads and the selection survives.
export function LivePreviewPanel(props: LivePreviewView) {
  const { url, message, frameRef, fullScreen } = props;
  const showFrame = Boolean(url) && props.reach !== 'down';

  return (
    <GlassPanel className={fullScreen ? 'live-preview-panel live-preview-panel--full' : 'live-preview-panel'}>
      <LivePreviewToolbar {...props} />
      {message && !fullScreen && <p className="hint live-preview-message" role="status">{message}</p>}
      {showFrame && !fullScreen && (
        <LivePreviewNotes
          plugin={props.plugin}
          appError={props.appError}
          appErrorSrc={props.appErrorSrc}
          onDismissAppError={props.onDismissAppError}
          onShowInSource={props.onShowInSource}
        />
      )}
      {showFrame ? (
        <div className="live-preview-stage">
          <div className="live-preview-box" ref={props.boxRef} style={props.frameStyle}>
            <iframe ref={frameRef} className="live-preview-frame" title="Live app preview" src={url ?? undefined} />
          </div>
        </div>
      ) : (
        <LivePreviewEmpty {...props} />
      )}
      {fullScreen && showFrame && (
        <button type="button" className="live-preview-exit" onClick={props.onExitFullScreen}>
          Leave full screen (Esc)
        </button>
      )}
    </GlassPanel>
  );
}
