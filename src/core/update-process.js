import { spawn } from 'node:child_process';
import { setPriority, constants } from 'node:os';

// No shell on POSIX. PowerShell quotes each literal independently on Windows.
export function lowPriority(command, args, options = {}) {
  let child;
  if (process.platform === 'win32') {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const script = '$ErrorActionPreference="Stop"; '
      + '[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass="BelowNormal"; '
      + `& ${quote(command)} ${args.map(quote).join(' ')}; exit $LASTEXITCODE`;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], options);
  } else child = spawn('nice', ['-n', '15', command, ...args], options);
  return child;
}

export function lowerNode(child) {
  // IPC must go directly to Node, rather than through a PowerShell wrapper.
  if (process.platform === 'win32' && child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
}
