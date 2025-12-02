import { NextFunction, Request, Response } from 'express';
import {v4 as uuidv4} from 'uuid';


export function requestId(){
    return (req:Request, res:Response, next:NextFunction)=>{
        const existingId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
        
        req.id = typeof existingId === 'string' ? existingId : uuidv4();

        res.setHeader('x-request-id', req.id);

        next();
    }
}