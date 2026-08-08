import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';

export type RunCommandOptions = {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  stdin?: string | null;
};

export type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function attachAbort(child: ChildProcessWithoutNullStreams, signal?: AbortSignal) {
  if (!signal) return () => undefined;
  let exited = false;
  const onExit = () => {
    exited = true;
  };
  child.once('exit', onExit);
  child.once('close', onExit);

  const onAbort = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 1500).unref();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
    child.removeListener('exit', onExit);
    child.removeListener('close', onExit);
  };
}

export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`failed to spawn ${opts.bin}: ${(err as Error).message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const detachAbort = attachAbort(child, opts.signal);

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1500).unref();
      }, opts.timeoutMs);
      timer.unref();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    if (opts.stdin != null) child.stdin.end(opts.stdin);
    else child.stdin.end();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detachAbort();
      fn();
    };

    child.on('error', (err) => {
      finish(() => {
        reject(new Error(`failed to spawn ${opts.bin}: ${err.message}`));
      });
    });

    child.on('close', (code, signalName) => {
      finish(() => {
        if (opts.signal?.aborted) {
          reject(new Error('cancelled'));
          return;
        }
        if (timedOut) {
          reject(new Error(`command timed out after ${opts.timeoutMs}ms: ${opts.bin}`));
          return;
        }
        const exitCode = code == null ? (signalName ? 1 : 0) : code;
        resolve({ stdout, stderr, exitCode });
      });
    });
  });
}

export function resolveBinary(
  names: string[],
  opts: {
    envPathKeys?: string[];
    defaultPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | null {
  const env = opts.env ?? process.env;
  for (const key of opts.envPathKeys ?? []) {
    const v = env[key]?.trim();
    if (v && existsSync(v)) return v;
  }
  for (const name of names) {
    if (name.includes('/') && existsSync(name)) return name;
    const found = whichPath(name, env);
    if (found) return found;
  }
  if (opts.defaultPath && existsSync(opts.defaultPath)) return opts.defaultPath;
  return null;
}

function whichPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  const pathEnv = env.PATH ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\/$/, '')}/${bin}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
