"use client";
import { useEffect, useId, useState } from 'react';
import QRCode from 'qrcode';
import type { DesktopAPI, MobileStatus } from '@/lib/desktop-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function MobileSettings({ api }: { api?: DesktopAPI }) {
  const [status, setStatus] = useState<MobileStatus>();
  const [remote, setRemote] = useState('');
  const [code, setCode] = useState<{ url: string; expires: number; image: string }>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const remoteId = useId();
  useEffect(() => {
    let disposed = false;
    const refresh = () => api?.mobileStatus?.().then(value => { if (!disposed) setStatus(value); }).catch(reason => { if (!disposed) setError(String(reason)); });
    api?.mobileStatus?.().then(value => { if (!disposed) { setStatus(value); setRemote(value.remoteAddress); } }).catch(reason => { if (!disposed) setError(String(reason)); });
    const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); void api?.mobileCancelInvite?.().catch(() => {}); };
  }, [api]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  // Laid out with the settings page's own rows, so Mobile reads like every other section.
  return <div className="handwork-mobile-settings">
    <p className="handwork-settings-note">Use Handwork from your phone while this computer is on. Paired phones can reach your workspace.</p>
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    <div className="handwork-setting-row"><div><span className="handwork-setting-title">Mobile access</span><p data-ready={status?.listening || undefined}>{status?.listening ? 'Ready for your phone' : 'Mobile access is off'}</p></div>
      <div className="handwork-setting-control"><Button size="sm" variant="outline" disabled={busy || !api?.mobileConfigure} onClick={() => void run(async () => { setCode(undefined); setStatus(await api!.mobileConfigure!({ enabled: !status?.enabled, remoteAddress: remote })); })}>{status?.enabled ? 'Disable mobile access' : 'Enable mobile access'}</Button></div></div>
    <div className="handwork-setting-row"><div><label htmlFor={remoteId} className="handwork-setting-title">Remote address (optional)</label><p>Same Wi-Fi works by default. Elsewhere, use a VPN address or forward UDP port 38416.</p></div>
      <div className="handwork-setting-control"><Input id={remoteId} value={remote} onChange={event => setRemote(event.target.value)} placeholder="VPN IP or hostname:38416" /></div></div>
    <div className="handwork-setting-row"><div><span className="handwork-setting-title">Pair a phone</span><p>Shows a one-time code to scan.</p></div><div className="handwork-setting-control"><Button size="sm" disabled={busy || !status?.enabled} onClick={() => void run(async () => {
      setStatus(await api!.mobileConfigure!({ enabled: true, remoteAddress: remote }));
      const invite = await api!.mobileInvite!(); setCode({ ...invite, image: await QRCode.toDataURL(invite.url, { width: 320, margin: 2 }) });
    })}>Pair phone</Button></div></div>
    {code && <div className="handwork-mobile-pairing">
      <img src={code.image} width={320} height={320} alt="Scan this code in Handwork mobile to pair" />
      <div>
        <p>One-use code. Expires {new Date(code.expires * 1000).toLocaleTimeString()}.</p>
        <div className="handwork-settings-buttons">
          <Button size="sm" variant="outline" onClick={() => void run(async () => { await navigator.clipboard.writeText(code.url); })}>Copy pairing link</Button>
          <Button size="sm" variant="ghost" onClick={() => void run(async () => { await api!.mobileCancelInvite!(); setCode(undefined); })}>Cancel pairing</Button>
        </div>
      </div>
    </div>}
    <h3>Paired devices</h3>
    {status?.devices.length ? status.devices.map(device => <div key={device.id} className="handwork-setting-row"><div><span className="handwork-setting-title">{device.name}</span></div><div className="handwork-setting-control"><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { setStatus(await api!.mobileRevoke!(device.id)); })}>Revoke</Button></div></div>) : <p className="handwork-settings-empty">No paired devices.</p>}
  </div>;
}
