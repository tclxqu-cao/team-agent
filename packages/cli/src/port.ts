import net from"node:net";
export async function findAvailablePort(requested:number|null,host="127.0.0.1"):Promise<number>{
  const probe=(port:number)=>new Promise<number>((resolve,reject)=>{const server=net.createServer();server.unref();server.once("error",reject);server.listen({host,port},()=>{const address=server.address();const value=typeof address==="object"&&address?address.port:port;server.close(error=>error?reject(error):resolve(value));});});
  if(requested!==null){try{return await probe(requested);}catch{throw Object.assign(new Error(`port ${requested} is already in use`),{exitCode:3});}}
  return probe(0);
}
