// ==UserScript==
// @name         크랙 맥락 복사
// @namespace    https://crack.wrtn.ai/
// @version      1.0.0
// @description  현재 채팅방의 최근 턴, 대화프로필, 유저노트를 복사합니다.
// @match        https://crack.wrtn.ai/*
// @run-at       document-idle
// @noframes
// @grant        GM.setClipboard
// @grant        unsafeWindow
// @updateURL    https://github.com/hamster4762/crack-context-copy/raw/refs/heads/main/crack-context-copy.user.js
// @downloadURL  https://github.com/hamster4762/crack-context-copy/raw/refs/heads/main/crack-context-copy.user.js
// ==/UserScript==

// localStorage(crack-context-copy:settings)에는 최근 턴 수와 대화프로필, 유저노트, RP 기록의 포함 여부만 저장.
// 버튼 위치는 현재 페이지에서만 유지.
// 대화로그, 대화프로필, 유저노트 원문과 로그인 토큰은 이 스크립트가 저장하지 않습니다.

(() => {
    'use strict';

    const api = 'https://crack-api.wrtn.ai';
    const settingsKey = 'crack-context-copy:settings';
    const defaults = { turns: 10, profile: true, note: true, rpHistory: true };
    const holdDuration = 500;

    function currentRoomId() {
        return location.pathname.match(/^\/stories\/[^/]+\/episodes\/([\w-]+)\/?$/)?.[1] ?? '';
    }

    async function getData(path, label) {
        const token = document.cookie.match(/(?:^|;\s*)access_token=([^;]+)/)?.[1];
        if (!token) throw new Error('크랙에 로그인한 뒤 다시 시도해 주세요.');

        let response;
        try {
            response = await fetch(api + path, {
                credentials: 'include',
                cache: 'no-store',
                signal: AbortSignal.timeout(15000),
                headers: {
                    Authorization: `Bearer ${decodeURIComponent(token)}`,
                    Platform: 'web',
                    'wrtn-locale': 'ko-KR',
                },
            });
        } catch (error) {
            const reason = error.name === 'TimeoutError' ? '응답 시간 초과' : '연결 실패';
            throw new Error(`${label} 조회에 실패했어요. (${reason})`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error(`${label}에 접근할 수 없어요. 크랙 로그인 상태를 확인해 주세요.`);
        }
        if (!response.ok) throw new Error(`${label} 조회에 실패했어요. (HTTP ${response.status})`);

        const result = await response.json().catch(() => null);
        if (result?.data == null) throw new Error(`${label} 응답 형식을 확인할 수 없어요.`);
        return result.data;
    }

    function selectedReplyId(roomId) {
        // 아직 이어서 진행하지 않은 리롤 선택은 서버에 저장되기 전까지 앱 상태에만 있다.
        const root = unsafeWindow.document.getElementById('__next');
        const rootKey = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
        const fiberRoot = rootKey && root[rootKey]?.stateNode?.current;
        if (!fiberRoot) return undefined;

        const pending = [fiberRoot];
        while (pending.length) {
            const fiber = pending.pop();
            const value = fiber.memoizedProps?.value;
            if (value?.chatId === roomId && Object.hasOwn(value, 'rerollingMessageId') &&
                Object.hasOwn(value, 'selectedMessageId')) {
                return value.selectedMessageId ?? null;
            }
            if (fiber.sibling) pending.push(fiber.sibling);
            if (fiber.child) pending.push(fiber.child);
        }
        return undefined;
    }

    async function readRecentTurns(roomId, roomPath, count) {
        const turns = [];
        const seenMessages = new Set();
        let selectedId;
        let reply = null;
        let cursor = '';

        do {
            // API는 메시지 수를 받으므로 턴당 최대 두 건을 요청한다.
            const remainingMessages = (count - turns.length) * 2 - Number(reply !== null);
            const query = new URLSearchParams({ limit: Math.min(200, remainingMessages) });
            if (cursor) {
                await new Promise(resolve => setTimeout(resolve, 500));
                query.set('cursor', cursor);
            }
            const page = await getData(`${roomPath}/messages?${query}`, '채팅');
            if (!Array.isArray(page.messages)) throw new Error('채팅 메시지 형식을 확인할 수 없어요.');

            for (const message of page.messages) {
                if (seenMessages.has(message._id)) continue;
                seenMessages.add(message._id);
                const { role, status, turnId, parentTurnId } = message;
                if (role === 'assistant') {
                    if (['start', 'progress', 'error'].includes(status)) continue;
                    const isReroll = reply && (
                        (turnId && turnId === reply.turnId) ||
                        (parentTurnId && parentTurnId === reply.parentTurnId)
                    );
                    if (isReroll) {
                        if (selectedId === undefined) selectedId = selectedReplyId(roomId);
                        if (selectedId === undefined) {
                            throw new Error('선택한 리롤 응답을 확인할 수 없어요. 채팅방을 새로고침한 뒤 다시 시도해 주세요.');
                        }
                        // 기본 응답은 크랙이 처음 표시하는 API 목록의 첫 응답이다.
                        if (message._id === selectedId) reply = message;
                        continue;
                    }
                    if (reply) turns.push([reply]);
                    reply = message;
                } else if (role === 'user') {
                    const isPair = reply && turnId && (reply.parentTurnId === turnId || reply.turnId === turnId);
                    if (reply) turns.push(isPair ? [message, reply] : [reply]);
                    if (!isPair && turns.length < count) turns.push([message]);
                    reply = null;
                }
                if (turns.length >= count) return turns.reverse();
            }

            const nextCursor = page.hasNext ? page.nextCursor : '';
            if (nextCursor && nextCursor === cursor) throw new Error('크랙이 같은 채팅 페이지를 반환했어요.');
            cursor = nextCursor;
        } while (cursor);

        if (reply) turns.push([reply]);
        return turns.reverse();
    }

    async function readProfile(appliedId) {
        const account = await getData('/crack-api/profiles', '계정 프로필');
        if (!account._id) throw new Error('계정 프로필 ID를 찾을 수 없어요.');
        const { chatProfiles } = await getData(`/crack-api/profiles/${encodeURIComponent(account._id)}/chat-profiles`, '대화프로필');
        if (!Array.isArray(chatProfiles)) throw new Error('대화프로필 목록을 확인할 수 없어요.');
        const profile = appliedId
            ? chatProfiles.find(item => item._id === appliedId)
            : chatProfiles.find(item => item.isRepresentative);
        if (appliedId && !profile) throw new Error('현재 방에 적용된 대화프로필을 찾을 수 없어요.');
        return [profile?.name, profile?.information].filter(Boolean).join('\n');
    }

    function removeImages(text) {
        return text
            .replace(/!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '')
            .replace(/<img\b[^>]*>/gi, '')
            .replace(/https?:\/\/[^\s<>"'`()\[\]]+/gi, url => {
                const address = url.replace(/[.,!?;:]+$/, '');
                return /^[^?#]*\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:[?#]|$)/i.test(address)
                    ? url.slice(address.length)
                    : url;
            })
            .trim();
    }

    async function buildContext(roomId, settings) {
        const roomPath = `/crack-gen/v3/chats/${encodeURIComponent(roomId)}`;
        const metadata = settings.profile || settings.note
            ? getData(roomPath, '채팅방').then(async room => ({
                profile: settings.profile ? await readProfile(room.chatProfile?._id) : '',
                note: settings.note ? room.story?.userNote?.content ?? '' : '',
            }))
            : {};
        const [turns, { profile, note }] = await Promise.all([
            readRecentTurns(roomId, roomPath, settings.turns),
            metadata,
        ]);
        const sections = [];
        if (settings.profile) sections.push(['대화프로필', removeImages(profile) || '설정 없음']);
        if (settings.note) sections.push(['유저노트', removeImages(note) || '설정 없음']);

        const comments = [];
        const latest = turns.map((turn, index) => turn.map(message => {
            const content = (message.content ?? '').replace(/<!--[\s\S]*?-->/g, block => {
                if (settings.rpHistory) {
                    const comment = removeImages(block.slice(4, -3));
                    if (comment) comments.push(comment);
                }
                return '';
            });
            const speaker = message.role === 'user' ? 'USER' : 'AI';
            const body = removeImages(content) || '(텍스트 없음)';
            return `[${index + 1}턴 · ${speaker}]\n${body}`;
        }).join('\n\n')).join('\n\n');

        if (comments.length) sections.push(['과거기록', comments.join('\n\n')]);
        sections.push(['최신채팅', latest || '채팅 없음']);
        const text = sections.map(([title, body], index) => `# ${index + 1}. ${title}\n\n${body}`)
            .join('\n\n---\n\n')
            .replace(/(\r?\n)(?:[^\S\r\n]*\r?\n){2,}/g, '$1$1');
        return { text, count: turns.length };
    }

    let saved = defaults;
    try {
        saved = { ...defaults, ...JSON.parse(localStorage.getItem(settingsKey)) };
    } catch {
        // 저장된 설정을 읽을 수 없으면 기본값으로 시작한다.
    }

    const host = document.createElement('div');
    const ui = host.attachShadow({ mode: 'closed' });
    ui.innerHTML = `
        <style>
            :host { all: initial; color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif;
                --panel: light-dark(#fff, #222426); --text: light-dark(#222426, #f3f4f5);
                --muted: light-dark(#585d63, #c1c5ca); --line: light-dark(#d8dade, #50545a);
                --hover: light-dark(#eceef0, #35383c); }
            *, *::before, *::after { box-sizing: border-box; }
            [hidden] { display: none !important; }
            button, input, textarea { font: inherit; }
            button { cursor: pointer; }
            button:disabled { cursor: wait; opacity: .65; }
            :focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
            .float { position: fixed; z-index: 2147483640; --size: 36px;
                right: max(16px, env(safe-area-inset-right));
                bottom: max(92px, calc(76px + env(safe-area-inset-bottom))); }
            @media (pointer: coarse) { .float { --size: 40px; } }
            .float.moved { right: auto; bottom: auto;
                left: clamp(max(8px, env(safe-area-inset-left)), var(--drag-x),
                    calc(100vw - var(--size) - max(8px, env(safe-area-inset-right))));
                top: clamp(max(8px, env(safe-area-inset-top)), var(--drag-y),
                    calc(100dvh - var(--size) - max(8px, env(safe-area-inset-bottom)))); }
            .primary { border: 0; background: var(--text); color: var(--panel); font-weight: 650; }
            .primary:not(:disabled):hover { background: var(--muted); }
            .trigger { position: relative; display: grid; place-items: center; width: var(--size); height: var(--size);
                padding: 0; border: 1px solid var(--line); border-radius: 50%; color: var(--text);
                background: var(--panel); box-shadow: 0 2px 8px #0003; cursor: grab;
                user-select: none; touch-action: none; -webkit-touch-callout: none; }
            .trigger:not(:disabled):hover { background: var(--hover); }
            .trigger.dragging { cursor: grabbing; }
            .trigger svg { pointer-events: none; }
            .hold-ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg);
                visibility: hidden; }
            .trigger.holding .hold-ring { visibility: visible; }
            .hold-ring circle { stroke-dasharray: 1; stroke-dashoffset: 1; }
            .trigger.holding .hold-ring circle { animation: hold-fill ${holdDuration}ms linear forwards; }
            @keyframes hold-fill { to { stroke-dashoffset: 0; } }
            @media (prefers-reduced-motion: reduce) {
                .trigger.holding .hold-ring circle { animation: none; stroke-dashoffset: 0; }
            }
            .toast { position: fixed; z-index: 2147483640; top: max(12px, calc(env(safe-area-inset-top) + 8px));
                left: 50%; transform: translateX(-50%); width: max-content; pointer-events: none;
                max-width: min(280px, calc(100vw - 32px)); padding: 6px 11px; border: 1px solid var(--line);
                border-radius: 10px; color: var(--text); background: var(--panel); font-size: 13px;
                box-shadow: 0 3px 12px #0002; }
            .toast:empty { opacity: 0; }
            dialog { width: min(460px, calc(100% - 28px)); max-height: calc(100dvh - 28px); padding: 18px;
                border: 1px solid var(--line); border-radius: 15px; background: var(--panel); color: var(--text);
                box-shadow: 0 16px 54px #0004; }
            dialog::backdrop { background: #0008; }
            header, footer, .setting { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
            h2 { margin: 0; font-size: 17px; }
            .close { width: 36px; height: 36px; padding: 0; border: 0; border-radius: 8px;
                color: var(--muted); background: transparent; font-size: 22px; }
            .close:hover { background: var(--hover); }
            fieldset { margin: 10px 0 14px; padding: 0; min-width: 0; border: 0; }
            .setting { min-height: 42px; border-bottom: 1px solid var(--line); }
            input[type="number"] { width: 88px; padding: 4px 8px; border: 1px solid var(--line);
                border-radius: 7px; background: var(--panel); color: var(--text); }
            input[type="checkbox"] { width: 18px; height: 18px; margin-right: 4px;
                accent-color: light-dark(#35383c, #c1c5ca); }
            .preview-label { display: block; margin-bottom: 5px; font-weight: 650; }
            textarea { display: block; width: 100%; height: clamp(88px, 25dvh, 220px); resize: vertical;
                border: 1px solid var(--line); border-radius: 8px; padding: 9px; color: var(--text);
                background: light-dark(#f7f8f9, #191b1d); }
            footer { margin-top: 12px; }
            .status { min-width: 0; color: var(--muted); font-size: 12px; }
            .preview-button { flex: none; min-height: 40px; padding: 0 13px; border-radius: 8px; }
        </style>
        <div class="float" hidden>
            <button class="trigger" type="button" title="맥락 복사 · 길게 눌러 설정 · 드래그로 이동"
                aria-label="맥락 복사. 길게 누르거나 Shift+Enter로 설정" aria-keyshortcuts="Shift+Enter">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" aria-hidden="true">
                    <rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>
                </svg>
                <svg class="hold-ring" viewBox="0 0 36 36" fill="none" aria-hidden="true">
                    <circle cx="18" cy="18" r="16.5" pathLength="1" stroke="currentColor" stroke-width="2"/>
                </svg>
            </button>
        </div>
        <div class="toast" role="status"></div>
        <dialog aria-labelledby="title">
            <header>
                <h2 id="title">맥락 복사 설정</h2>
                <button class="close" type="button" aria-label="닫기" autofocus>×</button>
            </header>
            <fieldset>
                <label class="setting">최근 턴 수 <input id="turns" type="number" min="1" step="1" required></label>
                <label class="setting">대화프로필 포함 <input id="profile" type="checkbox" role="switch"></label>
                <label class="setting">유저노트 포함 <input id="note" type="checkbox" role="switch"></label>
                <label class="setting">RP 기록 포함 <input id="rp-history" type="checkbox" role="switch"></label>
            </fieldset>
            <label class="preview-label" for="preview">미리보기</label>
            <textarea id="preview" readonly placeholder="미리보기 버튼을 누르면 복사할 내용이 표시돼요."></textarea>
            <footer>
                <div class="status" role="status"></div>
                <button class="primary preview-button" type="button">미리보기</button>
            </footer>
        </dialog>`;
    document.body.append(host);

    const float = ui.querySelector('.float');
    const trigger = ui.querySelector('.trigger');
    const toast = ui.querySelector('.toast');
    const dialog = ui.querySelector('dialog');
    const fields = ui.querySelector('fieldset');
    const turnsInput = ui.querySelector('#turns');
    const profileInput = ui.querySelector('#profile');
    const noteInput = ui.querySelector('#note');
    const rpHistoryInput = ui.querySelector('#rp-history');
    const preview = ui.querySelector('#preview');
    const previewButton = ui.querySelector('.preview-button');
    const status = ui.querySelector('.status');
    turnsInput.value = saved.turns;
    profileInput.checked = saved.profile;
    noteInput.checked = saved.note;
    rpHistoryInput.checked = saved.rpHistory;

    let busy = false;
    let toastTimer;
    let holdTimer;
    let gesture = null;
    let room = '';

    function showToast(message, duration = 1500) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        if (message) toastTimer = setTimeout(() => { toast.textContent = ''; }, duration);
    }

    function endGesture() {
        clearTimeout(holdTimer);
        trigger.classList.remove('holding', 'dragging');
        gesture = null;
    }

    function syncRoom() {
        const nextRoom = currentRoomId();
        if (nextRoom === room) return;
        endGesture();
        room = nextRoom;
        float.hidden = !room;
        if (dialog.open) dialog.close();
        showToast('');
        preview.value = '';
    }

    function openSettings(focusTurns = true) {
        if (dialog.open || !room) return;
        status.textContent = '';
        preview.value = '';
        dialog.showModal();
        if (focusTurns) turnsInput.focus();
    }

    function saveSettings() {
        const turns = turnsInput.valueAsNumber;
        if (!turnsInput.validity.valid || !Number.isSafeInteger(turns)) return false;
        saved = { turns, profile: profileInput.checked, note: noteInput.checked, rpHistory: rpHistoryInput.checked };
        try {
            localStorage.setItem(settingsKey, JSON.stringify(saved));
        } catch {
            status.textContent = '이 탭에서만 설정을 유지해요.';
        }
        return true;
    }

    async function run(previewOnly) {
        if (!room || busy) return;
        if (previewOnly && !saveSettings()) {
            status.textContent = '최근 턴 수를 1 이상의 정수로 입력해 주세요.';
            turnsInput.focus();
            return;
        }

        const requestedRoom = room;
        busy = fields.disabled = trigger.disabled = previewButton.disabled = true;
        if (previewOnly) status.textContent = '크랙에서 불러오는 중…';
        else showToast('');
        try {
            const result = await buildContext(requestedRoom, saved);
            if (requestedRoom !== currentRoomId()) return;
            if (previewOnly) {
                preview.value = result.text;
                preview.scrollTop = 0;
                status.textContent = `${result.count}턴`;
            } else {
                try {
                    await GM.setClipboard(result.text, 'text');
                } catch {
                    throw new Error('클립보드 복사에 실패했어요. 설정의 미리보기에서 내용을 선택할 수 있어요.');
                }
                if (requestedRoom === currentRoomId()) showToast(`${result.count}턴 복사 완료`);
            }
        } catch (error) {
            if (requestedRoom === currentRoomId()) {
                if (previewOnly) status.textContent = error.message;
                else showToast(error.message, 3500);
            }
        } finally {
            busy = fields.disabled = trigger.disabled = previewButton.disabled = false;
        }
    }

    trigger.addEventListener('pointerdown', event => {
        if (busy || gesture || !event.isPrimary || event.button !== 0) return;
        const { left, top } = float.getBoundingClientRect();
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left, top, dragged: false };
        trigger.setPointerCapture(event.pointerId);
        trigger.classList.add('holding');
        holdTimer = setTimeout(() => {
            endGesture();
            openSettings(event.pointerType === 'mouse');
        }, holdDuration);
    });

    trigger.addEventListener('pointermove', event => {
        if (gesture?.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!gesture.dragged) {
            if (Math.hypot(dx, dy) < 7) return;
            gesture.dragged = true;
            clearTimeout(holdTimer);
            trigger.classList.replace('holding', 'dragging');
            float.classList.add('moved');
        }
        float.style.setProperty('--drag-x', `${gesture.left + dx}px`);
        float.style.setProperty('--drag-y', `${gesture.top + dy}px`);
    });

    trigger.addEventListener('pointerup', event => {
        if (gesture?.id !== event.pointerId) return;
        const { dragged } = gesture;
        endGesture();
        if (!dragged) void run(false);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
        trigger.addEventListener(type, event => {
            if (gesture?.id === event.pointerId) endGesture();
        });
    }
    trigger.addEventListener('contextmenu', event => event.preventDefault());
    trigger.addEventListener('click', event => {
        // 포인터 동작은 pointerup에서 끝내고 키보드 활성화만 click에서 처리한다.
        if (event.detail === 0) void run(false);
    });
    trigger.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !event.shiftKey) return;
        event.preventDefault();
        openSettings();
    });
    fields.addEventListener('input', () => {
        preview.value = '';
        status.textContent = '';
        saveSettings();
    });
    ui.querySelector('.close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
        turnsInput.value = saved.turns;
        profileInput.checked = saved.profile;
        noteInput.checked = saved.note;
        rpHistoryInput.checked = saved.rpHistory;
    });
    previewButton.addEventListener('click', () => void run(true));
    if (window.navigation) window.navigation.addEventListener('currententrychange', syncRoom);
    else unsafeWindow.next?.router?.events?.on('routeChangeComplete', syncRoom);
    window.addEventListener('popstate', syncRoom);
    syncRoom();
})();
