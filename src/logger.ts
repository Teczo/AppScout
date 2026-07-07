import fs from 'node:fs';
import path from 'node:path';

/**
 * Logs to the console and to ./logs/run-{timestamp}.log (one file per run).
 */
export class Logger {
  private readonly filePath: string;

  constructor(logsDir = './logs') {
    fs.mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(logsDir, `run-${stamp}.log`);
  }

  get logFilePath(): string {
    return this.filePath;
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string): void {
    this.write('ERROR', message);
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    if (level === 'ERROR') console.error(line);
    else console.log(line);
    fs.appendFileSync(this.filePath, line + '\n');
  }
}
