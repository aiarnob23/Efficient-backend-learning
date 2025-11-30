// src/core/logging/Logger.ts
import fs from 'fs';
import { createLogger, format, transports, Logger } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import chalk from 'chalk';
import util from 'util';
import { format as dateFnsFormat } from 'date-fns';

const { combine, timestamp, printf, errors, json, splat } = format;

const LOG_DIR = process.env.LOG_DIR || 'logs';
const NODE_ENV = process.env.NODE_ENV;
const isDev = NODE_ENV === 'development';

// Ensure logs/ exists
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
    console.error("Failed to create log directory:", e);
}

/* ---------------------------------------------------------
 * Pretty console formatter (Development only)
 * --------------------------------------------------------- */
const consoleFormat = printf((info: any) => {
    const { level, message, timestamp: ts, stack, ...meta } = info;

    const levelStyles: Record<string, { emoji: string; color: (s: string)=>string }> = {
        error: { emoji: '❌', color: chalk.red.bold },
        warn:  { emoji: '⚠️', color: chalk.yellow.bold },
        info:  { emoji: 'ℹ️', color: chalk.cyan.bold },
        http:  { emoji: '🌐', color: chalk.magenta.bold },
        debug: { emoji: '🐛', color: chalk.green.bold },
    };

    const style = levelStyles[level] ?? { emoji: '📝', color: chalk.white };
    const lvl = style.color(level.toUpperCase().padEnd(5));
    const emoji = style.emoji;
    const time = chalk.gray(ts);

    let metaString = '';
    if (Object.keys(meta).length) {
        metaString = util.inspect(meta, { depth: 4, colors: true });
        metaString = '\n→ ' + metaString;
    }

    const main = stack || message;
    return `${emoji} ${time} ${lvl} ${main}${metaString}`;
});

/* ---------------------------------------------------------
 * Production JSON formatter (no colors, clean)
 * --------------------------------------------------------- */
const productionFormat = combine(
    timestamp({
        format: () => dateFnsFormat(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS'),
    }),
    errors({ stack: true }),
    splat(),
    json()
);

/* ---------------------------------------------------------
 * Transports
 * --------------------------------------------------------- */
function buildTransports() {
    const list: any[] = [];

    // Development → console only
    if (isDev) {
        list.push(
            new transports.Console({
                format: combine(
                    timestamp(),
                    errors({ stack: true }),
                    splat(),
                    consoleFormat
                ),
            })
        );
    }

    // Production → file logs only
    if (!isDev) {
        list.push(
            new DailyRotateFile({
                dirname: LOG_DIR,
                filename: 'app-%DATE%.log',
                datePattern: 'YYYY-MM-DD',
                maxSize: '10m',
                maxFiles: '30d',
                zippedArchive: true,
                format: productionFormat,
            })
        );
    }

    return list;
}

/* ---------------------------------------------------------
 * Singleton Logger Class
 * --------------------------------------------------------- */
export class AppLogger {
    private static instance: Logger;

    private static init(): Logger {
        if (!this.instance) {
            this.instance = createLogger({
                level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
                exitOnError: false,
                transports: buildTransports(),

                exceptionHandlers: [
                    new DailyRotateFile({
                        dirname: LOG_DIR,
                        filename: 'exceptions-%DATE%.log',
                        datePattern: 'YYYY-MM-DD',
                        zippedArchive: true,
                        format: productionFormat,
                    }),
                ],

                rejectionHandlers: [
                    new DailyRotateFile({
                        dirname: LOG_DIR,
                        filename: 'rejections-%DATE%.log',
                        datePattern: 'YYYY-MM-DD',
                        zippedArchive: true,
                        format: productionFormat,
                    }),
                ],
            });
        }

        return this.instance;
    }

    static get logger() {
        return this.init();
    }

    static info(msg: string, meta?: any) {
        this.logger.info(msg, meta);
    }

    static warn(msg: string, meta?: any) {
        this.logger.warn(msg, meta);
    }

    static error(err: string | Error, meta?: any) {
        if (err instanceof Error) {
            this.logger.error(err.message, {
                stack: err.stack,
                ...meta,
            });
        } else {
            this.logger.error(err, meta);
        }
    }

    static debug(msg: string, meta?: any) {
        this.logger.debug(msg, meta);
    }

    static child(meta: Record<string, any>) {
        return this.logger.child(meta);
    }
}
