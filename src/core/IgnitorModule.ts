import { Context } from "./Content";

export interface IgnitorModule {
    name:string;
    dependencies:string[];
    initialize(context:Context):Promise<void>;
    onShutdown?():Promise<void>;
}