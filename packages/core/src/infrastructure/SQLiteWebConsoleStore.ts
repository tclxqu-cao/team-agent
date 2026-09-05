import { parseStoredPinnedCommands, type CommandHistoryRecord, type DeviceState, type TerminalTabRecord, type TerminalTabStatus, type UserPreferences } from "../domain/web-console/index.js";
import { getDatabase } from "./SQLiteDatabase.js";

export class SQLiteWebConsoleStore {
  private readonly db;
  constructor(baseDir: string) { this.db = getDatabase(baseDir).db; }

  markStaleTerminalsExited(at: string): number { return this.db.prepare("UPDATE terminal_tabs SET status='exited', exited_at=? WHERE status IN ('active','detached')").run(at).changes; }
  listTabs(userId: string): TerminalTabRecord[] { return (this.db.prepare("SELECT * FROM terminal_tabs WHERE user_id=? AND status<>'closed' ORDER BY sort_order, created_at").all(userId) as any[]).map(rowToTab); }
  createTab(tab: TerminalTabRecord): void { this.db.prepare("INSERT INTO terminal_tabs (id,user_id,title,shell,start_cwd,current_cwd,status,sort_order,created_at,last_active_at,exited_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(tab.id,tab.userId,tab.title,tab.shell,tab.startCwd,tab.currentCwd,tab.status,tab.sortOrder,tab.createdAt,tab.lastActiveAt,tab.exitedAt,tab.closedAt); }
  updateTab(id: string, userId: string, update: Partial<Pick<TerminalTabRecord,"title"|"currentCwd"|"status"|"sortOrder"|"lastActiveAt"|"exitedAt"|"closedAt">>): boolean {
    const columns: Record<string,string>={title:"title",currentCwd:"current_cwd",status:"status",sortOrder:"sort_order",lastActiveAt:"last_active_at",exitedAt:"exited_at",closedAt:"closed_at"};
    const entries=Object.entries(update).filter(([key])=>columns[key]); if(!entries.length)return false;
    const result=this.db.prepare(`UPDATE terminal_tabs SET ${entries.map(([key])=>`${columns[key]}=?`).join(",")} WHERE id=? AND user_id=?`).run(...entries.map(([,value])=>value),id,userId); return result.changes===1;
  }
  getPreferences(userId:string):UserPreferences|null { const row=this.db.prepare("SELECT * FROM user_preferences WHERE user_id=?").get(userId) as any; return row?rowToPreferences(row):null; }
  savePreferences(value:UserPreferences,expectedRevision:number|null):boolean {
    if(expectedRevision===null){ try{this.db.prepare("INSERT INTO user_preferences (user_id,revision,theme,terminal_font_size,file_button_position_json,keybar_position_json,keybar_hidden,key_order_json,pinned_commands_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(value.userId,value.revision,value.theme,value.terminalFontSize,JSON.stringify(value.fileButtonPosition),JSON.stringify(value.keybarPosition),value.keybarHidden?1:0,JSON.stringify(value.keyOrder),JSON.stringify(value.pinnedCommands),value.updatedAt);return true;}catch{return false;} }
    return this.db.prepare("UPDATE user_preferences SET revision=?,theme=?,terminal_font_size=?,file_button_position_json=?,keybar_position_json=?,keybar_hidden=?,key_order_json=?,pinned_commands_json=?,updated_at=? WHERE user_id=? AND revision=?").run(value.revision,value.theme,value.terminalFontSize,JSON.stringify(value.fileButtonPosition),JSON.stringify(value.keybarPosition),value.keybarHidden?1:0,JSON.stringify(value.keyOrder),JSON.stringify(value.pinnedCommands),value.updatedAt,value.userId,expectedRevision).changes===1;
  }
  getDeviceState(userId:string,deviceId:string):DeviceState|null { const row=this.db.prepare("SELECT * FROM device_states WHERE user_id=? AND device_id=?").get(userId,deviceId) as any; return row?rowToDevice(row):null; }
  saveDeviceState(value:DeviceState):void { this.db.prepare("INSERT INTO device_states (user_id,device_id,active_terminal_id,drawer_open,drawer_tab,file_tree_root,file_tree_follow_mode,expanded_paths_json,selected_file,terminal_scroll_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET active_terminal_id=excluded.active_terminal_id,drawer_open=excluded.drawer_open,drawer_tab=excluded.drawer_tab,file_tree_root=excluded.file_tree_root,file_tree_follow_mode=excluded.file_tree_follow_mode,expanded_paths_json=excluded.expanded_paths_json,selected_file=excluded.selected_file,terminal_scroll_json=excluded.terminal_scroll_json,updated_at=excluded.updated_at").run(value.userId,value.deviceId,value.activeTerminalId,value.drawerOpen?1:0,value.drawerTab,value.fileTreeRoot,value.fileTreeFollowMode?1:0,JSON.stringify(value.expandedPaths),value.selectedFile,JSON.stringify(value.terminalScroll),value.updatedAt); }
  addHistory(userId:string,terminalId:string,command:string,cwd:string,executedAt:string,exitCode:number|null=null):void {
    const normalized=command.toLowerCase();
    const insert=this.db.prepare("INSERT INTO command_history (user_id,terminal_id,command,command_normalized,cwd,executed_at,exit_code) VALUES (?,?,?,?,?,?,?)").run(userId,terminalId,redact(command),redact(normalized),cwd,executedAt,exitCode);
    // History exists to re-run commands — a repeat only needs its newest entry.
    this.db.prepare("DELETE FROM command_history WHERE user_id=? AND command_normalized=? AND id<>?").run(userId,redact(normalized),insert.lastInsertRowid);
    this.db.prepare("DELETE FROM command_history WHERE user_id=? AND id NOT IN (SELECT id FROM command_history WHERE user_id=? ORDER BY id DESC LIMIT 5000)").run(userId,userId);
  }
  listHistory(userId:string,query="",limit=100,terminalId?:string):CommandHistoryRecord[] {
    const q=`%${query.toLowerCase()}%`;
    // Successful commands only; NULL exit codes are legacy rows captured before tracking existed.
    const successFilter="AND (exit_code IS NULL OR exit_code=0)";
    const rows=terminalId
      ?this.db.prepare(`SELECT * FROM command_history WHERE user_id=? AND terminal_id=? AND command_normalized LIKE ? ${successFilter} ORDER BY id DESC LIMIT ?`).all(userId,terminalId,q,limit)
      :this.db.prepare(`SELECT * FROM command_history WHERE user_id=? AND command_normalized LIKE ? ${successFilter} ORDER BY id DESC LIMIT ?`).all(userId,q,limit);
    const seen=new Set<string>();
    return (rows as any[]).filter((row)=>{ if(seen.has(row.command_normalized))return false; seen.add(row.command_normalized); return true; }).map(rowToHistory);
  }
  deleteHistory(userId:string,id:number):boolean{return this.db.prepare("DELETE FROM command_history WHERE id=? AND user_id=?").run(id,userId).changes===1;}
  clearHistory(userId:string,terminalId?:string):number{return(terminalId?this.db.prepare("DELETE FROM command_history WHERE user_id=? AND terminal_id=?").run(userId,terminalId):this.db.prepare("DELETE FROM command_history WHERE user_id=?").run(userId)).changes;}
}

const parse=(value:string,fallback:any)=>{try{return JSON.parse(value);}catch{return fallback;}};
const rowToTab=(r:any):TerminalTabRecord=>({id:r.id,userId:r.user_id,title:r.title,shell:r.shell,startCwd:r.start_cwd,currentCwd:r.current_cwd,status:r.status as TerminalTabStatus,sortOrder:r.sort_order,createdAt:r.created_at,lastActiveAt:r.last_active_at,exitedAt:r.exited_at,closedAt:r.closed_at});
const rowToPreferences=(r:any):UserPreferences=>({userId:r.user_id,revision:r.revision,theme:r.theme,terminalFontSize:r.terminal_font_size,fileButtonPosition:parse(r.file_button_position_json,{}),keybarPosition:parse(r.keybar_position_json,{}),keybarHidden:!!r.keybar_hidden,keyOrder:parse(r.key_order_json,[]),pinnedCommands:parseStoredPinnedCommands(r.pinned_commands_json),updatedAt:r.updated_at});
const rowToDevice=(r:any):DeviceState=>({userId:r.user_id,deviceId:r.device_id,activeTerminalId:r.active_terminal_id,drawerOpen:!!r.drawer_open,drawerTab:r.drawer_tab,fileTreeRoot:r.file_tree_root,fileTreeFollowMode:!!r.file_tree_follow_mode,expandedPaths:parse(r.expanded_paths_json,[]),selectedFile:r.selected_file,terminalScroll:parse(r.terminal_scroll_json,{}),updatedAt:r.updated_at});
const rowToHistory=(r:any):CommandHistoryRecord=>({id:r.id,userId:r.user_id,terminalId:r.terminal_id,command:r.command,cwd:r.cwd,executedAt:r.executed_at,exitCode:r.exit_code??null});
function redact(value:string):string{return /(?:token|password|secret|api[_-]?key)\s*=/.test(value.toLowerCase())?"[REDACTED]":value;}
