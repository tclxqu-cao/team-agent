import { useEffect, useMemo, useState } from "react";
import type { ToolExecutionPolicyView, ToolPolicyProgramRuleView } from "../global.d.ts";

type Policy = ToolExecutionPolicyView;
type Program = ToolPolicyProgramRuleView;

const emptyPolicy = (): Policy => ({
  id: "",
  name: "",
  enabled: true,
  allowedTools: [],
  filesystem: { readRoots: [], writeRoots: [], followSymlinks: false },
  commands: { mode: "deny", programs: [], inheritedEnvironment: [] },
  network: "deny",
  limits: { timeoutMs: 120_000, maxOutputBytes: 1_048_576 },
});

export default function ToolPolicyManager({ onNotice }: {
  onNotice(message: string, type: "success" | "error"): void;
}) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [existing, setExisting] = useState(false);
  const sortedTools = useMemo(() => [...tools].sort(), [tools]);

  const load = async () => {
    if (!window.agentApi?.listToolPolicies) return;
    const response = await window.agentApi.listToolPolicies();
    setPolicies(response.policies);
    setTools(response.tools);
  };

  useEffect(() => { void load().catch((error) => onNotice(String(error), "error")); }, []);

  const save = async () => {
    if (!draft || !window.agentApi?.saveToolPolicy) return;
    try {
      await window.agentApi.saveToolPolicy(draft as unknown as Record<string, unknown>, existing);
      await load();
      setDraft(null);
      onNotice("工具策略已保存", "success");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "工具策略保存失败", "error");
    }
  };

  const remove = async (id: string) => {
    if (!window.agentApi?.deleteToolPolicy) return;
    try {
      await window.agentApi.deleteToolPolicy(id);
      await load();
      if (draft?.id === id) setDraft(null);
      onNotice("工具策略已删除", "success");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "工具策略删除失败", "error");
    }
  };

  return (
    <section className="tool-policy-manager">
      <div className="settings-head-row">
        <h3>工具执行策略</h3>
        <button type="button" className="tool-policy-button" onClick={() => { setDraft(emptyPolicy()); setExisting(false); }}>+ 添加</button>
      </div>
      <div className="tool-policy-list">
        {policies.map((policy) => (
          <div className="tool-policy-row" key={policy.id}>
            <div><strong>{policy.name}</strong><small>{policy.id} · {policy.enabled ? "已启用" : "已停用"}</small></div>
            <div className="tool-policy-actions">
              <button type="button" onClick={() => { setDraft(structuredClone(policy)); setExisting(true); }}>编辑</button>
              <button type="button" className="is-danger" onClick={() => void remove(policy.id)}>删除</button>
            </div>
          </div>
        ))}
        {policies.length === 0 && <div className="tool-policy-empty">暂无工具执行策略</div>}
      </div>
      {draft && (
        <div className="tool-policy-form">
          <div className="tool-policy-grid two">
            <PolicyField label="策略 ID"><input value={draft.id} disabled={existing} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></PolicyField>
            <PolicyField label="名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></PolicyField>
          </div>
          <label className="tool-policy-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用</label>
          <PolicyField label="允许的工具">
            <div className="tool-policy-tools">
              {sortedTools.map((tool) => <label key={tool}><input type="checkbox" checked={draft.allowedTools.includes(tool)} onChange={() => setDraft({ ...draft, allowedTools: toggle(draft.allowedTools, tool) })} />{tool}</label>)}
            </div>
          </PolicyField>
          <div className="tool-policy-grid two">
            <PolicyField label="只读根目录（每行一个）"><textarea value={draft.filesystem.readRoots.join("\n")} onChange={(event) => setDraft({ ...draft, filesystem: { ...draft.filesystem, readRoots: lines(event.target.value) } })} /></PolicyField>
            <PolicyField label="可写根目录（每行一个）"><textarea value={draft.filesystem.writeRoots.join("\n")} onChange={(event) => setDraft({ ...draft, filesystem: { ...draft.filesystem, writeRoots: lines(event.target.value) } })} /></PolicyField>
          </div>
          <label className="tool-policy-check"><input type="checkbox" checked={draft.filesystem.followSymlinks} onChange={(event) => setDraft({ ...draft, filesystem: { ...draft.filesystem, followSymlinks: event.target.checked } })} />允许根目录内符号链接</label>
          <div className="tool-policy-grid three">
            <PolicyField label="命令模式"><select value={draft.commands.mode} onChange={(event) => setDraft({ ...draft, commands: { ...draft.commands, mode: event.target.value as Policy["commands"]["mode"] } })}><option value="deny">禁止</option><option value="allowlist">白名单</option><option value="unrestricted">不限制</option></select></PolicyField>
            <PolicyField label="网络模式"><select value={draft.network} onChange={(event) => setDraft({ ...draft, network: event.target.value as Policy["network"] })}><option value="deny">禁止</option><option value="read-only">只读</option><option value="allow">允许</option></select></PolicyField>
            <PolicyField label="继承环境变量"><input value={draft.commands.inheritedEnvironment.join(", ")} onChange={(event) => setDraft({ ...draft, commands: { ...draft.commands, inheritedEnvironment: csv(event.target.value) } })} /></PolicyField>
          </div>
          {draft.commands.mode === "allowlist" && (
            <div className="tool-policy-programs">
              <div className="settings-head-row"><h4>允许的程序</h4><button type="button" onClick={() => setDraft({ ...draft, commands: { ...draft.commands, programs: [...draft.commands.programs, { executable: "" }] } })}>+ 程序</button></div>
              {draft.commands.programs.map((program, index) => <ProgramEditor key={index} program={program} onChange={(next) => setDraft({ ...draft, commands: { ...draft.commands, programs: replaceAt(draft.commands.programs, index, next) } })} onDelete={() => setDraft({ ...draft, commands: { ...draft.commands, programs: draft.commands.programs.filter((_, itemIndex) => itemIndex !== index) } })} />)}
            </div>
          )}
          <div className="tool-policy-grid two">
            <PolicyField label="超时（毫秒）"><input type="number" min={100} max={600000} value={draft.limits.timeoutMs} onChange={(event) => setDraft({ ...draft, limits: { ...draft.limits, timeoutMs: Number(event.target.value) } })} /></PolicyField>
            <PolicyField label="最大输出（字节）"><input type="number" min={1024} max={10485760} value={draft.limits.maxOutputBytes} onChange={(event) => setDraft({ ...draft, limits: { ...draft.limits, maxOutputBytes: Number(event.target.value) } })} /></PolicyField>
          </div>
          <div className="tool-policy-actions"><button type="button" className="is-primary" onClick={() => void save()}>保存策略</button><button type="button" onClick={() => setDraft(null)}>取消</button></div>
        </div>
      )}
    </section>
  );
}

function ProgramEditor({ program, onChange, onDelete }: { program: Program; onChange(next: Program): void; onDelete(): void }) {
  return <div className="tool-policy-program">
    <div className="tool-policy-grid two"><PolicyField label="可执行文件"><input value={program.executable} onChange={(event) => onChange({ ...program, executable: event.target.value })} /></PolicyField><PolicyField label="子命令"><input value={(program.subcommands ?? []).join(", ")} onChange={(event) => onChange({ ...program, subcommands: csv(event.target.value) })} /></PolicyField></div>
    <div className="tool-policy-grid three"><PolicyField label="允许参数"><input value={(program.allowedFlags ?? []).join(", ")} onChange={(event) => onChange({ ...program, allowedFlags: csv(event.target.value) })} /></PolicyField><PolicyField label="禁止参数"><input value={(program.deniedFlags ?? []).join(", ")} onChange={(event) => onChange({ ...program, deniedFlags: csv(event.target.value) })} /></PolicyField><PolicyField label="路径参数"><input value={(program.pathFlags ?? []).join(", ")} onChange={(event) => onChange({ ...program, pathFlags: csv(event.target.value) })} /></PolicyField></div>
    <div className="tool-policy-program-footer"><PolicyField label="位置路径索引"><input value={(program.positionalPathIndexes ?? []).join(", ")} onChange={(event) => onChange({ ...program, positionalPathIndexes: csv(event.target.value).map(Number) })} /></PolicyField><button type="button" className="is-danger" onClick={onDelete}>删除程序</button></div>
  </div>;
}

function PolicyField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="tool-policy-field"><span>{label}</span>{children}</label>; }
function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function csv(value: string) { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function toggle(values: string[], value: string) { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function replaceAt<T>(values: T[], index: number, value: T) { return values.map((item, itemIndex) => itemIndex === index ? value : item); }
