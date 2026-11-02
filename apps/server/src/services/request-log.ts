import { mkdirSync, existsSync, statSync, renameSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class RequestLog {
  path: string;
  constructor(directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); this.path = join(directory, 'requests.jsonl'); this.clean(directory); appendFileSync(this.path, '', { mode: 0o600 }); }
  clean(directory: string) {
    for (const name of readdirSync(directory)) if (/^requests\.jsonl\.\d+$/.test(name) && Number(name.split('.').at(-1)) > 4) rmSync(join(directory, name));
    let bytes = 0;
    for (let index = 0; index <= 4; index++) {
      const path = this.path + (index ? `.${index}` : '');
      if (existsSync(path)) bytes += statSync(path).size;
    }
    for (let index = 4; bytes > 50_000_000 && index >= 0; index--) {
      const path = this.path + (index ? `.${index}` : '');
      if (existsSync(path)) { bytes -= statSync(path).size; rmSync(path); }
    }
  }
  write(direction: 'inbound' | 'outbound', method: string, url: URL, status: number, duration?: number, completed?: boolean, task?: string) {
    const line = JSON.stringify({ at: new Date().toISOString(), direction, ...(task ? { task } : {}), method, host: url.hostname, path: url.pathname, status, success: completed ?? (status >= 200 && status < 400), outcome: completed === undefined ? 'http' : completed ? 'http-and-json' : 'http-or-body-failed', ...(duration === undefined ? {} : { duration_ms: duration }) }) + '\n';
    try {
      if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(line) > 10_000_000) {
        rmSync(`${this.path}.4`, { force: true });
        for (let index = 3; index >= 0; index--) {
          const old = this.path + (index ? `.${index}` : '');
          if (existsSync(old)) renameSync(old, `${this.path}.${index + 1}`);
        }
      }
      appendFileSync(this.path, line, { mode: 0o600 });
      // Legacy oversized files may survive startup within the total allowance;
      // rotation must enforce the aggregate allowance again after appending.
      this.clean(dirname(this.path));
    } catch { console.error('请求日志写入失败，请检查磁盘空间和文件权限'); }
  }
}
