import { RotateCcw } from 'honestui/icons';
import { Button } from '@/components/ui/button';

export function HandworkResponseError({ detail, onContinue, disabled }: {
  detail: string; onContinue?: () => void; disabled?: boolean;
}) {
  return <div className="handwork-response-error" role="status" data-attention="recovery">
    <div className="handwork-response-error-main">
      <div className="handwork-response-error-copy">
        <p className="handwork-response-error-title">Response interrupted</p>
        <p>{onContinue ? 'Continue from where Handwork left off.' : 'Handwork couldn’t finish this response.'}</p>
      </div>
      {onContinue && <Button variant="outline" size="sm" disabled={disabled} onClick={onContinue}><RotateCcw aria-hidden />Continue</Button>}
    </div>
    <details className="handwork-response-error-details"><summary>Details</summary><p>{detail}</p></details>
  </div>;
}
