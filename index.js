import {
    characters,
    eventSource,
    event_types,
    getThumbnailUrl,
    saveSettingsDebounced,
    this_chid,
} from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

const MODULE_NAME = 'tt-background-keepalive';
const RESOURCE_NAME = 'third-party/tt-background-keepalive-extension';
const COMPANION_BRIDGE_URL = 'http://127.0.0.1:18742/sync';
const COMPANION_CONTENT_URL = 'content://com.cicimil.ttcompanion.bridge/sync';
const COMPANION_NOTIFICATION_TITLE = 'TT_COMPANION_SYNC_V1';
const COMPANION_NOTIFICATION_CHANNEL = 'tauritavern_ai_generation_keepalive';
const COMPANION_NOTIFICATION_ID = 2408;
const COMPANION_PACKET_CHARS = 11_000;
const EXTENSION_VERSION = '0.9.0';
const DEFAULTS = Object.freeze({
    rtcEnabled: true,
    streamAssist: true,
    audioFallback: false,
    autoWake: true,
    autoCharacterSync: true,
    hostMode: 'auto',
});

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
        tt: { id: 'tt', label: 'TT' },
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
        return { id: 'tt', label: 'TT' };
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
    setText('#ttka_generation_state', diagnostics.generationActive ? '正在生成' : '空闲');
    setText('#ttka_visibility_state', document.visibilityState === 'hidden' ? '后台/隐藏' : '可见');
    setText('#ttka_rtc_state', diagnostics.rtcState);
    setText('#ttka_companion_bridge_state', diagnostics.companionBridgeState);
    setText('#ttka_host_state', detectTavernHost().label);
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

    await invoke('plugin:notification|notify', {
        options: {
            id: notificationId,
            channelId: COMPANION_NOTIFICATION_CHANNEL,
            title: COMPANION_NOTIFICATION_TITLE,
            body: 'TT 小伴侣正在同步',
            inboxLines: chunks,
            group: 'tt_companion_bridge',
            autoCancel: true,
            visibility: -1,
        },
    });
}

async function syncThroughSilentNotification(payload) {
    const encodedPayload = JSON.stringify(payload);
    if (encodedPayload.length <= 13_700) {
        await sendSilentNotificationPacket(encodedPayload, COMPANION_NOTIFICATION_ID);
        return;
    }

    const transfer = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const total = Math.ceil(encodedPayload.length / COMPANION_PACKET_CHARS);
    if (total > 64) {
        throw new Error('Companion avatar is too large');
    }

    for (let index = 0; index < total; index += 1) {
        const packet = JSON.stringify({
            kind: 'multipart',
            transfer,
            index,
            total,
            chunk: encodedPayload.slice(
                index * COMPANION_PACKET_CHARS,
                (index + 1) * COMPANION_PACKET_CHARS,
            ),
        });
        await sendSilentNotificationPacket(packet, COMPANION_NOTIFICATION_ID + 2 + index);
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

    if (payload.source === 'tt'
        && await tryTransport('TT 静默通知', syncThroughSilentNotification)) {
        return true;
    }
    if (await tryTransport('四端本机通道', syncThroughLoopback)) {
        return true;
    }
    if (await tryTransport('Android 系统通道', syncThroughAndroidContentProvider)) {
        return true;
    }

    diagnostics.companionBridgeState = '未连接';
    diagnostics.companionBridgeError = errors.join('; ');
    renderStatus();
    throw new Error(diagnostics.companionBridgeError);
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
        const source = typeof handler === 'function' ? Function.prototype.toString.call(handler) : '';
        const isTtFrameFlush = typeof handler === 'function'
            && Number(delay) === 10
            && (handler.name === 'flushFrames' || source.includes('flushFrames'));

        if (settings().streamAssist
            && diagnostics.generationActive
            && document.visibilityState === 'hidden'
            && isTtFrameFlush) {
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

async function onGenerationStarted(_type, _params, isDryRun) {
    if (isDryRun) {
        return;
    }

    diagnostics.generationActive = true;
    diagnostics.generationStartedAt = new Date().toISOString();
    diagnostics.generationEndedAt = null;
    renderStatus();

    if (settings().autoWake) {
        void syncCurrentCharacter({ quiet: true, force: true, event: 'generating' });
    }
    await Promise.allSettled([startRtcGuard(), startAudioFallback()]);
}

async function stopGenerationGuards(companionEvent) {
    if (!diagnostics.generationActive) {
        return;
    }
    diagnostics.generationActive = false;
    diagnostics.generationEndedAt = new Date().toISOString();
    closeRtcGuard();
    await stopAudioFallback();
    renderStatus();
    if (settings().autoWake) {
        void postToCompanion({ event: companionEvent })
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
}

async function onGenerationEnded() {
    await stopGenerationGuards('complete');
}

async function onGenerationStopped() {
    await stopGenerationGuards('stopped');
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
    document.getElementById('ttka_sync_companion')?.addEventListener('click', () => void syncCurrentCharacter({ force: true }));
    document.getElementById('ttka_copy_report')?.addEventListener('click', () => void copyDiagnostics());
    renderStatus();
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
    }, 1000);

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
if (event_types.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (diagnostics.generationActive) {
            void onGenerationEnded();
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
