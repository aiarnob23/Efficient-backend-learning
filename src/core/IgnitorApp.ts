import express, { Express, NextFunction } from "express"
import { Context } from "./Content";
import cors from 'cors';
import { IgnitorModule } from "./IgnitorModule";
import { requestId } from "@/middleware/requestId";
import helmet from "helmet";
import config from "./config";
import cookieParser from 'cookie-parser';
import { requestLogger } from "@/middleware/requestLogger";
import rateLimit from "express-rate-limit";
import { AppError, RateLimitError } from "@/errors/AppError";
import { asyncHandler } from "@/middleware/asyncHandler";
import { HTTPStatusCode } from "@/types/HttpStatusCode";
import { AppLogger } from "./logging/logger";
import { errorHandler } from "@/errors/errorHandler";
import { notFoundHandler } from "@/middleware/notFound";

export class IgnitorApp {
    private app: Express;
    private context: Context;
    private modules: IgnitorModule[] = [];

    constructor() {
        this.app = express();
        this.context = new Context;
        this.initializeCore();
    }

    private initializeCore(): void {
        // Trust proxy (important for rate limiting and IP detection)
        this.app.set('trust proxy', 1);

        // Compression middleware
        // this.app.use(compression());

        //Request ID middleware
        this.app.use(requestId());

        //Security middlewares
        this.app.use(
            helmet({
                contentSecurityPolicy: config.server.isProduction,
                crossOriginEmbedderPolicy: config.server.isProduction,
            })
        )

        //CORS
        this.app.use(
            cors({
                origin: [
                    'http://localhost:3000',
                    'http://localhost:3001',
                    'http://localhost:5173',
                    'http://172.16.200.200:3000',
                ],
                credentials: true,
                optionsSuccessStatus: 200,
            })
        )

        // Cookie parser
        this.app.use(cookieParser());

        // Request parsing with size limits and error handling
        this.app.use(
            express.json({
                limit: '10mb',
                verify: (req, res, buf) => {
                    // Store raw body for webhook signature verification if needed
                    (req as any).rawBody = buf;
                },
            })
        );

        // Parse URL-encoded data
        this.app.use(
            express.urlencoded({
                extended: true,
                limit: '10mb',
            })
        );

        // Request timeout middleware
        // this.app.use((req: Request, res: Response, next: NextFunction) => {
        //     const timeout = setTimeout(() => {
        //         if (!res.headersSent) {
        //             next(new TimeoutError('Request timeout'));
        //         }
        //     }, config.server.requestTimeout || 30000);

        //     res.on('finish', () => clearTimeout(timeout));
        //     res.on('close', () => clearTimeout(timeout));

        //     next();
        // });

        // Request logging
        this.app.use(requestLogger());

        // Rate limiting (PRODUCTION only)
        if (config.server.isProduction) {
            this.app.use(
                rateLimit({
                    windowMs: config.security.rateLimit.windowMs,
                    max: config.security.rateLimit.max,
                    standardHeaders: true,
                    legacyHeaders: false,

                    // FIXED: do NOT type these as express.Request
                    handler: (request: any, response: any, next: NextFunction) => {
                        next(new RateLimitError());
                    },

                    skip: (request: any) => {
                        const req = request as import("express").Request;
                        return req.path === "/health";
                    },
                })
            );
        }

        //Health check endpoints
        this.app.get(
            "/health",
            asyncHandler(async (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
                try {
                    // Database test
                    await this.context.prisma.$queryRaw`SELECT 1`;

                    const formatUptime = (seconds: number) => {
                        const days = Math.floor(seconds / (3600 * 24));
                        seconds %= 3600 * 24;
                        const hours = Math.floor(seconds / 3600);
                        seconds %= 3600;
                        const minutes = Math.floor(seconds / 60);
                        seconds = Math.floor(seconds % 60);
                        return `${days}d ${hours}h ${minutes}m ${seconds}s`;
                    };

                    const formatMemory = (bytes: number) =>
                        `${(bytes / 1024 / 1024).toFixed(2)} MB`;

                    const formatCPU = (cpuUsage: NodeJS.CpuUsage) =>
                        `User: ${(cpuUsage.user / 1000).toFixed(2)}ms, System: ${(cpuUsage.system / 1000).toFixed(2)}ms`;

                    const uptimeSeconds = process.uptime();

                    const healthData = {
                        status: "healthy",
                        timestamp: new Date().toISOString(),
                        uptime: formatUptime(uptimeSeconds),
                        environment: config.server.env,
                        version: process.env.npm_package_version || "1.0.0",
                        memoryUsage: {
                            rss: formatMemory(process.memoryUsage().rss),
                            heapTotal: formatMemory(process.memoryUsage().heapTotal),
                            heapUsed: formatMemory(process.memoryUsage().heapUsed),
                            external: formatMemory(process.memoryUsage().external),
                            arrayBuffers: formatMemory(process.memoryUsage().arrayBuffers),
                        },
                        cpuUsage: formatCPU(process.cpuUsage()),
                    };

                    res.status(200).json(healthData);
                } catch (error) {
                    next(
                        new AppError(
                            HTTPStatusCode.SERVICE_UNAVAILABLE,
                            "Service unhealthy",
                            "SERVICE_UNAVAILABLE",
                            { reason: "Database connection failed" }
                        )
                    );
                }
            })
        );
    }



    //Register a module
    public registerModule(module: IgnitorModule): void {
        this.modules.push(module);
        AppLogger.info(`🧩 Registered module: ${module.name}`);
    }


    // Start the server
    public async spark(port: number): Promise<void> {
        try {
            AppLogger.info('✅ Configuration loaded successfully');

            AppLogger.info('🔧 Initializing context...');
            await this.context.initialize();

            // AppLogger.info('🔧 Initializing modules...');
            // await this.initializeModules();

            // AppLogger.info('🛣️ Registering module routes...');
            // await this.registerModuleRoutes();

            // 404 handler (must be after all routes but before error handler)
            this.app.use(notFoundHandler());

            // Global error handler (must be last)
            this.app.use(errorHandler());

            AppLogger.info('🚀 Starting server...');
            const server = this.app.listen(port, () => {
                AppLogger.info(
                    `⚡️ Ignitor Server running on port ${port} in ${config.server.env} mode`
                );
            });

            // Handle server errors
            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    throw new AppError(
                        HTTPStatusCode.INTERNAL_SERVER_ERROR,
                        `Port ${port} is already in use`,
                        'PORT_IN_USE'
                    );
                }
                throw err;
            });

            // Graceful shutdown handling
            const shutdownSignals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
            shutdownSignals.forEach(signal => {
                process.on(signal, async () => {
                    AppLogger.info(`🛑 Received ${signal}, starting graceful shutdown...`);

                    server.close(async () => {
                        try {
                            await this.shutdown();
                            process.exit(0);
                        } catch (error) {
                            AppLogger.error('❌ Error during shutdown:', { error });
                            process.exit(1);
                        }
                    });

                    setTimeout(() => {
                        AppLogger.error('⚠️ Forced shutdown due to timeout');
                        process.exit(1);
                    }, 30000);
                });
            });

            AppLogger.info('✅ Server setup complete');
        } catch (error) {
            AppLogger.error('❌ Failed to start server:', {
                error: error instanceof Error ? error : new Error(String(error)),
                context: 'server-start',
            });
            throw error;
        }
    }

        // Get the Express app
    public getApp(): Express {
        return this.app;
    }

    // Get the application context
    public getContext(): Context {
        return this.context;
    }

    // Get the configured CORS origins
    private getConfiguredOrigins(): string[] | string {
        return config.server.isProduction && config.security.cors.allowedOrigins.length > 0
            ? config.security.cors.allowedOrigins
            : '*';
    }

    // Shutdown the application
    public async shutdown(): Promise<void> {
        AppLogger.info('🛠️ Shutting down application...');

        // Shutdown modules in reverse order
        for (let i = this.modules.length - 1; i >= 0; i--) {
            const module = this.modules[i];
            if (module.onShutdown) {
                try {
                    AppLogger.info(`🧩 Shutting down module: ${module.name}`);
                    await module.onShutdown();
                } catch (error) {
                    AppLogger.error(`❌ Error shutting down module ${module.name}`, {
                        error: error instanceof Error ? error : new Error(String(error)),
                        module: module.name,
                        context: 'module-shutdown',
                    });
                }
            }
        }

        // Shutdown context
        await this.context.shutdown();
    AppLogger.info('✅ Application shutdown complete');
    }

}