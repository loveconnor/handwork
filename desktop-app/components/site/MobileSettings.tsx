"use client";
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { DesktopAPI, MobileStatus } from '@/lib/desktop-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function MobileSettings({ api }: { api?: DesktopAPI }) {
  const [status, setStatus] = useState<MobileStatus>();
  const [remote, setRemote] = useState('');
  const [code, setCode] = useState<{ url: string; expires: number; image: string }>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = () => api?.mobileStatus?.().then(value => { if (!disposed) setStatus(value); }).catch(reason => { if (!disposed) setError(String(reason)); });
    api?.mobileStatus?.().then(value => { if (!disposed) { setStatus(value); setRemote(value.remoteAddress); } }).catch(reason => { if (!disposed) setError(String(reason)); });
    const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); void api?.mobileCancelInvite?.().catch(() => {}); };
  }, [api]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  return <div className="space-y-5">
    <p>Use the Handwork mobile app to open your projects and chats. Your desktop must stay running. Paired phones can access your workspace.</p>
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    <Button disabled={busy || !api?.mobileConfigure} onClick={() => void run(async () => { setCode(undefined); setStatus(await api!.mobileConfigure!({ enabled: !status?.enabled, remoteAddress: remote })); })}>{status?.enabled ? 'Disable mobile access' : 'Enable mobile access'}</Button>
    <p>{status?.listening ? 'Ready for your phone' : 'Mobile access is off'}</p>
    <label className="block space-y-2">Remote address (optional)<Input value={remote} onChange={event => setRemote(event.target.value)} placeholder="VPN IP or hostname:38416" /></label>
    <p>Pair on the same Wi-Fi network. Away from home, use a reachable VPN address or forward UDP port 38416.</p>
    <Button disabled={busy || !status?.enabled} onClick={() => void run(async () => {
      setStatus(await api!.mobileConfigure!({ enabled: true, remoteAddress: remote }));
      const invite = await api!.mobileInvite!(); setCode({ ...invite, image: await QRCode.toDataURL(invite.url, { width: 320, margin: 2 }) });
    })}>Pair phone</Button>
    {code && <div className="space-y-3">
      <img src={code.image} width={320} height={320} alt="Scan this code in Handwork mobile to pair" />
      <p>One-use code. Expires {new Date(code.expires * 1000).toLocaleTimeString()}.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void run(async () => { await navigator.clipboard.writeText(code.url); })}>Copy pairing link</Button>
        <Button onClick={() => void run(async () => { await api!.mobileCancelInvite!(); setCode(undefined); })}>Cancel pairing</Button>
      </div>
    </div>}
    <h4>Paired devices</h4>
    {status?.devices.length ? status.devices.map(device => <div key={device.id} className="flex items-center justify-between gap-4"><span>{device.name}</span><Button disabled={busy} onClick={() => void run(async () => { setStatus(await api!.mobileRevoke!(device.id)); })}>Revoke</Button></div>) : <p>No paired devices.</p>}
  </div>;
}
