import util from 'util';
import { Logger } from './types';

const COLORS = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  cyan: '\u001B[36m',
  yellow: '\u001B[33m',
  red: '\u001B[31m',
  green: '\u001B[32m'
} as const;

type ColorKey = keyof typeof COLORS;

function colorize(color: ColorKey, text: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function format(level: string, message: unknown, metadata: unknown, colorEnabled: boolean): string {
  const timestamp = new Date().toISOString();
  const head = colorize('dim', `[${timestamp}]`, colorEnabled);
  const levelTag = level.toUpperCase().padEnd(5, ' ');
  const coloredLevel = (() => {
    switch (level) {
      case 'info':
        return colorize('green', levelTag, colorEnabled);
      case 'warn':
        return colorize('yellow', levelTag, colorEnabled);
      case 'error':
        return colorize('red', levelTag, colorEnabled);
      case 'debug':
        return colorize('cyan', levelTag, colorEnabled);
      default:
        return levelTag;
    }
  })();

  const serialized = typeof message === 'string' ? message : util.format('%o', message);
  const suffix = metadata !== undefined ? ` ${util.format('%o', metadata)}` : '';
  return `${head} ${coloredLevel} ${serialized}${suffix}`;
}

export function createLogger(options: { debug?: boolean } = {}): Logger {
  const { debug = false } = options;
  const colorEnabled = Boolean(process.stdout.isTTY);

  return {
    info(message, metadata) {
      console.log(format('info', message, metadata, colorEnabled));
    },
    warn(message, metadata) {
      console.warn(format('warn', message, metadata, colorEnabled));
    },
    error(message, metadata) {
      console.error(format('error', message, metadata, colorEnabled));
    },
    debug(message, metadata) {
      if (!debug) return;
      console.debug(format('debug', message, metadata, colorEnabled));
    }
  };
}
