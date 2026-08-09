# 四端酒馆小伴侣联动扩展

同一份扩展支持：

- SillyTavern
- Luker
- Android Termux 中运行的酒馆
- TauriTavern

## 功能

- 自动识别当前酒馆端；识别不准时可以在扩展设置中手动指定。
- 打开聊天、切换角色或编辑角色后，读取角色原头像并生成最高 384×384、90% JPEG 质量的显示图。
- 向小伴侣发送当前角色名、头像、生成中/完成/停止状态、当前酒馆端和安全返回地址。
- 生成期间建立完全本地的 WebRTC DataChannel，并保留针对 `flushFrames` 的后台流式缓冲辅助。
- 不读取或发送聊天内容、角色卡文本和 API 密钥。
- 设置页提供“下载 / 安装酒馆小伴侣”按钮，打开同一 GitHub 仓库中随扩展更新的最新版 APK。

## 四端传输

- TauriTavern 优先使用原有静默通知通道，兼容 1.0 小伴侣。
- Luker、Termux 和 SillyTavern 优先使用 `http://127.0.0.1:18742/sync` 本机通道。
- Android ContentProvider 作为兼容回退。
- 浏览器若限制普通 `fetch`，会再尝试隐藏表单通道；小数据连接测试还可使用像素注册链接。
- TauriTavern 也会先尝试本机直连传头像，再退回使用唯一通知编号的静默分片，减少连续切换角色时旧通知覆盖新通知。
- Android WebView 的隐藏表单可能把错误页误报为加载完成；TauriTavern 即使完成表单提交也会强制再走一次静默通知备份，并为真机放慢通知分片。

## 限制

Android 厂商仍可完全冻结后台 WebView。小伴侣的前台服务、局部唤醒锁和扩展 WebRTC 能减少冻结，但无法对所有系统版本作绝对保证。Luker 的生成后端独立于 WebView，Termux 还应把 Termux 和小伴侣都设为“不限制电量”。

## 安装

将本目录（包括 `TauriTavern-Companion-latest.apk`）发布到 GitHub 后，在每个酒馆的“扩展 → 安装扩展”中粘贴同一个 Git 仓库 URL。版本为 0.12.0。

以后更新时同时覆盖扩展文件和 `TauriTavern-Companion-latest.apk`。用户更新扩展后，在扩展设置中点击“下载 / 安装酒馆小伴侣”，系统浏览器会下载配套 APK；Android 会保留最后一次安装确认。
