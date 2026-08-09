# 四端酒馆小伴侣联动扩展

同一份扩展支持：

- SillyTavern
- Luker
- Android Termux 中运行的酒馆
- TauriTavern（TT）

## 功能

- 自动识别当前酒馆端；识别不准时可以在扩展设置中手动指定。
- 打开聊天、切换角色或编辑角色后，读取角色原头像并生成最高 384×384、90% JPEG 质量的显示图。
- 向小伴侣发送当前角色名、头像、生成中/完成/停止状态、当前酒馆端和安全返回地址。
- 生成期间建立完全本地的 WebRTC DataChannel，并保留针对 `flushFrames` 的后台流式缓冲辅助。
- 不读取或发送聊天内容、角色卡文本和 API 密钥。

## 四端传输

- TT 优先使用原有静默通知通道，兼容 1.0 小伴侣。
- Luker、Termux 和 SillyTavern 优先使用 `http://127.0.0.1:18742/sync` 本机通道。
- Android ContentProvider 作为兼容回退。

## 限制

Android 厂商仍可完全冻结后台 WebView。小伴侣的前台服务、局部唤醒锁和扩展 WebRTC 能减少冻结，但无法对所有系统版本作绝对保证。Luker 的生成后端独立于 WebView，Termux 还应把 Termux 和小伴侣都设为“不限制电量”。

## 安装

将本目录发布到 GitHub、GitLab 或 Gitee 后，在每个酒馆的“扩展 → 安装扩展”中粘贴同一个 Git 仓库 URL。版本为 0.9.0。
