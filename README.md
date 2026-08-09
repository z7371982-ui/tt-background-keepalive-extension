# TT 后台保活实验

这是一个独立的 TauriTavern / SillyTavern 前端扩展。它不替换 TT，不包含聊天界面，也不读取聊天内容或 API 密钥。

## 首版做什么

- 生成开始后建立一个完全本地的 WebRTC DataChannel 自连接，尝试避免 Android WebView 进入强定时器冻结。
- TT 页面隐藏时，只把 TT 自己用于流式文本的 10ms `flushFrames` 定时器改为微任务；不修改其它插件定时器。
- 可选超低音频增强，默认关闭。
- 记录最大心跳间隔，用来判断手机是否仍然冻结了 WebView。
- 可把当前角色卡头像压缩成 144×144 JPEG，通过 `ttcompanion://` 深链接主动交给独立小伴侣 APK。
- 打开聊天、切换角色或编辑角色后会自动同步当前角色名和压缩头像，无需手动挑选图片。

## 重要限制

Android 厂商可以完全暂停后台 WebView。WebRTC 方案能避免 Chromium 的一部分后台节流，但无法保证每台手机都有效。如果测试后最大心跳间隔仍接近整段后台时间，最终稳定方案必须在 TT 原生 Rust/Android 层直接发“生成完成”通知，并在回前台时重放文本。

## 安装

TT 的第三方扩展安装器目前接收 Git URL。把本目录放进一个 Git 仓库后，在 TT 的“扩展 → 安装扩展”中粘贴仓库 URL。开发机也可直接把本目录放到 `data/default-user/extensions/tt-background-keepalive`。
