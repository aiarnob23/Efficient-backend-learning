import { AppLogger } from "./core/logging/logger";

async function bootstrap(){
    try{
       AppLogger.info(' Starting application bootstrap')
    }
    catch (error) {
        AppLogger.error('❌ Bootstrap error details:', error);

        AppLogger.error('🔴 Failed to initialize application:', {
            error: error instanceof Error ? error : new Error(String(error)),
            context: 'application-initialization',
            stack: error instanceof Error ? error.stack : undefined,
            message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
    }
}

bootstrap();