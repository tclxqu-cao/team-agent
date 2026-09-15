export function printLocalDesktopUrl(localUrl: string, log: (line: string) => void = console.log, platform: NodeJS.Platform = process.platform): void {
  log(`远程桌面授权地址：${localUrl.replace(/\/$/, '')}/web`);
  log('请在运行 CLI 的这台电脑上用浏览器打开此地址，配对后点击“远程授权”（盾牌图标）。');
  if (platform === 'win32') log('点击“开启共享”。请保持 Windows 已登录且未锁屏；暂不支持 UAC 安全桌面和管理员窗口控制。');
  else log('按提示授予“屏幕录制”和“辅助功能”权限，然后点击“开启共享”。');
}
