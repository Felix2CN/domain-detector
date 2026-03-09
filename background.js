/**
 * 域名探测器 - Background Service Worker
 * 职责：监听网络请求、记录域名与 IP、判断归属地
 */

// 导入中国 IP 数据
importScripts('china_ip.js');

// ============================================================
// 数据存储（内存 + chrome.storage.session 持久化）
// ============================================================

// 结构: { [tabId]: { url, domains: { [rootDomain]: { subdomains, ips, isChina } } } }
const tabData = {};

// 手动分析的数据：{ [taskId]: { url, domains: {...}, status } }
const manualTasks = {};

// ============================================================
// 工具函数
// ============================================================

/**
 * 已知多段 TLD 后缀列表
 */
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

/**
 * 提取根域名（一级域名 + TLD）
 * 例: fonts.googleapis.com → googleapis.com
 *     www.google.co.uk → google.co.uk
 */
function getRootDomain(hostname) {
    if (!hostname) return '';
    // 如果是 IP 地址，直接返回
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;

    const parts = hostname.toLowerCase().split('.');
    if (parts.length <= 2) return hostname.toLowerCase();

    // 检查是否匹配多段 TLD
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo)) {
        // 取最后三段
        return parts.slice(-3).join('.');
    }

    // 默认取最后两段
    return parts.slice(-2).join('.');
}

/**
 * 从 URL 中提取 hostname
 */
function getHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

// ============================================================
// DNS 解析（代理环境下获取真实 IP）
// ============================================================

const dnsCache = {}; // { hostname: { ip, timestamp } }
const DNS_CACHE_TTL = 300000; // 5 分钟

/**
 * 检测是否为代理/本地 IP
 */
function isProxyIP(ip) {
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1') return true;
    if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
    if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1]);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

/**
 * 通过 DNS-over-HTTPS 解析真实 IP
 * 优先 AliDNS，备选 Cloudflare
 */
async function resolveRealIP(hostname) {
    // 检查缓存
    const cached = dnsCache[hostname];
    if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
        return cached.ip;
    }

    const dohServers = [
        'https://dns.alidns.com/dns-query',
        'https://cloudflare-dns.com/dns-query'
    ];

    for (const server of dohServers) {
        try {
            const resp = await fetch(
                `${server}?name=${encodeURIComponent(hostname)}&type=A`,
                { headers: { 'Accept': 'application/dns-json' } }
            );
            const data = await resp.json();
            if (data.Answer) {
                const aRecord = data.Answer.find(a => a.type === 1);
                if (aRecord) {
                    dnsCache[hostname] = { ip: aRecord.data, timestamp: Date.now() };
                    return aRecord.data;
                }
            }
        } catch (e) {
            continue;
        }
    }
    return null;
}

// ============================================================
// 网络请求监听
// ============================================================

chrome.webRequest.onResponseStarted.addListener(
    (details) => {
        if (details.tabId < 0) return;

        const hostname = getHostname(details.url);
        if (!hostname) return;

        const rootDomain = getRootDomain(hostname);

        // 初始化 tab 数据
        if (!tabData[details.tabId]) {
            tabData[details.tabId] = {
                url: '',
                domains: {},
                startTime: Date.now()
            };
        }

        const tab = tabData[details.tabId];

        // 初始化该根域的记录（默认为中国，确认非中国后再修改）
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
            // 代理环境：通过 DoH 解析真实 IP
            resolveRealIP(hostname).then(realIP => {
                if (realIP) {
                    record.ips.add(realIP);
                    if (!isChineseIP(realIP)) {
                        record.isChina = false;
                    }
                }
            });
        } else {
            // 直连环境：直接使用请求 IP
            record.ips.add(details.ip);
            if (!isChineseIP(details.ip)) {
                record.isChina = false;
            }
        }

        // 同步更新手动任务（如果这个 tab 属于某个任务）
        for (const taskId in manualTasks) {
            if (manualTasks[taskId].tabId === details.tabId) {
                manualTasks[taskId].domains = tab.domains;
            }
        }
    },
    { urls: ['<all_urls>'] }
);

// 监听标签页导航，记录主 URL
chrome.webNavigation?.onCommitted?.addListener((details) => {
    if (details.frameId !== 0) return; // 只关注主框架
    if (tabData[details.tabId]) {
        tabData[details.tabId].url = details.url;
    }
});

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener((tabId) => {
    // 不要清理正在手动分析的标签
    const isManualTask = Object.values(manualTasks).some(t => t.tabId === tabId);
    if (!isManualTask) {
        delete tabData[tabId];
    }
});

// 标签页更新时记录 URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url && tabData[tabId]) {
        tabData[tabId].url = changeInfo.url;
    }
});

// ============================================================
// 消息处理（与 Popup 通信）
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case 'getTabData': {
            const data = tabData[msg.tabId];
            if (!data) {
                sendResponse({ url: '', domains: {} });
                return;
            }
            // 序列化 Set 为数组
            const serialized = {};
            for (const [domain, info] of Object.entries(data.domains)) {
                serialized[domain] = {
                    subdomains: [...info.subdomains],
                    ips: [...info.ips],
                    isChina: info.isChina
                };
            }
            sendResponse({ url: data.url, domains: serialized });
            return;
        }

        case 'analyzeUrl': {
            const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            manualTasks[taskId] = {
                url: msg.url,
                tabId: null,
                domains: {},
                status: 'loading'
            };

            // 在后台打开标签页
            chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
                manualTasks[taskId].tabId = tab.id;

                // 确保 tabData 初始化
                if (!tabData[tab.id]) {
                    tabData[tab.id] = { url: msg.url, domains: {}, startTime: Date.now() };
                } else {
                    tabData[tab.id].url = msg.url;
                }

                // 等待页面加载完成 + 额外时间收集异步资源
                const waitTime = msg.waitTime || 8000;

                chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
                    if (tabId === tab.id && changeInfo.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);

                        // 额外等待异步资源加载
                        setTimeout(() => {
                            const data = tabData[tab.id];
                            const serialized = {};
                            if (data) {
                                for (const [domain, info] of Object.entries(data.domains)) {
                                    serialized[domain] = {
                                        subdomains: [...info.subdomains],
                                        ips: [...info.ips],
                                        isChina: info.isChina
                                    };
                                }
                            }
                            manualTasks[taskId].domains = serialized;
                            manualTasks[taskId].status = 'done';

                            // 关闭后台标签
                            chrome.tabs.remove(tab.id);
                            delete tabData[tab.id];
                        }, waitTime);
                    }
                });

                // 超时保护（30秒）
                setTimeout(() => {
                    if (manualTasks[taskId] && manualTasks[taskId].status === 'loading') {
                        const data = tabData[tab.id];
                        const serialized = {};
                        if (data) {
                            for (const [domain, info] of Object.entries(data.domains)) {
                                serialized[domain] = {
                                    subdomains: [...info.subdomains],
                                    ips: [...info.ips],
                                    isChina: info.isChina
                                };
                            }
                        }
                        manualTasks[taskId].domains = serialized;
                        manualTasks[taskId].status = 'timeout';
                        try { chrome.tabs.remove(tab.id); } catch (e) { }
                        delete tabData[tab.id];
                    }
                }, 30000);
            });

            sendResponse({ taskId });
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
                domains: task.domains
            });
            return;
        }

        case 'clearManualTasks': {
            for (const taskId in manualTasks) {
                if (manualTasks[taskId].tabId) {
                    try { chrome.tabs.remove(manualTasks[taskId].tabId); } catch (e) { }
                }
                delete manualTasks[taskId];
            }
            sendResponse({ ok: true });
            return;
        }

        case 'clearTabData': {
            delete tabData[msg.tabId];
            sendResponse({ ok: true });
            return;
        }

        case 'cancelTask': {
            const task = manualTasks[msg.taskId];
            if (task && task.status === 'loading') {
                const data = tabData[task.tabId];
                const serialized = {};
                if (data) {
                    for (const [domain, info] of Object.entries(data.domains)) {
                        serialized[domain] = {
                            subdomains: [...info.subdomains],
                            ips: [...info.ips],
                            isChina: info.isChina
                        };
                    }
                }
                task.domains = serialized;
                task.status = 'done';
                try { chrome.tabs.remove(task.tabId); } catch (e) { }
                delete tabData[task.tabId];
            }
            sendResponse({ ok: true });
            return;
        }
    }
});
