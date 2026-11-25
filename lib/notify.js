// Native Windows toast notifications, for when the browser can't show one
// (page on plain http, or notifications blocked for the site). No dependencies:
// Windows PowerShell 5.1 can reach the WinRT toast API directly.
import { spawn } from 'node:child_process';

// Toasts need a registered app id; Windows PowerShell's is always present.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// The toast XML is passed in an environment variable, never interpolated into the script.
const SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml($env:MON_TOAST_XML)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:MON_TOAST_APP).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

/**
 * Show a Windows toast. `url` (optional, http/https only) opens in the default browser on click.
 */
export function toast({ title, body, url }) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not Windows' };
  const launch = url && /^https?:\/\//.test(url) ? ` activationType="protocol" launch="${xmlEscape(url)}"` : '';
  const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${xmlEscape(String(title || 'mon.ai').slice(0, 120))}</text><text>${xmlEscape(String(body || '').slice(0, 300))}</text></binding></visual></toast>`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
    stdio: 'ignore', windowsHide: true, env: { ...process.env, MON_TOAST_XML: xml, MON_TOAST_APP: APP_ID },
  });
  child.on('error', (e) => console.error('[notify]', e.message));
  return { ok: true };
}
