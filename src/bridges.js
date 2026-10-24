/**
 * 桥接器工厂。
 *
 * 本项目仅支持 OneBot 11（QQ）一种接入方式：收发均为结构化数据，
 * 不需要像素级点按、窗口切换或剪贴板转发。
 *
 * 已移除的两种微信接入方式（相关代码见 git 历史或项目备份）：
 *   - 微信 4.x 客户端 UI 自动化：消息面板不支持 Ctrl+A/Ctrl+C，只能发送、无法接收，
 *     且依赖坐标点按与剪贴板，稳定性差并会抢占前台焦点
 *   - wechaty 网页协议：多数账号已无法登录，付费 token 方式另有成本
 */
export async function createBridge(cfg, { engine, logger } = {}) {
  const kind = String(cfg.wechat.puppet || 'onebot').toLowerCase();
  if (kind !== 'onebot' && kind !== 'qq') {
    throw new Error(
      `不再支持的接入方式 WECHAT_PUPPET=${cfg.wechat.puppet}。` +
        `现在只支持 onebot（QQ）——请在 .env 中设置 WECHAT_PUPPET=onebot。`,
    );
  }
  const { OneBotBridge } = await import('./onebot-bridge.js');
  return new OneBotBridge(cfg, { engine, logger });
}

export default createBridge;
