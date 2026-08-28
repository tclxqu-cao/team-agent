import{spawn,type ChildProcess,type SpawnOptions}from"node:child_process";
export class ProcessSupervisor{
  private children=new Set<ChildProcess>();
  spawn(command:string,args:string[],options:SpawnOptions={}):ChildProcess{const child=spawn(command,args,{stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32",...options});this.children.add(child);child.once("exit",()=>this.children.delete(child));return child;}
  async stopAll(timeoutMs=5000):Promise<void>{await Promise.all([...this.children].map(child=>this.stop(child,timeoutMs)));}
  async stop(child:ChildProcess,timeoutMs=5000):Promise<void>{if(child.exitCode!==null||!child.pid)return;const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));try{if(process.platform==="win32")spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore"});else process.kill(-child.pid,"SIGTERM");}catch{try{child.kill("SIGTERM");}catch{}}await Promise.race([exited,new Promise<void>(resolve=>setTimeout(resolve,timeoutMs))]);if(child.exitCode===null){try{if(process.platform==="win32")spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore"});else process.kill(-child.pid,"SIGKILL");}catch{try{child.kill("SIGKILL");}catch{}}}}
}
