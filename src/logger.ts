import * as vscode from 'vscode';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** The part of `vscode.LogOutputChannel` a logger writes to. */
export type LogSink = Pick<vscode.LogOutputChannel, LogLevel>;

/** Writes to one output channel; children add their name to every message. */
export class Logger {
  constructor(private readonly sink: LogSink, private readonly prefix = '') {}

  getChild(name: string): Logger {
    return new Logger(this.sink, `${this.prefix}[${name}] `);
  }

  trace(message: string): void {
    this.sink.trace(this.prefix + message);
  }

  debug(message: string): void {
    this.sink.debug(this.prefix + message);
  }

  info(message: string): void {
    this.sink.info(this.prefix + message);
  }

  warn(message: string): void {
    this.sink.warn(this.prefix + message);
  }

  error(message: string): void {
    this.sink.error(this.prefix + message);
  }
}

export function createLogger(name: string): Logger {
  return new Logger(vscode.window.createOutputChannel(name, { log: true }));
}
