import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteAuthStore } from "./SQLiteAuthStore.js";
import { SQLiteWebConsoleStore } from "./SQLiteWebConsoleStore.js";

describe("SQLiteWebConsoleStore", () => {
  it("persists tabs, preferences, device state, and redacted history", () => {
    const base=mkdtempSync(join(tmpdir(),"customer-agent-console-"));
    const now="2026-08-27T00:00:00.000Z";
    new SQLiteAuthStore(base).createFirstUser({id:"u1",usernameNormalized:"caoqu",usernameDisplay:"caoqu",passwordHash:Buffer.alloc(32),passwordSalt:Buffer.alloc(16),passwordVersion:1,createdAt:now,passwordChangedAt:now});
    const store=new SQLiteWebConsoleStore(base);
    store.createTab({id:"t1",userId:"u1",title:"Shell",shell:"/bin/zsh",startCwd:"/tmp",currentCwd:"/tmp",status:"active",sortOrder:0,createdAt:now,lastActiveAt:now,exitedAt:null,closedAt:null});
    expect(store.listTabs("u1").map(tab=>tab.title)).toEqual(["Shell"]);
    store.updateTab("t1","u1",{title:"OpenCode",currentCwd:"/Users/caoqu"});
    expect(store.listTabs("u1")[0]).toMatchObject({title:"OpenCode",currentCwd:"/Users/caoqu"});

    const preferences={userId:"u1",revision:1,theme:"dark",terminalFontSize:11,fileButtonPosition:{xRatio:.8,yRatio:.5,anchor:"right" as const},keybarPosition:{xRatio:.5,yRatio:.9,anchor:"bottom" as const},keybarHidden:true,keyOrder:["Ctrl"],pinnedCommands:[{id:"codex",command:"codex"}],updatedAt:now};
    expect(store.savePreferences(preferences,null)).toBe(true);
    expect(store.getPreferences("u1")?.keybarHidden).toBe(true);
    expect(store.getPreferences("u1")?.pinnedCommands).toEqual([{id:"codex",command:"codex"}]);

    const device={userId:"u1",deviceId:"phone",activeTerminalId:"t1",drawerOpen:true,drawerTab:"history" as const,fileTreeRoot:"/tmp",fileTreeFollowMode:false,expandedPaths:["/tmp"],selectedFile:null,terminalScroll:{t1:12},updatedAt:now};
    store.saveDeviceState(device);
    expect(store.getDeviceState("u1","phone")?.drawerTab).toBe("history");

    store.addHistory("u1","t1","export API_KEY=secret","/tmp",now);
    store.addHistory("u1","t1","echo hello","/tmp",now);
    expect(store.listHistory("u1").map(item=>item.command)).toEqual(["echo hello","[REDACTED]"]);
    rmSync(base,{recursive:true,force:true});
  });

  it("keeps only successful commands, deduplicated to the newest run", () => {
    const base=mkdtempSync(join(tmpdir(),"customer-agent-history-"));
    new SQLiteAuthStore(base).createFirstUser({id:"u1",usernameNormalized:"caoqu",usernameDisplay:"caoqu",passwordHash:Buffer.alloc(32),passwordSalt:Buffer.alloc(16),passwordVersion:1,createdAt:"2026-09-05T00:00:00.000Z",passwordChangedAt:"2026-09-05T00:00:00.000Z"});
    const store=new SQLiteWebConsoleStore(base);

    store.addHistory("u1","t1","npm test","/a","2026-09-05T00:00:01.000Z",1);
    store.addHistory("u1","t1","npm test","/b","2026-09-05T00:00:02.000Z",0);
    store.addHistory("u1","t1","npm test","/c","2026-09-05T00:00:03.000Z",0);
    store.addHistory("u1","t1","git status","/c","2026-09-05T00:00:04.000Z",null);
    store.addHistory("u1","t1","ls -la","/c","2026-09-05T00:00:05.000Z",2);

    expect(store.listHistory("u1").map(item=>item.command)).toEqual(["git status","npm test"]);
    expect(store.listHistory("u1")[1]).toMatchObject({cwd:"/c",exitCode:0});
    expect(store.listHistory("u1","npm")[0]).toMatchObject({exitCode:0});
    expect(store.listHistory("u1").map(item=>item.exitCode).every(code=>code===null||code===0)).toBe(true);
    rmSync(base,{recursive:true,force:true});
  });
});
