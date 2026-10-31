import { ChevronRight, CirclePause, RotateCcw } from 'honestui/icons';
import { Button } from '@/components/ui/button';

export function HandworkResponseError({ detail, onContinue, disabled }: {
  detail: string; onContinue?: () => void; disabled?: boolean;
}) {
  return <div className="handwork-response-error" role="status" data-attention="recovery">
    <div className="handwork-response-error-main">
      <span className="handwork-response-error-icon" aria-hidden><CirclePause /></span>
      <div className="handwork-response-error-copy">
        <p className="handwork-response-error-title">Response interrupted</p>
        <p>{onContinue ? 'Pick up where Handwork left off.' : 'Handwork couldn’t finish this response.'}</p>
        <details className="handwork-response-error-details"><summary><ChevronRight aria-hidden />Details</summary><p>{detail}</p></details>
      </div>
      {onContinue && <Button className="handwork-response-error-continue" variant="ghost" size="sm" disabled={disabled} onClick={onContinue}><RotateCcw aria-hidden />Continue</Button>}
    </div>
  </div>;
}
