// src/core/BaseService.ts
import { PrismaClient } from '@prisma/client';
import { Response } from 'express';
import { AppLogger } from './logging/logger';
import { DatabaseError, NotFoundError } from '../errors/AppError';
import { FilterHandler, PaginationOptions, PaginationResult } from '@/types/types';
import slugify from 'slugify';

// Type for base service options
export interface BaseServiceOptions {
    enableSoftDelete?: boolean;
    enableAuditFields?: boolean;
    defaultPageSize?: number;
    maxPageSize?: number;
    enableSSE?: boolean; 
}

// SSE Event interface
export interface SSEEvent {
    event: string;
    data: any;
    timestamp: string;
    channel: string;
}

// Type for Prisma transaction callback
type TransactionCallback<T> = (
    tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>
) => Promise<T>;

export abstract class BaseService<TModel = any, TCreateInput = any, TUpdateInput = any> {
    protected prisma: PrismaClient;
    protected modelName: string;
    protected options: BaseServiceOptions;
    protected filterMap: Record<string, FilterHandler> = {};

    // SSE client storage - only initialized if SSE is enabled
    protected sseClients: Map<string, Response[]> = new Map();

    // Constructor
    constructor(prisma: PrismaClient, modelName: string, options: BaseServiceOptions = {}) {
        this.prisma = prisma;
        this.modelName = modelName;
        this.options = {
            enableSoftDelete: false,
            enableAuditFields: false,
            enableSSE: false,
            defaultPageSize: 10,
            maxPageSize: 1000,
            ...options,
        };

        // Initialize SSE if enabled
        if (this.options.enableSSE) {
            this.initializeSSE();
        }
    }

    /**
     * Initialize SSE functionality
     */
    private initializeSSE(): void {
        AppLogger.info(`SSE enabled for ${this.modelName} service`);

        // Set up periodic cleanup of dead connections
        setInterval(() => {
            this.cleanupDeadConnections();
        }, 60000); // Cleanup every minute
    }

    /**
     * Get the Prisma model delegate
     * Override this method to return the appropriate model
     */
    protected abstract getModel(): any;

    // ========== SSE METHODS ==========

    /**
     * Add SSE client to a channel
     */
    public addSSEClient(channel: string, client: Response): void {
        if (!this.options.enableSSE) {
            AppLogger.warn(`SSE not enabled for ${this.modelName} service`);
            return;
        }

        const clients = this.sseClients.get(channel) || [];
        clients.push(client);
        this.sseClients.set(channel, clients);

        AppLogger.info(`SSE client added to channel: ${channel}`, {
            service: this.modelName,
            totalClients: clients.length,
        });

        // Set up client cleanup on disconnect
        client.on('close', () => {
            this.removeSSEClient(channel, client);
        });

        client.on('error', () => {
            this.removeSSEClient(channel, client);
        });
    }

    /**
     * Remove SSE client from a channel
     */
    public removeSSEClient(channel: string, client: Response): void {
        if (!this.options.enableSSE) return;

        const clients = this.sseClients.get(channel) || [];
        const index = clients.indexOf(client);

        if (index > -1) {
            clients.splice(index, 1);

            if (clients.length === 0) {
                this.sseClients.delete(channel);
            } else {
                this.sseClients.set(channel, clients);
            }

            AppLogger.info(`SSE client removed from channel: ${channel}`, {
                service: this.modelName,
                remainingClients: clients.length,
            });
        }
    }

    /**
     * Broadcast event to all clients in a channel
     */
    public broadcastToChannel(channel: string, eventType: string, data: any): void {
        if (!this.options.enableSSE) return;

        const event: SSEEvent = {
            event: eventType,
            data,
            timestamp: new Date().toISOString(),
            channel,
        };

        const clients = this.sseClients.get(channel) || [];
        const deadClients: Response[] = [];

        clients.forEach(client => {
            if (client.destroyed || client.writableEnded) {
                deadClients.push(client);
                return;
            }

            try {
                client.write(`event: ${event.event}\n`);
                client.write(`data: ${JSON.stringify(event.data)}\n\n`);
            } catch (error) {
                AppLogger.error(`Error sending SSE to client in channel ${channel}:`, error);
                deadClients.push(client);
            }
        });

        // Clean up dead connections
        deadClients.forEach(deadClient => {
            this.removeSSEClient(channel, deadClient);
        });
    }

    /**
     * Broadcast to multiple channels
     */
    public broadcastToChannels(channels: string[], eventType: string, data: any): void {
        channels.forEach(channel => {
            this.broadcastToChannel(channel, eventType, data);
        });
    }

    /**
     * Get number of connected clients in a channel
     */
    public getChannelClientCount(channel: string): number {
        return (this.sseClients.get(channel) || []).length;
    }

    /**
     * Get all active channels
     */
    public getActiveChannels(): string[] {
        return Array.from(this.sseClients.keys());
    }

    /**
     * Get total number of connected clients across all channels
     */
    public getTotalClientCount(): number {
        let total = 0;
        this.sseClients.forEach(clients => {
            total += clients.length;
        });
        return total;
    }

    /**
     * Clean up dead connections periodically
     */
    private cleanupDeadConnections(): void {
        if (!this.options.enableSSE) return;

        let totalCleaned = 0;
        const channelsToDelete: string[] = [];

        this.sseClients.forEach((clients, channel) => {
            const deadClients: Response[] = [];

            clients.forEach(client => {
                if (client.destroyed || client.writableEnded) {
                    deadClients.push(client);
                }
            });

            // Remove dead clients
            deadClients.forEach(deadClient => {
                const index = clients.indexOf(deadClient);
                if (index > -1) {
                    clients.splice(index, 1);
                    totalCleaned++;
                }
            });

            // Mark empty channels for deletion
            if (clients.length === 0) {
                channelsToDelete.push(channel);
            }
        });

        // Delete empty channels
        channelsToDelete.forEach(channel => {
            this.sseClients.delete(channel);
        });

        if (totalCleaned > 0) {
            AppLogger.info(`Cleaned up ${totalCleaned} dead SSE connections`, {
                service: this.modelName,
                channelsDeleted: channelsToDelete.length,
            });
        }
    }

    // ========== ENHANCED CRUD METHODS WITH SSE SUPPORT ==========

    /**
     * Create a new record with optional SSE broadcast
     */
    protected async create(
        data: TCreateInput,
        include?: any,
        broadcastChannels?: string[]
    ): Promise<TModel> {
        try {
            const createData = this.prepareCreateData(data);

            const result = await this.getModel().create({
                data: createData,
                include,
            });

            // Broadcast creation event if channels specified
            if (broadcastChannels && this.options.enableSSE) {
                this.broadcastToChannels(broadcastChannels, 'created', {
                    id: result.id,
                    model: this.modelName,
                    data: result,
                });
            }

            // Broadcast creation event to all channels
            if (this.options.enableSSE) {
                this.broadcastToChannel('*', 'created', {
                    id: result.id,
                    model: this.modelName,
                    data: result,
                });
            }

            return result as TModel;
        } catch (error) {
            return this.handleDatabaseError(error, 'create');
        }
    }

    /**
     * Update a record by ID with optional SSE broadcast
     */
    protected async updateById(
        id: string | number,
        data: TUpdateInput,
        include?: any,
        broadcastChannels?: string[]
    ): Promise<TModel> {
        try {
            const updateData = this.prepareUpdateData(data);

            const result = await this.getModel().update({
                where: { id },
                data: updateData,
                include,
            });

            // Broadcast update event if channels specified
            if (broadcastChannels && this.options.enableSSE) {
                this.broadcastToChannels(broadcastChannels, 'updated', {
                    id: result.id,
                    model: this.modelName,
                    data: result,
                });
            }

            return result as TModel;
        } catch (error) {
            return this.handleDatabaseError(error, 'updateById');
        }
    }

    /**
     * Delete a record by ID with optional SSE broadcast
     */
    protected async deleteById(id: string | number, broadcastChannels?: string[]): Promise<TModel> {
        try {
            let result: TModel;

            if (this.options.enableSoftDelete) {
                result = await this.softDelete(id);
            } else {
                result = await this.getModel().delete({
                    where: { id },
                });
            }

            // Broadcast deletion event if channels specified
            if (broadcastChannels && this.options.enableSSE) {
                this.broadcastToChannels(broadcastChannels, 'deleted', {
                    id,
                    model: this.modelName,
                    data: result,
                });
            }

            return result as TModel;
        } catch (error) {
            return this.handleDatabaseError(error, 'deleteById');
        }
    }

    // ========== EXISTING METHODS (keeping all original functionality) ==========

    /**
     * Find many records with optional filters and pagination
     */
    protected async findMany(
        filters: any = {},
        pagination?: Partial<PaginationOptions>,
        orderBy?: Record<string, 'asc' | 'desc'>,
        include?: any,
        omit?: any
    ): Promise<PaginationResult<TModel>> {
        try {
            const where = this.buildWhereClause(filters);

            // Ensure we always have pagination parameters
            const finalPagination = this.normalizePagination(pagination);

            if (!orderBy) {
                orderBy = { id: 'desc' };
            }

            const [data, total] = await Promise.all([
                this.getModel().findMany({
                    where,
                    skip: finalPagination.offset,
                    take: finalPagination.limit,
                    orderBy,
                    include,
                    omit,
                }),
                this.getModel().count({ where }),
            ]);

            return this.buildPaginationResult(data, total, finalPagination);
        } catch (error) {
            return this.handleDatabaseError(error, 'findMany');
        }
    }

    /**
     * Find many records without pagination (for internal use)
     * Returns plain array - use sparingly and only for internal operations
     */
    protected async findManyInternal(
        filters: any = {},
        orderBy?: Record<string, 'asc' | 'desc'>,
        include?: any,
        omit?: any,
        limit?: number
    ): Promise<TModel[]> {
        try {
            const where = this.buildWhereClause(filters);

            if (!orderBy) {
                orderBy = { id: 'desc' };
            }

            const result = await this.getModel().findMany({
                where,
                orderBy,
                include,
                omit,
                take: limit || this.options.maxPageSize,
            });

            return result as TModel[];
        } catch (error) {
            return this.handleDatabaseError(error, 'findManyInternal');
        }
    }

    /**
     * Find a single record by ID
     */
    protected async findById(
        id: string | number,
        include?: any,
        omit?: any
    ): Promise<TModel | null> {
        try {
            const where = this.buildWhereClause({ id });

            const result = await this.getModel().findFirst({
                where,
                include,
                omit,
            });

            return result as TModel | null;
        } catch (error) {
            return this.handleDatabaseError(error, 'findById');
        }
    }

    /**
     * Find a single record by filters
     */
    protected async findOne(filters: any, include?: any, omit?: any): Promise<TModel | null> {
        try {
            const where = this.buildWhereClause(filters);

            const result = await this.getModel().findFirst({
                where,
                include,
                omit,
            });

            return result as TModel | null;
        } catch (error) {
            return this.handleDatabaseError(error, 'findOne');
        }
    }

    /**
     * Soft delete a record
     */
    protected async softDelete(id: string | number): Promise<TModel> {
        try {
            const result = await this.getModel().update({
                where: { id },
                data: {
                    deletedAt: new Date(),
                    isDeleted: true,
                },
            });

            return result as TModel;
        } catch (error) {
            return this.handleDatabaseError(error, 'softDelete');
        }
    }

    /**
     * Check if a record exists
     */
    protected async exists(filters: any): Promise<boolean> {
        try {
            const where = this.buildWhereClause(filters);
            const count = await this.getModel().count({ where });
            return count > 0;
        } catch (error) {
            return this.handleDatabaseError(error, 'exists');
        }
    }

    /**
     * Count records with optional filters
     */
    protected async count(filters: any = {}): Promise<number> {
        try {
            const where = this.buildWhereClause(filters);
            return await this.getModel().count({ where });
        } catch (error) {
            return this.handleDatabaseError(error, 'count');
        }
    }

    /**
     * Normalize pagination parameters with defaults
     */
    private normalizePagination(pagination?: Partial<PaginationOptions>): PaginationOptions {
        const page = Math.max(1, pagination?.page || 1);
        const limit = Math.min(
            this.options.maxPageSize!,
            Math.max(1, pagination?.limit || this.options.defaultPageSize!)
        );
        const offset = (page - 1) * limit;

        return { page, limit, offset };
    }

    /**
     * Build pagination result object
     */
    private buildPaginationResult<T>(
        data: T[],
        total: number,
        pagination: PaginationOptions
    ): PaginationResult<T> {
        const totalPages = Math.ceil(total / pagination.limit);

        return {
            data,
            total,
            page: pagination.page,
            limit: pagination.limit,
            totalPages,
            hasNext: pagination.page < totalPages,
            hasPrevious: pagination.page > 1,
        };
    }

    /**
     * Build where clause with soft delete consideration
     */
    protected buildWhereClause(filters: any): any {
        if (this.options.enableSoftDelete) {
            return {
                ...filters,
                deletedAt: null,
            };
        }
        return filters;
    }

    /**
     * Prepare data for create operation
     */
    private prepareCreateData(data: TCreateInput): any {
        if (this.options.enableAuditFields) {
            return {
                ...data,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
        }
        return data;
    }

    /**
     * Prepare data for update operation
     */
    private prepareUpdateData(data: TUpdateInput): any {
        if (this.options.enableAuditFields) {
            return {
                ...data,
                updatedAt: new Date(),
            };
        }
        return data;
    }

    /**
     * Handle database errors and convert to appropriate AppError
     */
    private handleDatabaseError(error: any, operation: string): never {
        AppLogger.error(`Database error in ${this.modelName}.${operation}`, {
            error: error instanceof Error ? error.message : String(error),
            code: error.code,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        });

        // Map operation name to friendly message
        const operationMessages: Record<string, string> = {
            findMany: `Failed to retrieve ${this.modelName.toLowerCase()} list`,
            findById: `Failed to retrieve ${this.modelName.toLowerCase()}`,
            findOne: `Failed to retrieve ${this.modelName.toLowerCase()}`,
            create: `Failed to create ${this.modelName.toLowerCase()}`,
            updateById: `Failed to update ${this.modelName.toLowerCase()}`,
            deleteById: `Failed to delete ${this.modelName.toLowerCase()}`,
            softDelete: `Failed to delete ${this.modelName.toLowerCase()}`,
            transaction: `Database transaction failed`,
        };

        const safeMessage = operationMessages[operation] || `Database operation failed`;

        if (error.code === 'P2025') {
            throw new NotFoundError(`${this.modelName} not found`);
        }

        throw new DatabaseError(
            safeMessage,
            process.env.NODE_ENV === 'development'
                ? { originalError: error.message, code: error.code }
                : undefined
        );
    }

    /**
     * Execute a database transaction
     */
    protected async transaction<T>(callback: TransactionCallback<T>): Promise<T> {
        try {
            return await this.prisma.$transaction(callback);
        } catch (error) {
            return this.handleDatabaseError(error, 'transaction');
        }
    }

    /**
     * Merge filters deeply to handle numeric ranges correctly
     */
    protected mergeFilters(current: any, addition: any) {
        for (const key of Object.keys(addition)) {
            if (
                typeof addition[key] === 'object' &&
                addition[key] !== null &&
                !Array.isArray(addition[key])
            ) {
                current[key] = current[key] || {};
                current[key] = { ...current[key], ...addition[key] };
            } else {
                current[key] = addition[key];
            }
        }
        return current;
    }

    /**
     * Apply filters from a query object
     */
    protected applyFilters(query: Record<string, any>): any {
        let filters: any = {};

        Object.entries(query).forEach(([key, value]) => {
            if (value !== undefined && this.filterMap[key]) {
                filters = this.mergeFilters(filters, this.filterMap[key](value));
            }
        });

        return filters;
    }

    /**
     * Generate a unique slug for a given title
     */
    protected async generateUniqueSlug(title: string, excludeId?: string): Promise<string> {
        const baseSlug = slugify(title, { lower: true, strict: true });

        const existingSlugs: { slug: string }[] = await this.getModel().findMany({
            where: {
                slug: { startsWith: baseSlug },
                ...(excludeId ? { id: { not: excludeId } } : {}),
            },
            select: { slug: true },
        });

        const existingSet = new Set(existingSlugs.map(s => s.slug));

        let slug = baseSlug;
        let counter = 1;
        while (existingSet.has(slug)) {
            slug = `${baseSlug}-${counter++}`;
        }

        return slug;
    }
}