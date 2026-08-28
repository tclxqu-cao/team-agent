export interface TunnelHandle{publicUrl:string;close():Promise<void>;exited:Promise<{code:number|null;signal:string|null}>}
export interface TunnelProvider{start(options:{localUrl:string;signal:AbortSignal;log:(line:string)=>void}):Promise<TunnelHandle>}
