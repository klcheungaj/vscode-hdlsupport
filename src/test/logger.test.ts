// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';

import { Logger, LogSink } from '../logger';

vi.mock('vscode', () => ({ window: { createOutputChannel: vi.fn() } }));

function sink(): { [K in keyof LogSink]: ReturnType<typeof vi.fn> } {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('Logger', () => {
  it('writes each level to the matching channel method without a prefix at the root', () => {
    const channel = sink();
    const logger = new Logger(channel as unknown as LogSink);

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(channel.trace).toHaveBeenCalledWith('t');
    expect(channel.debug).toHaveBeenCalledWith('d');
    expect(channel.info).toHaveBeenCalledWith('i');
    expect(channel.warn).toHaveBeenCalledWith('w');
    expect(channel.error).toHaveBeenCalledWith('e');
  });

  it('prefixes child messages with every ancestor name, outermost first', () => {
    const channel = sink();
    const logger = new Logger(channel as unknown as LogSink);

    logger.getChild('LintManager').getChild('verilatorLinter').warn('slow');
    logger.getChild('Formatter').info('ready');

    expect(channel.warn).toHaveBeenCalledWith('[LintManager] [verilatorLinter] slow');
    expect(channel.info).toHaveBeenCalledWith('[Formatter] ready');
  });
});
