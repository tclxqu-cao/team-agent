# AgentRoam 常用命令

## 安装或更新

默认安装最新 `preview` 通道版本，无需填写版本号。在希望远程访问的文件夹内执行。

**Mac（M 系列芯片）**

```bash
curl -fsSL https://gitee.com/caoqu/team-agent/raw/master/packages/cli/install/install-agentroam.sh | sh
```

**Windows（x64，PowerShell）**

```powershell
irm https://gitee.com/caoqu/team-agent/raw/master/packages/cli/install/install-agentroam.ps1 | iex
```

## 日常使用

```bash
agentroam service status    # 查看运行状态和本机授权地址
agentroam service url       # 查看手机访问地址
agentroam pair              # 生成配对码和授权二维码，每台新设备执行一次
agentroam devices           # 查看已配对设备
agentroam service restart   # 重启服务
agentroam service stop      # 停止服务
agentroam service start     # 启动服务
```

手机扫描授权二维码直接连接；手输配对码时，需在电脑核对短语并输入 `yes` 批准。

**Mac 远程桌面授权：** 在本机打开状态命令显示的授权地址 → 完成配对 → 顶部显示器图标 → 直播标题旁的“远程授权”盾牌 → 授予屏幕录制和辅助功能权限 → 开启共享。
