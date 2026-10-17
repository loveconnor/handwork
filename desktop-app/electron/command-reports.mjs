import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const reports = { status: ['status', '--json'], usage: ['usage', '--json'], doctor: ['doctor', '--json'], version: ['--version'] };

/** Read-only terminal reports. No renderer-supplied arguments or shell execution. */
export async function commandReport(binary, command, cwd, run = exec) {
  if (!Object.hasOwn(reports, command)) throw new Error('Unsupported terminal report');
  let stdout, exitCode = 0;
  try { ({ stdout } = await run(binary, reports[command], { cwd, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false, env: { ...process.env, NO_COLOR: '1' } })); }
  catch (error) {
    if (typeof error.code !== 'number' || !error.stdout?.trim()) throw error;
    stdout = error.stdout; exitCode = error.code;
  }
  const data = command === 'version' ? { version: stdout.trim() } : JSON.parse(stdout);
  return { command, data, exitCode };
}
