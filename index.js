import {
    chat,
    characters,
    eventSource,
    event_types,
    getThumbnailUrl,
    isGenerating,
    saveSettingsDebounced,
    streamingProcessor,
    this_chid,
} from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

const MODULE_NAME = 'tt-background-keepalive';
const RESOURCE_NAME = 'third-party/tt-background-keepalive-extension';
const COMPANION_BRIDGE_URL = 'http://127.0.0.1:18742/sync';
const COMPANION_WEBSOCKET_URLS = [
    'ws://127.0.0.1:18742/ws',
    'ws://[::1]:18742/ws',
];
const COMPANION_FORM_BRIDGE_URL = 'http://127.0.0.1:18742/form-sync';
const COMPANION_REGISTER_URL = 'http://127.0.0.1:18742/register';
const COMPANION_OPEN_TAURI_NOTIFICATION_SETTINGS_URL = 'http://127.0.0.1:18742/open-settings?target=tauri-notifications';
const COMPANION_CONTENT_URL = 'content://com.cicimil.ttcompanion.bridge/sync';
const COMPANION_APK_VERSION = '1.6.3';
const COMPANION_APK_URL = 'https://raw.githubusercontent.com/z7371982-ui/tt-background-keepalive-extension/main/TauriTavern-Companion-latest.apk';
const COMPANION_NOTIFICATION_TITLE = 'TT_COMPANION_SYNC_V1';
const COMPANION_NOTIFICATION_CHANNEL = 'four_tavern_companion_sync';
const COMPANION_PACKET_CHARS = 2_800;
const EXTENSION_VERSION = '0.17.4';
const DEFAULTS = Object.freeze({
    rtcEnabled: true,
    streamAssist: true,
    audioFallback: false,
    autoWake: true,
    autoCharacterSync: true,
    hostMode: 'auto',
});

const USER_AGENT = navigator.userAgent || '';
const IS_ANDROID_WEBVIEW = /Android/i.test(USER_AGENT) && /;\s*wv\)/i.test(USER_AGENT);
const IS_REDMI_NOTE_10_PRO = /\b(?:M2104K10AC|M2101K6(?:G|I|R)?)\b/i.test(USER_AGENT);

const diagnostics = {
    loadedAt: new Date().toISOString(),
    generationActive: false,
    generationStartedAt: null,
    generationEndedAt: null,
    rtcState: '未启动',
    rtcError: '',
    visibilityChanges: 0,
    lastHeartbeatAt: Date.now(),
    largestHeartbeatGapMs: 0,
    assistedFlushes: 0,
    lastCharacterSyncAt: null,
    lastCharacterSyncKey: '',
    companionBridgeState: '未测试',
    companionBridgeError: '',
    notificationPermission: '未检查',
    notificationChannel: '未创建',
    compatibilityMode: IS_REDMI_NOTE_10_PRO
        ? 'Redmi Note 10 Pro：HTTP 优先＋完成检测兜底'
        : (IS_ANDROID_WEBVIEW ? 'Android WebView 标准模式' : '标准模式'),
    generationWatchdogState: '空闲',
    completionFallbacks: 0,
    criticalEventDeliveries: 0,
    watchdogOutputChanges: 0,
    watchdogStableMs: 0,
    watchdogCoreGenerating: false,
    watchdogStreamState: '未检测',
    watchdogUiState: '未检测',
    lastCompletionSource: '',
};

let rtcPeerA = null;
let rtcPeerB = null;
let rtcSendChannel = null;
let rtcReceiveChannel = null;
let rtcPulseTimer = null;
let audioContext = null;
let audioOscillator = null;
let audioGain = null;
let heartbeatTimer = null;
let characterSyncTimer = null;
let characterSyncInFlight = false;
let lastSyncedCharacterKey = '';
let notificationBridgeReady = false;
let notificationChannelAttempted = false;
let notificationSettingsJumpAt = 0;
let generationWatchdogTimer = null;
let generationBaselineFingerprint = '';
let generationLastFingerprint = '';
let generationLastOutputChangeAt = 0;
let generationLastTokenAt = 0;
let generationStartedAtMs = 0;
let generationObservedOutput = false;
let generationIdleSamples = 0;
let generationUiIdleSamples = 0;
let generationStopInFlight = false;
let generationStopButtonSeen = false;
let generationHeuristicCompletedAt = 0;

function collectAccessibleWindows(startWindow = window) {
    const windows = [];
    let current = startWindow;
    while (current && !windows.includes(current)) {
        windows.push(current);
        try {
            const parent = current.parent;
            if (!parent || parent === current || !parent.document) {
                break;
            }
            void parent.document.documentElement;
            current = parent;
        } catch {
            break;
        }
    }
    return windows;
}

function detectTavernHost() {
    const override = extension_settings[MODULE_NAME]?.hostMode;
    const manualHosts = {
        tt: { id: 'tt', label: 'TauriTavern' },
        luker: { id: 'luker', label: 'Luker' },
        termux: { id: 'termux', label: 'Termux 酒馆' },
        sillytavern: { id: 'sillytavern', label: 'SillyTavern' },
    };
    if (manualHosts[override]) {
        return manualHosts[override];
    }

    const windows = collectAccessibleWindows();
    const isTt = windows.some(owner => {
        try {
            return owner?.__TAURI_RUNNING__ === true
                || Boolean(owner?.__TAURITAVERN__)
                || Boolean(owner?.__TAURI_INTERNALS__);
        } catch {
            return false;
        }
    });
    if (isTt) {
        return { id: 'tt', label: 'TauriTavern' };
    }

    const isLuker = windows.some(owner => {
        try {
            return typeof owner?.Luker?.getContext === 'function';
        } catch {
            return false;
        }
    });
    if (isLuker) {
        return { id: 'luker', label: 'Luker' };
    }

    const hostname = String(location.hostname || '').toLowerCase();
    const isLoopback = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1'
        || hostname.endsWith('.localhost');
    if (/Android/i.test(navigator.userAgent) && isLoopback) {
        return { id: 'termux', label: 'Termux 酒馆' };
    }
    return { id: 'sillytavern', label: 'SillyTavern' };
}

function currentReturnUrl() {
    try {
        const url = new URL(location.href);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return '';
        }
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString().slice(0, 2048);
    } catch {
        return '';
    }
}

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULTS);
    }

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (typeof extension_settings[MODULE_NAME][key] !== typeof value) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    if (!['auto', 'tt', 'luker', 'termux', 'sillytavern'].includes(extension_settings[MODULE_NAME].hostMode)) {
        extension_settings[MODULE_NAME].hostMode = 'auto';
    }

    return extension_settings[MODULE_NAME];
}

function notify(level, message, title = '四端酒馆小伴侣') {
    const toast = globalThis.toastr?.[level];
    if (typeof toast === 'function') {
        toast(message, title);
    } else {
        console[level === 'error' ? 'error' : 'info'](`[${title}] ${message}`);
    }
}

function setText(selector, text) {
    const element = document.querySelector(selector);
    if (element) {
        element.textContent = text;
    }
}

function renderStatus() {
    setText('#ttka_extension_version', EXTENSION_VERSION);
    setText('#ttka_generation_state', diagnostics.generationActive ? '正在生成' : '空闲');
    setText('#ttka_visibility_state', document.visibilityState === 'hidden' ? '后台/隐藏' : '可见');
    setText('#ttka_rtc_state', diagnostics.rtcState);
    setText('#ttka_companion_bridge_state', diagnostics.companionBridgeState);
    setText('#ttka_notification_permission', diagnostics.notificationPermission);
    setText('#ttka_notification_channel', diagnostics.notificationChannel);
    setText('#ttka_host_state', detectTavernHost().label);
    setText('#ttka_compatibility_mode', diagnostics.compatibilityMode);
    setText('#ttka_watchdog_state', diagnostics.generationWatchdogState);
    setText(
        '#ttka_heartbeat_gap',
        diagnostics.largestHeartbeatGapMs > 0
            ? `${(diagnostics.largestHeartbeatGapMs / 1000).toFixed(1)} 秒`
            : '—',
    );
}

function updateRtcState(state, error = '') {
    diagnostics.rtcState = state;
    diagnostics.rtcError = error;
    renderStatus();
}

function closeRtcGuard() {
    if (rtcPulseTimer !== null) {
        clearInterval(rtcPulseTimer);
        rtcPulseTimer = null;
    }

    for (const target of [rtcSendChannel, rtcReceiveChannel, rtcPeerA, rtcPeerB]) {
        try {
            target?.close?.();
        } catch {
            // Already closed.
        }
    }

    rtcSendChannel = null;
    rtcReceiveChannel = null;
    rtcPeerA = null;
    rtcPeerB = null;
    updateRtcState('未启动');
}

async function startRtcGuard() {
    closeRtcGuard();
    if (!settings().rtcEnabled || !diagnostics.generationActive) {
        return;
    }

    if (IS_REDMI_NOTE_10_PRO) {
        updateRtcState('红米兼容模式（已跳过）');
        return;
    }

    if (typeof RTCPeerConnection !== 'function') {
        updateRtcState('不可用', 'RTCPeerConnection unavailable');
        return;
    }

    updateRtcState('连接中');

    try {
        rtcPeerA = new RTCPeerConnection({ iceServers: [] });
        rtcPeerB = new RTCPeerConnection({ iceServers: [] });

        rtcPeerA.onicecandidate = ({ candidate }) => {
            if (candidate) {
                void rtcPeerB?.addIceCandidate(candidate).catch(() => {});
            }
        };
        rtcPeerB.onicecandidate = ({ candidate }) => {
            if (candidate) {
                void rtcPeerA?.addIceCandidate(candidate).catch(() => {});
            }
        };

        const opened = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('DataChannel open timeout')), 5000);

            rtcPeerB.ondatachannel = (event) => {
                rtcReceiveChannel = event.channel;
                rtcReceiveChannel.onmessage = () => {};
            };

            rtcSendChannel = rtcPeerA.createDataChannel('tt-background-keepalive', {
                ordered: false,
                maxRetransmits: 0,
            });
            rtcSendChannel.onopen = () => {
                clearTimeout(timeout);
                resolve();
            };
            rtcSendChannel.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('DataChannel failed'));
            };
        });

        const offer = await rtcPeerA.createOffer();
        await rtcPeerA.setLocalDescription(offer);
        await rtcPeerB.setRemoteDescription(offer);
        const answer = await rtcPeerB.createAnswer();
        await rtcPeerB.setLocalDescription(answer);
        await rtcPeerA.setRemoteDescription(answer);
        await opened;

        if (!diagnostics.generationActive) {
            closeRtcGuard();
            return;
        }

        updateRtcState('已连接');
        rtcSendChannel.send('ready');
        rtcPulseTimer = setInterval(() => {
            if (rtcSendChannel?.readyState === 'open') {
                rtcSendChannel.send(String(Date.now()));
            }
        }, 15_000);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        closeRtcGuard();
        updateRtcState('连接失败', message);
        console.warn('[Four Tavern Companion] WebRTC guard failed:', error);
    }
}

async function startAudioFallback() {
    if (!settings().audioFallback || !diagnostics.generationActive || audioContext) {
        return;
    }

    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') {
        return;
    }

    try {
        audioContext = new AudioContextClass();
        audioOscillator = audioContext.createOscillator();
        audioGain = audioContext.createGain();
        audioOscillator.type = 'sine';
        audioOscillator.frequency.value = 31;
        audioGain.gain.value = 0.0007;
        audioOscillator.connect(audioGain);
        audioGain.connect(audioContext.destination);
        audioOscillator.start();
        await audioContext.resume();
    } catch (error) {
        console.warn('[Four Tavern Companion] Audio fallback failed:', error);
        await stopAudioFallback();
    }
}

async function stopAudioFallback() {
    try {
        audioOscillator?.stop?.();
    } catch {
        // Already stopped.
    }
    try {
        await audioContext?.close?.();
    } catch {
        // Already closed.
    }
    audioOscillator = null;
    audioGain = null;
    audioContext = null;
}

function companionPayload({ name = '', avatar = '', event = '' } = {}) {
    const host = detectTavernHost();
    return {
        bridge: COMPANION_NOTIFICATION_TITLE,
        name: String(name).slice(0, 80),
        avatar,
        event: String(event).slice(0, 24),
        source: host.id,
        sourceLabel: host.label,
        returnUrl: currentReturnUrl(),
        wake: 600,
    };
}

function getTauriInvoke() {
    const internalInvoke = globalThis.__TAURI_INTERNALS__?.invoke;
    if (typeof internalInvoke === 'function') {
        return internalInvoke;
    }
    const publicInvoke = globalThis.__TAURI__?.core?.invoke;
    return typeof publicInvoke === 'function' ? publicInvoke : null;
}

function openTauriNotificationSettingsThroughCompanion() {
    const now = Date.now();
    if (now - notificationSettingsJumpAt < 15_000) {
        return;
    }
    notificationSettingsJumpAt = now;

    const frameName = `ttka_settings_${now}`;
    const frame = document.createElement('iframe');
    frame.name = frameName;
    frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;border:0';
    frame.setAttribute('aria-hidden', 'true');
    const form = document.createElement('form');
    form.method = 'GET';
    form.action = COMPANION_OPEN_TAURI_NOTIFICATION_SETTINGS_URL;
    form.target = frameName;
    form.style.display = 'none';
    (document.body || document.documentElement).append(frame, form);
    form.submit();
    setTimeout(() => {
        form.remove();
        frame.remove();
    }, 2500);
}

async function ensureTauriNotificationBridge({ request = false } = {}) {
    const invoke = getTauriInvoke();
    if (!invoke) {
        diagnostics.notificationPermission = '当前端不使用 Tauri 通知';
        diagnostics.notificationChannel = '不适用';
        renderStatus();
        throw new Error('Tauri notification bridge unavailable');
    }

    let permissionGranted = false;
    try {
        permissionGranted = Boolean(await invoke('plugin:notification|is_permission_granted'));
        if (!permissionGranted && request) {
            const permission = await invoke('plugin:notification|request_permission');
            permissionGranted = permission === 'granted';
        }
    } catch (error) {
        diagnostics.notificationPermission = '无法检查';
        diagnostics.notificationChannel = '未创建';
        renderStatus();
        throw new Error(`Notification permission check failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    diagnostics.notificationPermission = permissionGranted ? '已允许' : '未允许';
    if (!permissionGranted) {
        diagnostics.notificationPermission = '未允许（正在打开设置）';
        diagnostics.notificationChannel = '等待权限';
        renderStatus();
        openTauriNotificationSettingsThroughCompanion();
        throw new Error('TauriTavern notification permission is not granted');
    }

    if (!notificationChannelAttempted) {
        notificationChannelAttempted = true;
        try {
            await invoke('plugin:notification|create_channel', {
                id: COMPANION_NOTIFICATION_CHANNEL,
                name: '酒馆小伴侣同步（静默）',
                description: '仅用于把当前角色名、头像和生成状态交给酒馆小伴侣',
                importance: 2,
                visibility: -1,
                vibration: false,
                lights: false,
            });
            notificationBridgeReady = true;
        } catch (error) {
            notificationBridgeReady = false;
            console.warn(
                '[Four Tavern Companion] Custom notification channel unavailable; using the TauriTavern default channel:',
                error,
            );
        }
    }

    diagnostics.notificationChannel = notificationBridgeReady ? '已创建' : '使用默认频道';
    renderStatus();
    return true;
}

async function openCompanionInstaller() {
    let openedExternally = false;
    const invoke = getTauriInvoke();
    if (invoke) {
        try {
            await invoke('plugin:opener|open_url', {
                url: COMPANION_APK_URL,
                with: undefined,
            });
            openedExternally = true;
        } catch (error) {
            console.info('[Four Tavern Companion] Native opener unavailable, using browser fallback:', error);
        }
    }

    if (!openedExternally) {
        const link = document.createElement('a');
        link.href = COMPANION_APK_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.download = `TauriTavern-Companion-${COMPANION_APK_VERSION}.apk`;
        (document.body || document.documentElement).append(link);
        link.click();
        link.remove();
    }

    notify('info', `正在下载酒馆小伴侣 ${COMPANION_APK_VERSION}；下载完成后请确认安装。`);
}

async function sendSilentNotificationPacket(encodedPacket, notificationId) {
    const invoke = getTauriInvoke();
    if (!invoke) {
        throw new Error('Tauri notification bridge unavailable');
    }

    const chunks = [];
    for (let offset = 0; offset < encodedPacket.length; offset += 3000) {
        chunks.push(encodedPacket.slice(offset, offset + 3000));
    }
    if (chunks.length === 0 || chunks.length > 5) {
        throw new Error('Companion payload is too large');
    }

    const options = {
        id: notificationId,
        title: COMPANION_NOTIFICATION_TITLE,
        body: '正在同步角色与生成状态',
        inboxLines: chunks,
        group: 'tt_companion_bridge',
        autoCancel: true,
        silent: true,
        visibility: -1,
    };
    if (notificationBridgeReady) {
        options.channelId = COMPANION_NOTIFICATION_CHANNEL;
    }
    await invoke('plugin:notification|notify', { options });
}

async function syncThroughSilentNotification(payload) {
    await ensureTauriNotificationBridge();
    const encodedPayload = JSON.stringify(payload);
    const notificationBase = 10_000 + Math.floor(Math.random() * 1_000_000);
    if (encodedPayload.length <= COMPANION_PACKET_CHARS) {
        await sendSilentNotificationPacket(encodedPayload, notificationBase);
        return;
    }

    const transfer = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const total = Math.ceil(encodedPayload.length / COMPANION_PACKET_CHARS);
    if (total > 64) {
        throw new Error('Companion avatar is too large');
    }

    // Deliver the small state/name packet first, so one dropped avatar fragment
    // cannot also hide generation state and the current character name.
    await sendSilentNotificationPacket(JSON.stringify({ ...payload, avatar: '' }), notificationBase);
    await new Promise(resolve => setTimeout(resolve, 260));

    for (let index = 0; index < total; index += 1) {
        const packet = JSON.stringify({
            bridge: COMPANION_NOTIFICATION_TITLE,
            kind: 'multipart',
            transfer,
            index,
            total,
            chunk: encodedPayload.slice(
                index * COMPANION_PACKET_CHARS,
                (index + 1) * COMPANION_PACKET_CHARS,
            ),
        });
        await sendSilentNotificationPacket(packet, notificationBase + index + 1);
        // Physical Android 16 devices can throttle a burst of notifications even when
        // an emulator accepts it. Keep the packets ordered and comfortably spaced.
        await new Promise(resolve => setTimeout(resolve, 260));
    }
}

function syncThroughAndroidContentProvider(payload) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Android content bridge timed out'));
        }, 2200);
        const cleanup = () => {
            clearTimeout(timeout);
            image.onload = null;
            image.onerror = null;
            image.remove();
        };
        image.onload = () => {
            cleanup();
            resolve(true);
        };
        image.onerror = () => {
            cleanup();
            reject(new Error('Android content bridge unavailable'));
        };
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
        const query = new URLSearchParams({
            name: payload.name,
            avatar: payload.avatar,
            event: payload.event,
            source: payload.source,
            returnUrl: payload.returnUrl,
            wake: String(payload.wake),
            t: String(Date.now()),
        });
        image.src = `${COMPANION_CONTENT_URL}?${query.toString()}`;
        (document.body || document.documentElement).append(image);
    });
}

async function syncThroughLoopback(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
        await fetch(`${COMPANION_BRIDGE_URL}?t=${Date.now()}`, {
            method: 'POST',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

function syncThroughOneLoopbackWebSocket(url, payload) {
    return new Promise((resolve, reject) => {
        let socket;
        let settled = false;
        const timeout = setTimeout(() => finish(new Error(`${url} timed out`)), 1800);
        const finish = (error = null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            try {
                socket?.close();
            } catch {
                // The peer may already have closed after acknowledging the packet.
            }
            if (error) {
                reject(error);
            } else {
                resolve(true);
            }
        };

        try {
            socket = new WebSocket(`${url}?t=${Date.now()}`);
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        socket.onopen = () => {
            try {
                socket.send(JSON.stringify(payload));
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        };
        socket.onmessage = event => {
            try {
                const acknowledgement = JSON.parse(String(event.data || ''));
                if (acknowledgement?.ok === true) {
                    finish();
                } else {
                    finish(new Error('Companion rejected the WebSocket packet'));
                }
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        };
        socket.onerror = () => finish(new Error(`${url} unavailable`));
        socket.onclose = () => {
            if (!settled) {
                finish(new Error('Local WebSocket closed before acknowledgement'));
            }
        };
    });
}

async function syncThroughLoopbackWebSocket(payload) {
    const failures = [];
    for (const url of COMPANION_WEBSOCKET_URLS) {
        try {
            await syncThroughOneLoopbackWebSocket(url, payload);
            return true;
        } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
        }
    }
    throw new Error(`IPv4/IPv6 local WebSocket failed: ${failures.join('; ')}`);
}

function syncThroughLoopbackForm(payload) {
    return new Promise((resolve, reject) => {
        const frameName = `tt_companion_bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const iframe = document.createElement('iframe');
        const form = document.createElement('form');
        let submitted = false;
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Browser form bridge timed out'));
        }, 3500);
        const cleanup = () => {
            clearTimeout(timeout);
            iframe.onload = null;
            iframe.remove();
            form.remove();
        };

        iframe.name = frameName;
        iframe.setAttribute('aria-hidden', 'true');
        iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;border:0';
        iframe.onload = () => {
            if (!submitted) {
                submitted = true;
                try {
                    form.submit();
                } catch (error) {
                    cleanup();
                    reject(error);
                }
                return;
            }
            cleanup();
            resolve(true);
        };
        iframe.srcdoc = '<!doctype html><title>bridge</title>';

        form.method = 'POST';
        form.action = `${COMPANION_FORM_BRIDGE_URL}?t=${Date.now()}`;
        form.target = frameName;
        form.style.display = 'none';
        for (const [name, value] of Object.entries(payload)) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            input.value = String(value ?? '');
            form.append(input);
        }
        (document.body || document.documentElement).append(iframe, form);
    });
}

function syncThroughLoopbackRegistration(payload) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Browser registration timed out'));
        }, 2500);
        const cleanup = () => {
            clearTimeout(timeout);
            image.onload = null;
            image.onerror = null;
            image.remove();
        };
        image.onload = () => {
            cleanup();
            resolve(true);
        };
        image.onerror = () => {
            cleanup();
            reject(new Error('Browser registration unavailable'));
        };
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
        const query = new URLSearchParams({
            name: payload.name,
            event: payload.event,
            source: payload.source,
            returnUrl: payload.returnUrl,
            t: String(Date.now()),
        });
        image.src = `${COMPANION_REGISTER_URL}?${query.toString()}`;
        (document.body || document.documentElement).append(image);
    });
}

async function postToCompanion(input = {}) {
    const payload = companionPayload(input);
    const errors = [];
    const tryTransport = async (label, transport) => {
        try {
            await transport(payload);
            diagnostics.companionBridgeState = `已连接（${label}）`;
            diagnostics.companionBridgeError = '';
            renderStatus();
            return true;
        } catch (error) {
            errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    };

    if (IS_REDMI_NOTE_10_PRO) {
        // MIUI 14 may suspend this WebView during the several seconds spent
        // waiting for failed WebSocket attempts. Use the proven loopback HTTP
        // path first so small state packets leave the page immediately.
        if (await tryTransport('红米 HTTP 优先通道', syncThroughLoopback)) {
            return true;
        }
        if (await tryTransport('四端本机 WebSocket 直连', syncThroughLoopbackWebSocket)) {
            return true;
        }
    } else {
        if (await tryTransport('四端本机 WebSocket 直连', syncThroughLoopbackWebSocket)) {
            return true;
        }
        if (await tryTransport('四端本机 HTTP 通道', syncThroughLoopback)) {
            return true;
        }
    }
    if (payload.source === 'tt') {
        // A blocked form navigation still fires iframe.onload in some Android WebViews.
        // Submit it as a best-effort direct path, but never let that false-positive
        // suppress TT's notification bridge on a physical phone.
        const formSubmitted = await tryTransport('浏览器表单已提交', syncThroughLoopbackForm);
        if (await tryTransport('TauriTavern 静默通知备份已发出', syncThroughSilentNotification)) {
            return true;
        }
        if (formSubmitted) {
            return true;
        }
    } else if (await tryTransport('浏览器表单通道', syncThroughLoopbackForm)) {
        return true;
    }
    if (await tryTransport('Android 系统通道', syncThroughAndroidContentProvider)) {
        return true;
    }
    if (!payload.avatar
        && await tryTransport('浏览器注册链接', syncThroughLoopbackRegistration)) {
        return true;
    }

    diagnostics.companionBridgeState = '未连接';
    diagnostics.companionBridgeError = errors.join('; ');
    renderStatus();
    throw new Error(diagnostics.companionBridgeError);
}

async function postCriticalCompanionEvent(event) {
    const payload = companionPayload({ event });

    if (!IS_REDMI_NOTE_10_PRO) {
        return postToCompanion({ event });
    }

    // Send the state through two loopback request shapes at once. The local
    // companion de-duplicates identical events, so this is safe and avoids a
    // missed completion when MIUI freezes the WebView immediately afterwards.
    const results = await Promise.allSettled([
        syncThroughLoopback(payload),
        syncThroughLoopbackRegistration(payload),
    ]);
    if (results.some(result => result.status === 'fulfilled')) {
        diagnostics.criticalEventDeliveries += 1;
        diagnostics.companionBridgeState = '已连接（红米双路 HTTP 状态通道）';
        diagnostics.companionBridgeError = '';
        renderStatus();
        return true;
    }

    return postToCompanion({ event });
}

async function testCompanionConnection() {
    try {
        await postToCompanion();
        notify('success', `已从 ${detectTavernHost().label} 连到小伴侣。`);
    } catch (error) {
        console.warn('[Four Tavern Companion] Connection test failed:', error);
        notify('warning', '没有连到小伴侣。请先在小伴侣里启动悬浮窗，再重新测试。');
    }
}

async function enableTauriSyncPermission() {
    try {
        await ensureTauriNotificationBridge({ request: true });
        notify('success', `TauriTavern 通知权限已允许；同步频道：${diagnostics.notificationChannel}。`);
        await syncCurrentCharacter({ force: true });
    } catch (error) {
        console.warn('[Four Tavern Companion] Notification permission setup failed:', error);
        if (diagnostics.notificationPermission.startsWith('未允许')) {
            openTauriNotificationSettingsThroughCompanion();
            notify('warning', 'TauriTavern 通知权限没有开启，已经让小伴侣直接打开对应设置页。');
        } else {
            notify('warning', `TauriTavern 通知已允许，但同步初始化失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

async function manualSyncCurrentCharacter() {
    await syncCurrentCharacter({ force: true });
}

function imageFromBlob(blob) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const objectUrl = URL.createObjectURL(blob);
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Avatar decode failed'));
        };
        image.src = objectUrl;
    });
}

async function makeAvatarThumbnail(avatarFile) {
    if (!avatarFile || avatarFile === 'none') {
        return '';
    }

    let image = null;
    try {
        const originalResponse = await fetch(`/characters/${encodeURIComponent(avatarFile)}`, { cache: 'no-store' });
        if (originalResponse.ok) {
            image = await imageFromBlob(await originalResponse.blob());
        }
    } catch {
        // Fall back to the thumbnail endpoint on hosts that hide original avatars.
    }
    if (!image) {
        const thumbnailResponse = await fetch(getThumbnailUrl('avatar', avatarFile));
        if (!thumbnailResponse.ok) {
            throw new Error(`Avatar request failed (${thumbnailResponse.status})`);
        }
        image = await imageFromBlob(await thumbnailResponse.blob());
    }

    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = Math.max(0, (image.naturalWidth - side) / 2);
    const sourceY = Math.max(0, (image.naturalHeight - side) / 2);
    const outputSize = Math.max(1, Math.min(384, side));
    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.fillStyle = '#f8efe9';
    context.fillRect(0, 0, outputSize, outputSize);
    context.drawImage(image, sourceX, sourceY, side, side, 0, 0, outputSize, outputSize);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] || '';
}

async function syncCurrentCharacter({ quiet = false, force = false, event = '' } = {}) {
    const character = this_chid === undefined ? null : characters[this_chid];
    if (!character) {
        if (!quiet) {
            notify('warning', '请先打开一个单人角色聊天。');
        }
        return false;
    }

    const syncKey = `${String(this_chid)}|${String(character.name || '')}|${String(character.avatar || '')}`;
    if (!force && syncKey === lastSyncedCharacterKey) {
        if (event) {
            await postToCompanion({ event });
        }
        return true;
    }
    if (characterSyncInFlight) {
        if (event) {
            await postToCompanion({ event });
        }
        return false;
    }

    characterSyncInFlight = true;
    try {
        const avatar = await makeAvatarThumbnail(character.avatar);
        await postToCompanion({ name: character.name, avatar, event });
        lastSyncedCharacterKey = syncKey;
        diagnostics.lastCharacterSyncKey = syncKey;
        diagnostics.lastCharacterSyncAt = new Date().toISOString();
        if (!quiet) {
            notify('success', '已把当前角色的压缩头像交给小伴侣。');
        }
        return true;
    } catch (error) {
        console.warn('[Four Tavern Companion] Character sync failed:', error);
        try {
            await postToCompanion({ name: character.name, event });
        } catch {
            // The companion may simply not be running. Never navigate the tavern away as a fallback.
        }
        if (!quiet) {
            notify('warning', '没有连到小伴侣。请先打开新版小伴侣并启动悬浮窗，再重试。');
        }
        return false;
    } finally {
        characterSyncInFlight = false;
    }
}

function scheduleAutomaticCharacterSync(delay = 650) {
    if (!settings().autoCharacterSync) {
        return;
    }
    if (characterSyncTimer !== null) {
        clearTimeout(characterSyncTimer);
    }
    characterSyncTimer = setTimeout(async () => {
        characterSyncTimer = null;
        if (characterSyncInFlight) {
            scheduleAutomaticCharacterSync(500);
            return;
        }
        await syncCurrentCharacter({ quiet: true });
    }, delay);
}

function diagnosticReport() {
    return JSON.stringify({
        extensionVersion: EXTENSION_VERSION,
        tavernHost: detectTavernHost(),
        returnUrl: currentReturnUrl(),
        userAgent: navigator.userAgent,
        visibility: document.visibilityState,
        settings: { ...settings() },
        ...diagnostics,
        now: new Date().toISOString(),
    }, null, 2);
}

async function copyDiagnostics() {
    try {
        await navigator.clipboard.writeText(diagnosticReport());
        notify('success', '诊断信息已复制。');
    } catch {
        notify('error', '复制失败，请在控制台查看诊断。');
        console.info('[Four Tavern Companion diagnostic]', diagnosticReport());
    }
}

function installSurgicalStreamAssist() {
    if (globalThis.__TT_KEEPALIVE_TIMER_PATCH__) {
        return;
    }

    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const canceled = new Set();
    let nextSyntheticId = -1;

    globalThis.setTimeout = function ttKeepaliveSetTimeout(handler, delay = 0, ...args) {
        // This hook sits on a very hot browser path. Return immediately for
        // ordinary timers; Function#toString is used only for the rare 10 ms
        // timer while TT is actively generating in the background.
        if (typeof handler !== 'function'
            || Number(delay) !== 10
            || !diagnostics.generationActive
            || document.visibilityState !== 'hidden'
            || !settings().streamAssist) {
            return nativeSetTimeout(handler, delay, ...args);
        }

        const isNamedFlush = handler.name === 'flushFrames';
        const isTtFrameFlush = isNamedFlush
            || Function.prototype.toString.call(handler).includes('flushFrames');
        if (isTtFrameFlush) {
            const syntheticId = nextSyntheticId--;
            queueMicrotask(() => {
                if (!canceled.delete(syntheticId)) {
                    diagnostics.assistedFlushes += 1;
                    handler(...args);
                }
            });
            return syntheticId;
        }

        return nativeSetTimeout(handler, delay, ...args);
    };

    globalThis.clearTimeout = function ttKeepaliveClearTimeout(id) {
        if (typeof id === 'number' && id < 0) {
            canceled.add(id);
            return;
        }
        nativeClearTimeout(id);
    };

    Object.defineProperty(globalThis, '__TT_KEEPALIVE_TIMER_PATCH__', {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });
}

function latestAssistantSnapshot() {
    let chatFingerprint = '';
    let chatTextLength = 0;
    if (Array.isArray(chat)) {
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const message = chat[index];
            if (!message || message.is_user || message.is_system) {
                continue;
            }
            const text = String(message.mes ?? '');
            chatTextLength = text.length;
            chatFingerprint = `${index}|${text.length}|${text.slice(-160)}|${String(message.gen_finished ?? '')}`;
            break;
        }
    }

    // Some TauriTavern builds commit streaming text to the DOM before the
    // exported chat array catches up. Include the visible message as a second,
    // independent signal so the watchdog is not tied to one implementation.
    let domFingerprint = '';
    let domTextLength = 0;
    for (const owner of collectAccessibleWindows()) {
        try {
            const messages = Array.from(owner.document.querySelectorAll('#chat .mes'));
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                const message = messages[index];
                if (message.getAttribute('is_user') === 'true'
                    || message.getAttribute('is_system') === 'true') {
                    continue;
                }
                const text = String(message.querySelector('.mes_text')?.textContent ?? '');
                domTextLength = text.length;
                domFingerprint = `${message.getAttribute('mesid') ?? index}|${text.length}|${text.slice(-160)}`;
                break;
            }
            if (domFingerprint) {
                break;
            }
        } catch {
            // Cross-origin parent windows are intentionally ignored.
        }
    }

    return {
        fingerprint: `${chatFingerprint}||${domFingerprint}`,
        textLength: Math.max(chatTextLength, domTextLength),
    };
}

function generationUiSnapshot() {
    for (const owner of collectAccessibleWindows()) {
        try {
            const stopButton = owner.document.querySelector('#mes_stop');
            const sendButton = owner.document.querySelector('#send_but');
            if (!(stopButton instanceof owner.HTMLElement) || !(sendButton instanceof owner.HTMLElement)) {
                continue;
            }
            const isVisible = element => {
                const style = owner.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            };
            return {
                stopVisible: isVisible(stopButton),
                sendVisible: isVisible(sendButton),
            };
        } catch {
            // Try the next accessible owner window.
        }
    }
    return { stopVisible: false, sendVisible: false };
}

function finishFromWatchdog(source) {
    diagnostics.completionFallbacks += 1;
    diagnostics.generationWatchdogState = `${source}已触发`;
    if (source === '正文静止超时兜底') {
        generationHeuristicCompletedAt = Date.now();
    }
    if (generationWatchdogTimer !== null) {
        clearInterval(generationWatchdogTimer);
        generationWatchdogTimer = null;
    }
    void stopGenerationGuards('complete', source);
}

function stopGenerationWatchdog(finalState = '空闲') {
    if (generationWatchdogTimer !== null) {
        clearInterval(generationWatchdogTimer);
        generationWatchdogTimer = null;
    }
    diagnostics.generationWatchdogState = finalState;
    generationIdleSamples = 0;
    generationUiIdleSamples = 0;
    generationObservedOutput = false;
    generationStopButtonSeen = false;
}

function startGenerationWatchdog() {
    stopGenerationWatchdog(IS_REDMI_NOTE_10_PRO ? '红米正文完成检测中' : '事件监测中');
    const baseline = latestAssistantSnapshot();
    generationBaselineFingerprint = baseline.fingerprint;
    generationLastFingerprint = baseline.fingerprint;
    generationStartedAtMs = Date.now();
    generationLastOutputChangeAt = generationStartedAtMs;
    generationLastTokenAt = 0;
    diagnostics.watchdogOutputChanges = 0;
    diagnostics.watchdogStableMs = 0;
    diagnostics.watchdogCoreGenerating = true;
    diagnostics.watchdogStreamState = '等待流式状态';
    diagnostics.watchdogUiState = '等待生成按钮状态';
    diagnostics.lastCompletionSource = '';

    if (!IS_REDMI_NOTE_10_PRO) {
        return;
    }

    generationWatchdogTimer = setInterval(() => {
        if (!diagnostics.generationActive || generationStopInFlight) {
            return;
        }

        const now = Date.now();
        const current = latestAssistantSnapshot();
        if (current.fingerprint && current.fingerprint !== generationLastFingerprint) {
            generationLastFingerprint = current.fingerprint;
            generationLastOutputChangeAt = now;
            diagnostics.watchdogOutputChanges += 1;
        }
        if (current.fingerprint && current.fingerprint !== generationBaselineFingerprint) {
            generationObservedOutput = true;
        }

        let coreStillGenerating = true;
        try {
            coreStillGenerating = Boolean(isGenerating());
        } catch (error) {
            diagnostics.generationWatchdogState = `等待官方结束事件：${error instanceof Error ? error.message : String(error)}`;
        }
        diagnostics.watchdogCoreGenerating = coreStillGenerating;

        let streamPresent = false;
        let streamFinished = false;
        let streamHasPendingTools = false;
        try {
            streamPresent = Boolean(streamingProcessor);
            streamFinished = Boolean(streamingProcessor?.isFinished);
            streamHasPendingTools = Array.isArray(streamingProcessor?.toolCalls)
                && streamingProcessor.toolCalls.length > 0;
        } catch {
            // Older compatible hosts may not expose the processor at runtime.
        }
        diagnostics.watchdogStreamState = streamPresent
            ? (streamFinished
                ? (streamHasPendingTools ? '等待工具调用结束' : '流式正文已结束')
                : '流式正文进行中')
            : '没有活动流式处理器';

        const ui = generationUiSnapshot();
        generationStopButtonSeen ||= ui.stopVisible;
        diagnostics.watchdogUiState = ui.stopVisible
            ? '停止按钮可见'
            : (ui.sendVisible ? '发送按钮已恢复' : '按钮状态不可用');

        const lastActivityAt = Math.max(generationLastOutputChangeAt, generationLastTokenAt || 0);
        const stableMs = Math.max(0, now - lastActivityAt);
        diagnostics.watchdogStableMs = stableMs;

        if (!coreStillGenerating && generationObservedOutput) {
            generationIdleSamples += 1;
        } else {
            generationIdleSamples = 0;
        }

        if (streamFinished && !streamHasPendingTools && generationObservedOutput) {
            finishFromWatchdog('流式处理器完成兜底');
            return;
        }

        if (generationIdleSamples >= 2) {
            finishFromWatchdog('酒馆空闲状态兜底');
            return;
        }

        if (generationStopButtonSeen && !ui.stopVisible && ui.sendVisible && generationObservedOutput) {
            generationUiIdleSamples += 1;
            if (generationUiIdleSamples >= 2) {
                finishFromWatchdog('生成按钮恢复兜底');
                return;
            }
        } else {
            generationUiIdleSamples = 0;
        }

        // Last resort for the Redmi WebView failure seen in the field: the
        // response body is fully present but the stream never publishes its
        // terminal event. A long quiet tail is treated as complete. If a late
        // token arrives, the STREAM_TOKEN_RECEIVED handler re-opens generation.
        const generationElapsedMs = now - generationStartedAtMs;
        if (generationObservedOutput && generationElapsedMs >= 15_000 && stableMs >= 12_000) {
            finishFromWatchdog('正文静止超时兜底');
            return;
        }
        diagnostics.generationWatchdogState = `红米正文检测中（静止 ${Math.round(stableMs / 1000)} 秒）`;
    }, 1000);
}

async function onGenerationStarted(_type, _params, isDryRun) {
    if (isDryRun) {
        return;
    }

    diagnostics.generationActive = true;
    diagnostics.generationStartedAt = new Date().toISOString();
    diagnostics.generationEndedAt = null;
    generationStopInFlight = false;
    startGenerationWatchdog();
    renderStatus();

    if (settings().autoWake) {
        // Send the tiny state packet immediately. Avatar loading/decoding must
        // never delay or suppress the yellow "generating" reaction.
        void postCriticalCompanionEvent('generating').catch(error => {
            console.warn('[Four Tavern Companion] Generation-start state failed:', error);
        });
        // Character identity is a second independent packet. If the avatar
        // endpoint fails, syncCurrentCharacter still retries with the name only.
        // The cached key makes this a no-op when the character did not change.
        void syncCurrentCharacter({ quiet: true });
    }
    await Promise.allSettled([startRtcGuard(), startAudioFallback()]);
}

async function stopGenerationGuards(companionEvent, completionSource = '官方生成事件') {
    if (!diagnostics.generationActive || generationStopInFlight) {
        return;
    }
    generationStopInFlight = true;
    diagnostics.generationActive = false;
    diagnostics.generationEndedAt = new Date().toISOString();
    diagnostics.lastCompletionSource = completionSource;
    stopGenerationWatchdog(completionSource);
    renderStatus();

    if (settings().autoWake) {
        // Start the tiny HTTP packet before any asynchronous cleanup. MIUI may
        // freeze the WebView immediately after the final text is committed.
        void postCriticalCompanionEvent(companionEvent)
            .then(() => {
                if (document.visibilityState !== 'visible') {
                    return;
                }
                setTimeout(() => {
                    if (!diagnostics.generationActive && document.visibilityState === 'visible') {
                        void postToCompanion({ event: 'viewed' }).catch(() => {});
                    }
                }, 1800);
            })
            .catch(error => {
                console.warn('[Four Tavern Companion] Generation event failed:', error);
            });
    }

    closeRtcGuard();
    await stopAudioFallback();
    renderStatus();
    generationStopInFlight = false;
}

async function onGenerationEnded() {
    await stopGenerationGuards('complete', '官方结束事件');
}

async function onGenerationStopped() {
    await stopGenerationGuards('stopped', '官方停止事件');
}

function onStreamTokenReceived() {
    const now = Date.now();
    if (!diagnostics.generationActive) {
        const shouldResume = diagnostics.lastCompletionSource === '正文静止超时兜底'
            && now - generationHeuristicCompletedAt < 120_000;
        if (!shouldResume) {
            return;
        }

        // A very long provider pause can look exactly like a broken terminal
        // event. If text resumes after the quiet-tail fallback, restore the
        // yellow generating state automatically instead of staying green.
        diagnostics.generationActive = true;
        diagnostics.generationEndedAt = null;
        generationStopInFlight = false;
        startGenerationWatchdog();
        generationObservedOutput = true;
        generationLastTokenAt = now;
        diagnostics.generationWatchdogState = '检测到后续正文，已恢复生成状态';
        renderStatus();
        if (settings().autoWake) {
            void postCriticalCompanionEvent('generating').catch(() => {});
        }
        return;
    }

    generationLastTokenAt = now;
    generationObservedOutput = true;
}

function bindCheckbox(id, key) {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement)) {
        return;
    }

    input.checked = Boolean(settings()[key]);
    input.addEventListener('change', () => {
        settings()[key] = input.checked;
        saveSettingsDebounced();

        if (key === 'rtcEnabled') {
            if (input.checked && diagnostics.generationActive) {
                void startRtcGuard();
            } else if (!input.checked) {
                closeRtcGuard();
            }
        }

        if (key === 'audioFallback') {
            if (input.checked && diagnostics.generationActive) {
                void startAudioFallback();
            } else if (!input.checked) {
                void stopAudioFallback();
            }
        }

        if (key === 'autoCharacterSync' && input.checked) {
            scheduleAutomaticCharacterSync(50);
        }
    });
}

function bindHostMode() {
    const select = document.getElementById('ttka_host_mode');
    if (!(select instanceof HTMLSelectElement)) {
        return;
    }
    select.value = String(settings().hostMode || 'auto');
    select.addEventListener('change', () => {
        settings().hostMode = select.value;
        lastSyncedCharacterKey = '';
        saveSettingsDebounced();
        renderStatus();
        scheduleAutomaticCharacterSync(50);
    });
}

async function installSettingsPanel() {
    const target = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!target || document.getElementById('tt_keepalive_settings')) {
        return;
    }

    const html = await renderExtensionTemplateAsync(RESOURCE_NAME, 'settings');
    target.insertAdjacentHTML('beforeend', html);
    bindCheckbox('ttka_rtc_enabled', 'rtcEnabled');
    bindCheckbox('ttka_stream_assist', 'streamAssist');
    bindCheckbox('ttka_audio_fallback', 'audioFallback');
    bindCheckbox('ttka_auto_wake', 'autoWake');
    bindCheckbox('ttka_auto_character_sync', 'autoCharacterSync');
    bindHostMode();
    document.getElementById('ttka_install_companion')?.addEventListener('click', () => void openCompanionInstaller());
    document.getElementById('ttka_enable_tauri_permission')?.addEventListener('click', () => void enableTauriSyncPermission());
    document.getElementById('ttka_test_companion')?.addEventListener('click', () => void testCompanionConnection());
    document.getElementById('ttka_sync_companion')?.addEventListener('click', () => void manualSyncCurrentCharacter());
    document.getElementById('ttka_copy_report')?.addEventListener('click', () => void copyDiagnostics());
    renderStatus();
    if (detectTavernHost().id === 'tt') {
        void ensureTauriNotificationBridge().catch(() => {});
    }
}

function installHeartbeatDiagnostics() {
    if (heartbeatTimer !== null) {
        return;
    }

    diagnostics.lastHeartbeatAt = Date.now();
    heartbeatTimer = setInterval(() => {
        const now = Date.now();
        const gap = now - diagnostics.lastHeartbeatAt;
        diagnostics.lastHeartbeatAt = now;
        diagnostics.largestHeartbeatGapMs = Math.max(diagnostics.largestHeartbeatGapMs, gap);
        renderStatus();
    }, 3000);

    document.addEventListener('visibilitychange', () => {
        diagnostics.visibilityChanges += 1;
        const now = Date.now();
        diagnostics.largestHeartbeatGapMs = Math.max(
            diagnostics.largestHeartbeatGapMs,
            now - diagnostics.lastHeartbeatAt,
        );
        diagnostics.lastHeartbeatAt = now;
        renderStatus();
        if (document.visibilityState === 'visible'
            && !diagnostics.generationActive
            && settings().autoWake) {
            void postToCompanion({ event: 'viewed' }).catch(() => {});
        }
    });
}

installSurgicalStreamAssist();
installHeartbeatDiagnostics();
eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
if (event_types.STREAM_TOKEN_RECEIVED) {
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
}
if (event_types.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (diagnostics.generationActive) {
            void stopGenerationGuards('complete', '正文接收事件');
        }
    });
}
if (event_types.CHARACTER_MESSAGE_RENDERED) {
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        if (diagnostics.generationActive) {
            void stopGenerationGuards('complete', '正文渲染事件');
        }
    });
}
eventSource.on(event_types.CHAT_CHANGED, () => scheduleAutomaticCharacterSync());
eventSource.on(event_types.CHAT_LOADED, () => scheduleAutomaticCharacterSync());
eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => scheduleAutomaticCharacterSync());
eventSource.on(event_types.CHARACTER_EDITED, () => scheduleAutomaticCharacterSync());

jQuery(async () => {
    settings();
    try {
        await (globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__ ?? Promise.resolve());
    } catch {
        // Non-TT hosts do not expose the Tauri readiness promise.
    }
    await installSettingsPanel();
    scheduleAutomaticCharacterSync(800);
});
