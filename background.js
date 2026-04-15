/**
 * Domain Detector - Background Service Worker
 */

importScripts('china_ip.js');

const tabData = {};
const manualTasks = {};

const STORAGE_KEY = 'backgroundState';
const runtimeTaskMeta = {};
const dnsCache = {};
const dnsPending = {};

const DNS_CACHE_TTL = 5 * 60 * 1000;
const TASK_TIMEOUT_MS = 30 * 1000;
const TASK_RESULT_RETENTION_MS = 60 * 1000;

let stateLoadedPromise = null;
let persistTimer = null;
let isGlobalDetectionEnabled = false;

const MULTI_PART_TLDS = new Set([
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
    'co.kr', 'or.kr', 'go.kr',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
    'com.br', 'net.br', 'org.br',
    'co.in', 'net.in', 'org.in', 'gov.in',
    'com.tw', 'org.tw', 'net.tw', 'gov.tw',
    'com.hk', 'org.hk', 'net.hk', 'gov.hk',
    'co.nz', 'org.nz', 'net.nz',
    'com.sg', 'org.sg', 'net.sg', 'gov.sg',
    'com.my', 'org.my', 'net.my', 'gov.my',
    'co.th', 'or.th', 'in.th', 'go.th',
    'com.ph', 'org.ph', 'net.ph', 'gov.ph',
    'co.id', 'or.id', 'web.id', 'go.id',
    'com.vn', 'org.vn', 'net.vn', 'gov.vn',
    'com.mx', 'org.mx', 'net.mx', 'gob.mx',
    'com.ar', 'org.ar', 'net.ar', 'gov.ar',
    'co.za', 'org.za', 'net.za', 'gov.za',
    'com.tr', 'org.tr', 'net.tr', 'gov.tr',
    'co.il', 'org.il', 'net.il', 'gov.il',
    'com.ru', 'org.ru', 'net.ru',
    'com.ua', 'org.ua', 'net.ua', 'gov.ua',
    'co.de'
]);

function getRootDomain(hostname) {
    if (!hostname) return '';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;

    const parts = hostname.toLowerCase().split('.');
    if (parts.length <= 2) return hostname.toLowerCase();

    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo)) {
        return parts.slice(-3).join('.');
    }

    return parts.slice(-2).join('.');
}

function getHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

function serializeDomains(domains) {
    const serialized = {};
    for (const [domain, info] of Object.entries(domains || {})) {
        serialized[domain] = {
            subdomains: Array.isArray(info.subdomains) ? [...info.subdomains] : [...(info.subdomains || [])],
            ips: Array.isArray(info.ips) ? [...info.ips] : [...(info.ips || [])],
            isChina: info.isChina !== false
        };
    }
    return serialized;
}

function hydrateDomains(domains) {
    const hydrated = {};
    for (const [domain, info] of Object.entries(domains || {})) {
        hydrated[domain] = {
            subdomains: new Set(info.subdomains || []),
            ips: new Set(info.ips || []),
            isChina: info.isChina !== false
        };
    }
    return hydrated;
}

function snapshotState() {
    const serializedTabs = {};
    for (const [tabId, data] of Object.entries(tabData)) {
        serializedTabs[tabId] = {
            url: data.url,
            startTime: data.startTime,
            domains: serializeDomains(data.domains)
        };
    }

    const serializedTasks = {};
    for (const [taskId, task] of Object.entries(manualTasks)) {
        serializedTasks[taskId] = {
            ...task,
            domains: task.domains || {}
        };
    }

    return {
        tabData: serializedTabs,
        manualTasks: serializedTasks
    };
}

function schedulePersistState() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        try {
            await chrome.storage.session.set({ [STORAGE_KEY]: snapshotState() });
        } catch (error) {
            console.warn('Persist state failed:', error);
        }
    }, 200);
}

async function ensureStateLoaded() {
    if (stateLoadedPromise) {
        await stateLoadedPromise;
        return;
    }

    stateLoadedPromise = (async () => {
        try {
            const local = await chrome.storage.local.get(['isGlobalDetectionEnabled']);
            isGlobalDetectionEnabled = !!local.isGlobalDetectionEnabled;

            const stored = await chrome.storage.session.get(STORAGE_KEY);
            const state = stored[STORAGE_KEY];
            if (!state) return;

            for (const [tabId, data] of Object.entries(state.tabData || {})) {
                tabData[tabId] = {
                    url: data.url || '',
                    startTime: data.startTime || Date.now(),
                    domains: hydrateDomains(data.domains)
                };
            }

            for (const [taskId, task] of Object.entries(state.manualTasks || {})) {
                manualTasks[taskId] = {
                    ...task,
                    status: task.status === 'loading' ? 'interrupted' : task.status
                };
            }

            pruneFinishedTasks();
            schedulePersistState();
        } catch (error) {
            console.warn('Load state failed:', error);
        }
    })();

    await stateLoadedPromise;
}

function ensureTabRecord(tabId, url = '') {
    const key = String(tabId);
    if (!tabData[key]) {
        tabData[key] = {
            url,
            domains: {},
            startTime: Date.now()
        };
    } else if (url) {
        tabData[key].url = url;
    }
    return tabData[key];
}

function isProxyIP(ip) {
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1') return true;
    if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
    if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

async function resolveRealIP(hostname) {
    const cached = dnsCache[hostname];
    if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
        return cached.ip;
    }

    if (dnsPending[hostname]) {
        return dnsPending[hostname];
    }

    const dohServers = [
        'https://dns.alidns.com/dns-query',
        'https://cloudflare-dns.com/dns-query'
    ];

    dnsPending[hostname] = (async () => {
        for (const server of dohServers) {
            try {
                const resp = await fetch(
                    `${server}?name=${encodeURIComponent(hostname)}&type=A`,
                    { headers: { Accept: 'application/dns-json' } }
                );
                const data = await resp.json();
                if (data.Answer) {
                    const aRecord = data.Answer.find((answer) => answer.type === 1);
                    if (aRecord) {
                        dnsCache[hostname] = { ip: aRecord.data, timestamp: Date.now() };
                        return aRecord.data;
                    }
                }
            } catch {
                continue;
            }
        }
        return null;
    })();

    try {
        return await dnsPending[hostname];
    } finally {
        delete dnsPending[hostname];
    }
}

function cleanupTaskRuntime(taskId) {
    const meta = runtimeTaskMeta[taskId];
    if (!meta) return;

    if (meta.listener) {
        chrome.tabs.onUpdated.removeListener(meta.listener);
    }
    if (meta.completeTimer) clearTimeout(meta.completeTimer);
    if (meta.timeoutTimer) clearTimeout(meta.timeoutTimer);
    if (meta.cleanupTimer) clearTimeout(meta.cleanupTimer);

    delete runtimeTaskMeta[taskId];
}

function scheduleTaskDeletion(taskId) {
    const meta = runtimeTaskMeta[taskId] || {};
    if (meta.cleanupTimer) clearTimeout(meta.cleanupTimer);
    meta.cleanupTimer = setTimeout(() => {
        cleanupTaskRuntime(taskId);
        delete manualTasks[taskId];
        schedulePersistState();
    }, TASK_RESULT_RETENTION_MS);
    runtimeTaskMeta[taskId] = meta;
}

function finalizeTask(taskId, status, tabIdOverride = null) {
    const task = manualTasks[taskId];
    if (!task || task.status !== 'loading') return;

    const tabId = tabIdOverride ?? task.tabId;
    const data = tabId != null ? tabData[String(tabId)] : null;
    task.domains = data ? serializeDomains(data.domains) : (task.domains || {});
    task.status = status;

    cleanupTaskRuntime(taskId);

    if (tabId != null) {
        try {
            chrome.tabs.remove(tabId);
        } catch {
            // Ignore tab removal failures.
        }
        delete tabData[String(tabId)];
    }

    scheduleTaskDeletion(taskId);
    schedulePersistState();
}

function pruneFinishedTasks() {
    for (const [taskId, task] of Object.entries(manualTasks)) {
        if (task.status !== 'loading') {
            scheduleTaskDeletion(taskId);
        }
    }
}

chrome.webRequest.onResponseStarted.addListener(
    async (details) => {
        await ensureStateLoaded();

        if (details.tabId < 0) return;

        if (!isGlobalDetectionEnabled) {
            let isManual = false;
            for (const task of Object.values(manualTasks)) {
                if (task.tabId === details.tabId) {
                    isManual = true;
                    break;
                }
            }
            if (!isManual) return;
        }

        const hostname = getHostname(details.url);
        if (!hostname) return;

        const rootDomain = getRootDomain(hostname);
        const tab = ensureTabRecord(details.tabId);

        if (!tab.domains[rootDomain]) {
            tab.domains[rootDomain] = {
                subdomains: new Set(),
                ips: new Set(),
                isChina: true
            };
        }

        const record = tab.domains[rootDomain];
        record.subdomains.add(hostname);

        if (!details.ip || isProxyIP(details.ip)) {
            resolveRealIP(hostname).then((realIP) => {
                if (!realIP) return;

                record.ips.add(realIP);
                if (!isChineseIP(realIP)) {
                    record.isChina = false;
                }

                for (const task of Object.values(manualTasks)) {
                    if (task.tabId === details.tabId) {
                        task.domains = serializeDomains(tab.domains);
                    }
                }
                schedulePersistState();
            });
        } else {
            record.ips.add(details.ip);
            if (!isChineseIP(details.ip)) {
                record.isChina = false;
            }
        }

        for (const task of Object.values(manualTasks)) {
            if (task.tabId === details.tabId) {
                task.domains = serializeDomains(tab.domains);
            }
        }

        schedulePersistState();
    },
    { urls: ['<all_urls>'] }
);

chrome.webNavigation?.onCommitted?.addListener(async (details) => {
    await ensureStateLoaded();
    if (details.frameId !== 0) return;

    const tab = tabData[String(details.tabId)];
    if (!tab) return;

    tab.url = details.url;
    schedulePersistState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    await ensureStateLoaded();
    if (!changeInfo.url || !tabData[String(tabId)]) return;

    tabData[String(tabId)].url = changeInfo.url;
    schedulePersistState();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await ensureStateLoaded();

    for (const [taskId, task] of Object.entries(manualTasks)) {
        if (task.tabId === tabId && task.status === 'loading') {
            finalizeTask(taskId, 'interrupted', tabId);
        }
    }

    delete tabData[String(tabId)];
    schedulePersistState();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        await ensureStateLoaded();

        switch (msg.type) {
            case 'getDetectionState': {
                sendResponse({ enabled: isGlobalDetectionEnabled });
                return;
            }

            case 'setDetectionState': {
                isGlobalDetectionEnabled = msg.enabled;
                await chrome.storage.local.set({ isGlobalDetectionEnabled });
                sendResponse({ ok: true });
                return;
            }

            case 'getTabData': {
                const data = tabData[String(msg.tabId)];
                if (!data) {
                    sendResponse({ url: '', domains: {} });
                    return;
                }

                sendResponse({
                    url: data.url,
                    domains: serializeDomains(data.domains)
                });
                return;
            }

            case 'analyzeUrl': {
                pruneFinishedTasks();

                const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                manualTasks[taskId] = {
                    url: msg.url,
                    tabId: null,
                    domains: {},
                    status: 'loading'
                };
                schedulePersistState();

                chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
                    if (chrome.runtime.lastError || !tab?.id || !manualTasks[taskId]) {
                        finalizeTask(taskId, 'interrupted');
                        sendResponse({ taskId });
                        return;
                    }

                    manualTasks[taskId].tabId = tab.id;
                    ensureTabRecord(tab.id, msg.url);

                    const waitTime = Number(msg.waitTime) || 8000;
                    const listener = (updatedTabId, changeInfo) => {
                        if (updatedTabId !== tab.id || changeInfo.status !== 'complete') return;

                        chrome.tabs.onUpdated.removeListener(listener);
                        if (!runtimeTaskMeta[taskId]) return;

                        runtimeTaskMeta[taskId].listener = null;
                        runtimeTaskMeta[taskId].completeTimer = setTimeout(() => {
                            finalizeTask(taskId, 'done', tab.id);
                        }, waitTime);
                    };

                    runtimeTaskMeta[taskId] = {
                        listener,
                        completeTimer: null,
                        timeoutTimer: setTimeout(() => {
                            finalizeTask(taskId, 'timeout', tab.id);
                        }, TASK_TIMEOUT_MS),
                        cleanupTimer: null
                    };

                    chrome.tabs.onUpdated.addListener(listener);
                    schedulePersistState();
                    sendResponse({ taskId });
                });
                return;
            }

            case 'getTaskStatus': {
                const task = manualTasks[msg.taskId];
                if (!task) {
                    sendResponse({ status: 'not_found' });
                    return;
                }

                sendResponse({
                    url: task.url,
                    status: task.status,
                    domains: task.domains || {}
                });
                return;
            }

            case 'clearManualTasks': {
                for (const [taskId, task] of Object.entries(manualTasks)) {
                    if (task.tabId != null) {
                        try {
                            chrome.tabs.remove(task.tabId);
                        } catch {
                            // Ignore tab removal failures.
                        }
                    }
                    cleanupTaskRuntime(taskId);
                    delete manualTasks[taskId];
                }

                schedulePersistState();
                sendResponse({ ok: true });
                return;
            }

            case 'clearTabData': {
                delete tabData[String(msg.tabId)];
                schedulePersistState();
                sendResponse({ ok: true });
                return;
            }

            case 'cancelTask': {
                if (manualTasks[msg.taskId]) {
                    finalizeTask(msg.taskId, 'cancelled');
                }
                sendResponse({ ok: true });
                return;
            }

            default:
                sendResponse({ error: 'unknown_message_type' });
        }
    })().catch((error) => {
        console.error('Message handling failed:', error);
        sendResponse({ error: error.message });
    });

    return true;
});

ensureStateLoaded();
