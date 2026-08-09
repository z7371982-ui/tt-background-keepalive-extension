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
const DEFAULTS = Object.freeze({
    rtcEnabled: true,
    streamAssist: true,
    audioFallback: false,
    autoWake: true,
    autoCharacterSync: true,
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

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULTS);
    }

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (typeof extension_settings[MODULE_NAME][key] !== typeof value) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }

    return extension_settings[MODULE_NAME];
}

function notify(level, message, title = 'TT 后台保活') {
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
        console.warn('[TT Keepalive] WebRTC guard failed:', error);
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
        console.warn('[TT Keepalive] Audio fallback failed:', error);
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

async function postToCompanion({ name = '', avatar = '' } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
        const response = await fetch(`${COMPANION_BRIDGE_URL}?t=${Date.now()}`, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
            },
            body: JSON.stringify({
                name: String(name).slice(0, 80),
                avatar,
                wake: 600,
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Companion bridge returned ${response.status}`);
        }
        diagnostics.companionBridgeState = '已连接';
        diagnostics.companionBridgeError = '';
        renderStatus();
        return true;
    } catch (error) {
        diagnostics.companionBridgeState = '未连接';
        diagnostics.companionBridgeError = error instanceof Error ? error.message : String(error);
        renderStatus();
        throw error;
    } finally {
        clearTimeout(timeout);
    }
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

    const response = await fetch(getThumbnailUrl('avatar', avatarFile));
    if (!response.ok) {
        throw new Error(`Avatar request failed (${response.status})`);
    }

    const image = await imageFromBlob(await response.blob());
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = Math.max(0, (image.naturalWidth - side) / 2);
    const sourceY = Math.max(0, (image.naturalHeight - side) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = 112;
    canvas.height = 112;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#f8efe9';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, sourceX, sourceY, side, side, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.76).split(',')[1] || '';
}

async function syncCurrentCharacter({ quiet = false, force = false } = {}) {
    const character = this_chid === undefined ? null : characters[this_chid];
    if (!character) {
        if (!quiet) {
            notify('warning', '请先打开一个单人角色聊天。');
        }
        return false;
    }

    const syncKey = `${String(this_chid)}|${String(character.name || '')}|${String(character.avatar || '')}`;
    if (!force && syncKey === lastSyncedCharacterKey) {
        return true;
    }
    if (characterSyncInFlight) {
        return false;
    }

    characterSyncInFlight = true;
    try {
        const avatar = await makeAvatarThumbnail(character.avatar);
        await postToCompanion({ name: character.name, avatar });
        lastSyncedCharacterKey = syncKey;
        diagnostics.lastCharacterSyncKey = syncKey;
        diagnostics.lastCharacterSyncAt = new Date().toISOString();
        if (!quiet) {
            notify('success', '已把当前角色的压缩头像交给小伴侣。');
        }
        return true;
    } catch (error) {
        console.warn('[TT Keepalive] Character sync failed:', error);
        try {
            await postToCompanion({ name: character.name });
        } catch {
            // The companion may simply not be running. Never navigate TT away as a fallback.
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
        extensionVersion: '0.3.0',
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
        console.info('[TT Keepalive diagnostic]', diagnosticReport());
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
    await Promise.allSettled([startRtcGuard(), startAudioFallback()]);

    if (settings().autoWake) {
        void syncCurrentCharacter({ quiet: true, force: true });
    }
}

async function onGenerationFinished() {
    diagnostics.generationActive = false;
    diagnostics.generationEndedAt = new Date().toISOString();
    closeRtcGuard();
    await stopAudioFallback();
    renderStatus();
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
    });
}

installSurgicalStreamAssist();
installHeartbeatDiagnostics();
eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);
eventSource.on(event_types.CHAT_CHANGED, () => scheduleAutomaticCharacterSync());
eventSource.on(event_types.CHAT_LOADED, () => scheduleAutomaticCharacterSync());
eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => scheduleAutomaticCharacterSync());
eventSource.on(event_types.CHARACTER_EDITED, () => scheduleAutomaticCharacterSync());

jQuery(async () => {
    settings();
    try {
        await (globalThis.__TAURITAVERN__?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__ ?? Promise.resolve());
    } catch {
        // The extension also works on ordinary SillyTavern; only companion deep-links are TT-specific.
    }
    await installSettingsPanel();
    scheduleAutomaticCharacterSync(800);
});
