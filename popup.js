/**
 * Domain Detector - Popup Logic
 */

const MAX_CONCURRENT_ANALYSIS = 3;
const MAX_POLLS = 40;
const MAX_HISTORY = 50;

let currentFilter = 'all';
let allResults = {};
let activeTab = 'current';
let manualTaskIds = [];
let pendingQueue = [];
let runningTasks = 0;
const completedManualTasks = new Set();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const elCurrentUrl = $('#currentUrl');
const elCurrentResults = $('#currentResults');
const elManualResults = $('#manualResults');
const elMergedResults = $('#mergedResults');
const elUrlInput = $('#urlInput');
const elBtnAnalyze = $('#btnAnalyze');
const elDetectionToggle = $('#detectionToggle');
const elStatNonChina = $('#statNonChina');
const elStatChina = $('#statChina');
const elBtnCopyNonChina = $('#btnCopyNonChina');
const elBtnCopyAll = $('#btnCopyAll');
const elToast = $('#toast');
const elHistoryResults = $('#historyResults');
const elHistoryCount = $('#historyCount');
const elBtnClearHistory = $('#btnClearHistory');

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normalizeDomainInfo(info = {}) {
    return {
        isChina: info.isChina !== false,
        ips: Array.isArray(info.ips) ? info.ips : [...(info.ips || [])],
        subdomains: Array.isArray(info.subdomains) ? info.subdomains : [...(info.subdomains || [])]
    };
}

function buildMergedDomains() {
    const merged = {};

    for (const result of Object.values(allResults)) {
        let sourceHost = '';
        try {
            sourceHost = new URL(result.source).hostname;
        } catch {
            sourceHost = result.source || '';
        }

        for (const [rootDomain, rawInfo] of Object.entries(result.domains || {})) {
            const info = normalizeDomainInfo(rawInfo);
            if (!merged[rootDomain]) {
                merged[rootDomain] = {
                    isChina: info.isChina,
                    ips: new Set(info.ips),
                    subdomains: new Set(info.subdomains),
                    sources: new Set(sourceHost ? [sourceHost] : [])
                };
                continue;
            }

            if (!info.isChina) merged[rootDomain].isChina = false;
            info.ips.forEach((ip) => merged[rootDomain].ips.add(ip));
            info.subdomains.forEach((subdomain) => merged[rootDomain].subdomains.add(subdomain));
            if (sourceHost) merged[rootDomain].sources.add(sourceHost);
        }
    }

    return merged;
}

function updateStats() {
    const merged = buildMergedDomains();
    const values = Object.values(merged);
    elStatNonChina.textContent = values.filter((value) => !value.isChina).length;
    elStatChina.textContent = values.filter((value) => value.isChina).length;
}

function collectDomains(chinaFilter) {
    const merged = buildMergedDomains();
    return Object.entries(merged)
        .filter(([, value]) => chinaFilter === null || value.isChina === chinaFilter)
        .map(([domain]) => `*.${domain}`)
        .sort()
        .join('\n');
}

async function copyToClipboard(text) {
    if (!text) {
        showToast('No domains to copy');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }

    showToast(`Copied ${text.split('\n').length} domain(s)`);
}

function showToast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    setTimeout(() => elToast.classList.remove('show'), 2000);
}

function createDomainItem(rootDomain, rawInfo) {
    const info = normalizeDomainInfo(rawInfo);
    const item = document.createElement('div');
    item.className = 'domain-item';

    const tagClass = info.isChina ? 'tag-china' : 'tag-foreign';
    const tagText = info.isChina ? 'CN' : 'Non-CN';
    const ipDisplay = info.ips[0] || '';
    const ipTitle = info.ips.join(', ');
    const subTitle = info.subdomains.join(', ');

    item.innerHTML = `
      <span class="domain-name" title="${escapeHtml(subTitle || rootDomain)}">*.${escapeHtml(rootDomain)}</span>
      <span class="domain-tag ${tagClass}">${tagText}</span>
      <span class="domain-ip" title="${escapeHtml(ipTitle)}">${escapeHtml(ipDisplay)}</span>
      <button class="domain-copy" title="Copy">Copy</button>
    `;

    item.querySelector('.domain-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(`*.${rootDomain}`);
    });

    return item;
}

function renderSiteGroup(container, sourceUrl, domains) {
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    let hostname = '';
    try {
        hostname = new URL(sourceUrl).hostname;
    } catch {
        hostname = sourceUrl;
    }

    const domainEntries = Object.entries(domains || {});
    const nonChinaCount = domainEntries.filter(([, value]) => value.isChina === false).length;

    const group = document.createElement('div');
    group.className = 'site-group';

    const header = document.createElement('div');
    header.className = 'site-header';
    header.innerHTML = `
      <span class="site-name">${escapeHtml(hostname)}</span>
      <span class="site-badge">${domainEntries.length} domains / ${nonChinaCount} non-CN</span>
    `;

    const body = document.createElement('div');
    body.className = 'site-body';

    header.addEventListener('click', () => {
        body.classList.toggle('collapsed');
    });

    const sorted = domainEntries.sort((a, b) => {
        if (a[1].isChina === b[1].isChina) return a[0].localeCompare(b[0]);
        return a[1].isChina ? 1 : -1;
    });

    for (const [rootDomain, info] of sorted) {
        body.appendChild(createDomainItem(rootDomain, info));
    }

    group.appendChild(header);
    group.appendChild(body);
    container.appendChild(group);
    return group;
}

function renderMergedResults() {
    elMergedResults.innerHTML = '';

    const merged = buildMergedDomains();
    if (Object.keys(merged).length === 0) {
        elMergedResults.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">-</div>
            <p>No merged results yet</p>
          </div>
        `;
        return;
    }

    const filterBar = document.createElement('div');
    filterBar.className = 'filter-bar';

    const values = Object.values(merged);
    const filters = [
        { key: 'all', label: `All (${values.length})` },
        { key: 'foreign', label: `Non-CN (${values.filter((value) => !value.isChina).length})` },
        { key: 'china', label: `CN (${values.filter((value) => value.isChina).length})` }
    ];

    for (const filter of filters) {
        const btn = document.createElement('button');
        btn.className = `filter-btn ${filter.key === currentFilter ? 'active' : ''}`;
        btn.textContent = filter.label;
        btn.addEventListener('click', () => {
            currentFilter = filter.key;
            renderMergedResults();
        });
        filterBar.appendChild(btn);
    }
    elMergedResults.appendChild(filterBar);

    const entries = Object.entries(merged)
        .filter(([, value]) => {
            if (currentFilter === 'foreign') return !value.isChina;
            if (currentFilter === 'china') return value.isChina;
            return true;
        })
        .sort((a, b) => {
            if (a[1].isChina === b[1].isChina) return a[0].localeCompare(b[0]);
            return a[1].isChina ? 1 : -1;
        });

    if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<div class="empty-icon">-</div><p>No domains match the current filter</p>';
        elMergedResults.appendChild(empty);
        return;
    }

    const listContainer = document.createElement('div');

    for (const [rootDomain, info] of entries) {
        listContainer.appendChild(createDomainItem(rootDomain, {
            isChina: info.isChina,
            ips: [...info.ips],
            subdomains: [...info.subdomains]
        }));

        if (info.sources.size > 0) {
            const sourceTags = document.createElement('div');
            sourceTags.className = 'source-tags';
            for (const src of info.sources) {
                const tag = document.createElement('span');
                tag.className = 'source-tag';
                tag.textContent = src;
                sourceTags.appendChild(tag);
            }
            listContainer.appendChild(sourceTags);
        }
    }

    elMergedResults.appendChild(listContainer);
}

async function loadHistory() {
    const data = await chrome.storage.local.get('domainHistory');
    return data.domainHistory || [];
}

function buildDomainsSignature(domains) {
    const normalized = Object.entries(domains || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([domain, info]) => {
            const normalizedInfo = normalizeDomainInfo(info);
            return [
                domain,
                normalizedInfo.isChina,
                [...normalizedInfo.ips].sort(),
                [...normalizedInfo.subdomains].sort()
            ];
        });

    return JSON.stringify(normalized);
}

async function saveToHistory(url, domains) {
    if (!domains || Object.keys(domains).length === 0) return;

    const history = await loadHistory();
    const entries = Object.entries(domains);
    const recordSignature = buildDomainsSignature(domains);

    const record = {
        id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        url,
        timestamp: Date.now(),
        domains,
        nonChinaCount: entries.filter(([, value]) => value.isChina === false).length,
        chinaCount: entries.filter(([, value]) => value.isChina !== false).length,
        signature: recordSignature
    };

    const existingIndex = history.findIndex((item) => item.url === url);
    if (existingIndex >= 0) {
        if (history[existingIndex].signature === recordSignature) {
            return;
        }
        history[existingIndex] = record;
    } else {
        history.unshift(record);
    }

    while (history.length > MAX_HISTORY) {
        history.pop();
    }

    await chrome.storage.local.set({ domainHistory: history });
}

async function deleteHistoryItem(id) {
    const history = await loadHistory();
    await chrome.storage.local.set({ domainHistory: history.filter((item) => item.id !== id) });
    renderHistory();
}

async function clearAllHistory() {
    await chrome.storage.local.set({ domainHistory: [] });
    renderHistory();
}

async function renderHistory() {
    const history = await loadHistory();
    elHistoryResults.innerHTML = '';
    elHistoryCount.textContent = `${history.length} item(s)`;

    if (history.length === 0) {
        elHistoryResults.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">-</div>
            <p>No history yet</p>
          </div>
        `;
        return;
    }

    for (const record of history) {
        const item = document.createElement('div');
        item.className = 'history-item';

        let hostname = '';
        try {
            hostname = new URL(record.url).hostname;
        } catch {
            hostname = record.url;
        }

        const date = new Date(record.timestamp);
        const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        const totalDomains = (record.nonChinaCount || 0) + (record.chinaCount || 0);

        item.innerHTML = `
          <div class="history-item-header">
            <span class="history-url" title="${escapeHtml(record.url)}">${escapeHtml(hostname)}</span>
            <button class="history-delete" data-id="${record.id}" title="Delete">Delete</button>
          </div>
          <div class="history-item-meta">
            <span class="history-time">${timeStr}</span>
            <span class="history-stats">${totalDomains} domains / ${record.nonChinaCount || 0} non-CN / ${record.chinaCount || 0} CN</span>
          </div>
        `;

        const headerEl = item.querySelector('.history-item-header');
        headerEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('history-delete')) return;

            let detail = item.querySelector('.history-detail');
            if (detail) {
                detail.remove();
                return;
            }

            detail = document.createElement('div');
            detail.className = 'history-detail';

            const sorted = Object.entries(record.domains || {}).sort((a, b) => {
                if (a[1].isChina === b[1].isChina) return a[0].localeCompare(b[0]);
                return a[1].isChina ? 1 : -1;
            });

            for (const [rootDomain, info] of sorted) {
                detail.appendChild(createDomainItem(rootDomain, info));
            }

            const loadBtn = document.createElement('button');
            loadBtn.className = 'btn-load-history';
            loadBtn.textContent = 'Load into merged results';
            loadBtn.addEventListener('click', () => {
                allResults[record.id] = {
                    source: record.url,
                    domains: record.domains
                };
                updateStats();
                showToast('History loaded');
            });
            detail.appendChild(loadBtn);

            item.appendChild(detail);
        });

        item.querySelector('.history-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteHistoryItem(record.id);
        });

        elHistoryResults.appendChild(item);
    }
}

function createLoadingElement(url) {
    const el = document.createElement('div');
    el.className = 'task-loading';
    el._taskId = null;
    el.innerHTML = `
      <div class="task-loading-top">
        <div class="spinner"></div>
        <span class="task-url">${escapeHtml(url)}</span>
        <span class="task-countdown">30s</span>
        <button class="task-skip" title="Skip this URL">Skip</button>
      </div>
      <div class="task-progress-bar">
        <div class="task-progress-fill"></div>
      </div>
    `;

    let remaining = 30;
    const countdownEl = el.querySelector('.task-countdown');
    const progressFill = el.querySelector('.task-progress-fill');
    const countdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            countdownEl.textContent = 'Finishing';
            clearInterval(countdownInterval);
        } else {
            countdownEl.textContent = `${remaining}s`;
        }
        progressFill.style.width = `${((30 - remaining) / 30) * 100}%`;
    }, 1000);
    el._countdownInterval = countdownInterval;

    el.querySelector('.task-skip').addEventListener('click', (e) => {
        e.stopPropagation();
        if (el._taskId) {
            chrome.runtime.sendMessage({ type: 'cancelTask', taskId: el._taskId });
        }
    });

    return el;
}

function setAnalyzeButtonLoading(isLoading) {
    elBtnAnalyze.disabled = isLoading;
    elBtnAnalyze.querySelector('.btn-text').style.display = isLoading ? 'none' : 'inline';
    elBtnAnalyze.querySelector('.btn-loading').style.display = isLoading ? 'inline' : 'none';
}

function finishManualTask(taskId, url, loadingEl, domains) {
    if (completedManualTasks.has(taskId)) {
        return;
    }
    completedManualTasks.add(taskId);

    if (loadingEl._countdownInterval) {
        clearInterval(loadingEl._countdownInterval);
    }
    loadingEl.remove();

    allResults[taskId] = {
        source: url,
        domains: domains || {}
    };

    renderSiteGroup(elManualResults, url, domains || {});
    saveToHistory(url, domains || {});
    updateStats();

    runningTasks = Math.max(0, runningTasks - 1);
    runNextQueuedAnalysis();

    const allDone = manualTaskIds.every((task) => allResults[task.taskId] !== undefined);
    if (allDone && pendingQueue.length === 0 && runningTasks === 0) {
        setAnalyzeButtonLoading(false);
    }
}

function pollTask(taskId, url, loadingEl) {
    let pollCount = 0;

    const poll = () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
            finishManualTask(taskId, url, loadingEl, {});
            return;
        }

        chrome.runtime.sendMessage({ type: 'getTaskStatus', taskId }, (response) => {
            if (chrome.runtime.lastError || !response || response.status === 'not_found') {
                finishManualTask(taskId, url, loadingEl, {});
                return;
            }

            if (response.status === 'done' || response.status === 'timeout' || response.status === 'cancelled' || response.status === 'interrupted') {
                finishManualTask(taskId, url, loadingEl, response.domains || {});
                return;
            }

            setTimeout(poll, 1000);
        });
    };

    setTimeout(poll, 2000);
}

function runNextQueuedAnalysis() {
    while (runningTasks < MAX_CONCURRENT_ANALYSIS && pendingQueue.length > 0) {
        const { url, loadingEl } = pendingQueue.shift();
        runningTasks++;

        chrome.runtime.sendMessage({ type: 'analyzeUrl', url, waitTime: 6000 }, (response) => {
            if (chrome.runtime.lastError || !response?.taskId) {
                finishManualTask(`failed_${Date.now()}`, url, loadingEl, {});
                return;
            }

            manualTaskIds.push({ taskId: response.taskId, url, loadingEl });
            loadingEl._taskId = response.taskId;
            pollTask(response.taskId, url, loadingEl);
        });
    }
}

function parseInputUrls(input) {
    return input
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => {
            if (/^https?:\/\//i.test(line)) return true;
            if (line.includes('.') && !line.includes(' ') && !/^\d+[/-]/.test(line)) return true;
            return false;
        })
        .map((line) => (/^https?:\/\//i.test(line) ? line : `https://${line}`));
}

async function init() {
    const manifest = chrome.runtime.getManifest();
    $('#headerVersion').textContent = `v${manifest.version}`;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            elCurrentUrl.textContent = 'No active tab found';
            return;
        }

        elCurrentUrl.textContent = tab.url || 'Cannot read current URL';

        chrome.runtime.sendMessage({ type: 'getTabData', tabId: tab.id }, (response) => {
            if (chrome.runtime.lastError || !response || Object.keys(response.domains || {}).length === 0) {
                elCurrentResults.innerHTML = `
                  <div class="empty-state">
                    <div class="empty-icon">-</div>
                    <p>尚未记录到数据。如需探测，请先开启\"全局流量探测\"开关，然后刷新页面。</p>
                  </div>
                `;
                return;
            }

            allResults.__current__ = {
                source: tab.url,
                domains: response.domains
            };
            renderSiteGroup(elCurrentResults, tab.url, response.domains);
            updateStats();
            saveToHistory(tab.url, response.domains);
        });
        chrome.runtime.sendMessage({ type: 'getDetectionState' }, (response) => {
            if (!chrome.runtime.lastError && response) {
                elDetectionToggle.checked = response.enabled;
            }
        });
    } catch (error) {
        elCurrentUrl.textContent = `Error: ${error.message}`;
    }
}

elDetectionToggle.addEventListener('change', (e) => {
    const isEnabled = e.target.checked;
    chrome.runtime.sendMessage({ type: 'setDetectionState', enabled: isEnabled }, () => {
        if (isEnabled) {
            showToast('已开启全局探测，请刷新页面');
        } else {
            showToast('已关闭全局探测');
        }
    });
});

$$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        $$('.tab').forEach((item) => item.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;

        $$('.panel').forEach((panel) => panel.classList.remove('active'));
        $(`#panel-${activeTab}`).classList.add('active');

        if (activeTab === 'merged') {
            renderMergedResults();
        } else if (activeTab === 'history') {
            renderHistory();
        }
    });
});

elBtnAnalyze.addEventListener('click', () => {
    const input = elUrlInput.value.trim();
    if (!input) return;

    const urls = parseInputUrls(input);
    if (urls.length === 0) {
        showToast('No valid URLs found');
        return;
    }

    setAnalyzeButtonLoading(true);
    elManualResults.innerHTML = '';
    manualTaskIds = [];
    pendingQueue = [];
    runningTasks = 0;
    completedManualTasks.clear();

    for (const url of urls) {
        const loadingEl = createLoadingElement(url);
        elManualResults.appendChild(loadingEl);
        pendingQueue.push({ url, loadingEl });
    }

    runNextQueuedAnalysis();
});

elBtnCopyNonChina.addEventListener('click', () => {
    copyToClipboard(collectDomains(false));
});

elBtnCopyAll.addEventListener('click', () => {
    copyToClipboard(collectDomains(null));
});

elBtnClearHistory.addEventListener('click', () => {
    if (confirm('Clear all history?')) {
        clearAllHistory();
    }
});

init();
