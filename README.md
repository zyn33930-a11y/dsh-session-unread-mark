# @zyn333/dsh-session-unread-mark

DSH Web 插件：在侧栏会话的「…」菜单里 **标为未读 / 标为已读**。未读标记保存在 DSH 服务器上，电脑、手机等所有设备看到的一致。

A DeepSeek Harness (DSH) Web plugin that adds **Mark as unread / Mark as read** to each session's "..." menu in the sidebar. Marks are stored on the DSH Host, so every device sees the same state.

## 安装

DSH「设置 → 插件 → 添加插件」，输入框填：

```
@zyn333/dsh-session-unread-mark
```

装好后刷新页面，在会话的「…」菜单里就能看到「标为未读」。

## 行为

- 标为未读后，会话行显示和 DSH「后台跑完」相同的圆点。
- 对**当前正开着的会话**也能标记：圆点立刻出现，切到别的会话后一直保持；**下次再打开它**时自动变为已读。
- 停留在已标记的会话上刷新页面，标记保留。
- 会话运行中也可以标记，跑完后圆点仍在。
- DSH 自带的「后台跑完」圆点也会存到服务器，刷新、换设备都不丢；打开会话即清除。
- 其他设备的改动：切回页面、窗口获得焦点时立即同步，页面开着时每 30 秒同步一次。

## 实现

- `lib/host.js`（服务器端）：在 DSH 的 `/api` 认证范围内注册两个接口，只有已登录的浏览器能访问：
  - `GET  /api/session-unread-mark.state` → `{ ids: { [sessionId]: { armed, manual } } }`
  - `POST /api/session-unread-mark.set`，body `{ changes: [{ id, mark: { manual } | null }] }` → 修改后的完整状态
  - 标记存在 `$DSH_HOME/storages/session-unread-mark.json`。可在 profile 的 `cordis.patch.yml` 给 `session-unread-mark` 行加 `config: { file: /绝对路径.json }` 改位置。
- `lib/client.js`（浏览器端）：菜单项、圆点显示、与服务器同步。无需构建。

## 兼容性与限制

- 只在 DSH Web（`dsh web`）`0.2.1-rc.2`、`0.2.2-rc.1` 上验证过；桌面版未验证。
- 依赖 DSH 内部字段 `uiSession.completionUnread` / `publishStatus()` 和 `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuItemButton`。DSH 升级后若这些字段不存在，插件只在浏览器控制台打印警告并停用，不影响页面。
- 设备之间靠定时拉取同步，不是实时推送。

## License

MIT
