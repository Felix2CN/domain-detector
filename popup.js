/**
 * 域名探测器 - Popup 逻辑
 * 职责：UI 交互、数据展示、复制功能
 */

// ============================================================
// 全局状态
// ============================================================

let currentFilter = 'all'; // 'all' | 'foreign' | 'china'
let allResults = {}; // { source: url, domains: {} } 的集合
let activeTab = 'current';
let manualTaskIds = []; // 手动分析的任务 ID

// ============================================================
// DOM 元素
// ============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const elCurrentUrl = $('#currentUrl');
const elCurrentResults = $('#currentResults');
const elManualResults = $('#manualResults');
const elMergedResults = $('#mergedResults');
const elUrlInput = $('#urlInput');
const elBtnAnalyze = $('#btnAnalyze');
const elStatNonChina = $('#statNonChina');
const elStatChina = $('#statChina');
const elBtnCopyNonChina = $('#btnCopyNonChina');
const elBtnCopyAll = $('#btnCopyAll');
const elToast = $('#toast');
const elHistoryResults = $('#historyResults');
const elHistoryCount = $('#historyCount');
const elBtnClearHistory = $('#btnClearHistory');

// ============================================================
// 标签页切换
// ============================================================

$$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;

        $$('.panel').forEach(p => p.classList.remove('active'));
        $(`#panel-${activeTab}`).classList.add('active');

        if (activeTab === 'merged') {
            renderMergedResults();
        } else if (activeTab === 'history') {
            renderHistory();
        }
    });
});

// ============================================================
// 初始化：加载当前标签页数据
// ============================================================

async function init() {
    // 显示版本号
    const manifest = chrome.runtime.getManifest();
    $('#headerVersion').textContent = `v${manifest.version}`;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            elCurrentUrl.textContent = '未找到活动标签页';
            return;
        }

        elCurrentUrl.textContent = `📍 ${tab.url || '无法获取URL'}`;

        // 请求 background 获取该标签页数据
        chrome.runtime.sendMessage(
            { type: 'getTabData', tabId: tab.id },
            (response) => {
                if (response && Object.keys(response.domains).length > 0) {
                    allResults['__current__'] = {
                        source: tab.url,
                        domains: response.domains
                    };
                    renderSiteGroup(elCurrentResults, tab.url, response.domains);
                    updateStats();
                    // 自动保存到历史
                    saveToHistory(tab.url, response.domains);
                } else {
                    elCurrentResults.innerHTML = `
            <div class="empty-state">
              <div class="empty-icon">🌐</div>
              <p>当前页面暂无网络请求数据<br>请刷新页面后重试</p>
            </div>
          `;
                }
            }
        );
    } catch (err) {
        elCurrentUrl.textContent = `错误: ${err.message}`;
    }
}

// ============================================================
// 手动分析
// ============================================================

elBtnAnalyze.addEventListener('click', async () => {
    const input = elUrlInput.value.trim();
    if (!input) return;

    const urls = input.split('\n')
        .map(u => u.trim())
        .filter(u => u.length > 0)
        .filter(u => {
            // 智能过滤：只保留看起来像 URL 的行
            // 1. 以 http:// 或 https:// 开头 → 明确是 URL
            if (/^https?:\/\//i.test(u)) return true;
            // 2. 像裸域名：包含点号、无空格、不全是数字/日期
            if (u.includes('.') && !u.includes(' ') && !/^\d+[\/\-]/.test(u)) return true;
            // 其他都过滤掉（人名、时间戳、聊天消息等）
            return false;
        })
        .map(u => {
            // 自动补全协议
            if (!u.startsWith('http://') && !u.startsWith('https://')) {
                return 'https://' + u;
            }
            return u;
        });

    if (urls.length === 0) return;

    // 禁用按钮
    elBtnAnalyze.disabled = true;
    elBtnAnalyze.querySelector('.btn-text').style.display = 'none';
    elBtnAnalyze.querySelector('.btn-loading').style.display = 'inline';

    // 清空之前的手动结果
    elManualResults.innerHTML = '';
    manualTaskIds = [];

    // 为每个 URL 创建加载状态
    for (const url of urls) {
        const loadingEl = createLoadingElement(url);
        elManualResults.appendChild(loadingEl);

        chrome.runtime.sendMessage(
            { type: 'analyzeUrl', url: url, waitTime: 6000 },
            (response) => {
                if (response && response.taskId) {
                    manualTaskIds.push({ taskId: response.taskId, url, loadingEl });
                    loadingEl._taskId = response.taskId;
                    pollTask(response.taskId, url, loadingEl);
                }
            }
        );
    }
});

/**
 * 轮询任务状态
 */
function pollTask(taskId, url, loadingEl) {
    let pollCount = 0;
    const MAX_POLLS = 40; // 最多轮询 40 次（约 42 秒），防止无限轮询

    const finishTask = (domains) => {
        // 清除倒计时
        if (loadingEl._countdownInterval) {
            clearInterval(loadingEl._countdownInterval);
        }
        // 移除加载状态
        loadingEl.remove();

        // 存储结果
        allResults[taskId] = {
            source: url,
            domains: domains || {}
        };

        // 渲染结果
        renderSiteGroup(elManualResults, url, domains || {});

        // 自动保存到历史
        saveToHistory(url, domains);

        // 检查是否所有任务都完成
        checkAllTasksDone();
        updateStats();
    };

    const poll = () => {
        pollCount++;

        // 安全阀：超过最大轮询次数，强制完成
        if (pollCount > MAX_POLLS) {
            finishTask({});
            return;
        }

        chrome.runtime.sendMessage(
            { type: 'getTaskStatus', taskId },
            (response) => {
                // Service Worker 重启或通信失败
                if (!response || response.status === 'not_found') {
                    finishTask({});
                    return;
                }

                if (response.status === 'done' || response.status === 'timeout') {
                    finishTask(response.domains);
                } else {
                    // 继续轮询
                    setTimeout(poll, 1000);
                }
            }
        );
    };

    setTimeout(poll, 2000);
}

function checkAllTasksDone() {
    const allDone = manualTaskIds.every(t => {
        return allResults[t.taskId] !== undefined;
    });

    if (allDone && manualTaskIds.length > 0) {
        elBtnAnalyze.disabled = false;
        elBtnAnalyze.querySelector('.btn-text').style.display = 'inline';
        elBtnAnalyze.querySelector('.btn-loading').style.display = 'none';
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
      <button class="task-skip" title="跳过此URL">跳过</button>
    </div>
    <div class="task-progress-bar">
      <div class="task-progress-fill"></div>
    </div>
  `;

    // 倒计时
    let remaining = 30;
    const countdownEl = el.querySelector('.task-countdown');
    const progressFill = el.querySelector('.task-progress-fill');
    const countdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            countdownEl.textContent = '即将完成';
            clearInterval(countdownInterval);
        } else {
            countdownEl.textContent = `${remaining}s`;
        }
        progressFill.style.width = `${((30 - remaining) / 30) * 100}%`;
    }, 1000);
    el._countdownInterval = countdownInterval;

    // 跳过按钮
    const skipBtn = el.querySelector('.task-skip');
    skipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el._taskId) {
            chrome.runtime.sendMessage({ type: 'cancelTask', taskId: el._taskId });
        }
    });

    return el;
}

// ============================================================
// 渲染
// ============================================================

/**
 * 创建单个域名条目（带复制按钮）
 */
function createDomainItem(rootDomain, info) {
    const item = document.createElement('div');
    item.className = 'domain-item';

    const tagClass = info.isChina ? 'tag-china' : 'tag-foreign';
    const tagText = info.isChina ? '中国' : '非中国';
    const ips = info.ips || [];
    const ipDisplay = Array.isArray(ips) ? (ips[0] || '') : ([...ips][0] || '');
    const ipTitle = Array.isArray(ips) ? ips.join(', ') : [...ips].join(', ');
    const subdomains = info.subdomains || [];
    const subTitle = Array.isArray(subdomains) ? subdomains.join(', ') : [...subdomains].join(', ');

    item.innerHTML = `
      <span class="domain-name" title="${escapeHtml(subTitle || rootDomain)}">*.${escapeHtml(rootDomain)}</span>
      <span class="domain-tag ${tagClass}">${tagText}</span>
      <span class="domain-ip" title="${escapeHtml(ipTitle)}">${escapeHtml(ipDisplay)}</span>
      <button class="domain-copy" title="复制">📋</button>
    `;

    // 复制按钮
    const copyBtn = item.querySelector('.domain-copy');
    copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(`*.${rootDomain}`);
    });

    return item;
}
function renderSiteGroup(container, sourceUrl, domains) {
    // 清除空状态
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    let hostname = '';
    try {
        hostname = new URL(sourceUrl).hostname;
    } catch {
        hostname = sourceUrl;
    }

    const domainEntries = Object.entries(domains);
    const nonChinaCount = domainEntries.filter(([, v]) => !v.isChina).length;

    const group = document.createElement('div');
    group.className = 'site-group';

    // 头部
    const header = document.createElement('div');
    header.className = 'site-header';
    header.innerHTML = `
    <span class="site-name">📍 ${escapeHtml(hostname)}</span>
    <span class="site-badge">${domainEntries.length} 个域名 · ${nonChinaCount} 个非中国</span>
  `;

    // 折叠切换
    const body = document.createElement('div');
    body.className = 'site-body';

    header.addEventListener('click', () => {
        body.classList.toggle('collapsed');
    });

    // 排序：非中国排前面
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

/**
 * 渲染合并结果
 */
function renderMergedResults() {
    elMergedResults.innerHTML = '';

    if (Object.keys(allResults).length === 0) {
        elMergedResults.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>暂无分析结果</p>
      </div>
    `;
        return;
    }

    // 合并所有域名
    const merged = {}; // { rootDomain: { isChina, ips: Set, subdomains: Set, sources: Set } }

    for (const [key, result] of Object.entries(allResults)) {
        let sourceHost = '';
        try {
            sourceHost = new URL(result.source).hostname;
        } catch {
            sourceHost = result.source;
        }

        for (const [rootDomain, info] of Object.entries(result.domains)) {
            if (!merged[rootDomain]) {
                merged[rootDomain] = {
                    isChina: info.isChina,
                    ips: new Set(info.ips || []),
                    subdomains: new Set(info.subdomains || []),
                    sources: new Set()
                };
            } else {
                (info.ips || []).forEach(ip => merged[rootDomain].ips.add(ip));
                (info.subdomains || []).forEach(s => merged[rootDomain].subdomains.add(s));
                if (!info.isChina) merged[rootDomain].isChina = false;
            }
            merged[rootDomain].sources.add(sourceHost);
        }
    }

    // 筛选栏
    const filterBar = document.createElement('div');
    filterBar.className = 'filter-bar';

    const filters = [
        { key: 'all', label: `全部 (${Object.keys(merged).length})` },
        { key: 'foreign', label: `非中国 (${Object.values(merged).filter(v => !v.isChina).length})` },
        { key: 'china', label: `中国 (${Object.values(merged).filter(v => v.isChina).length})` }
    ];

    for (const f of filters) {
        const btn = document.createElement('button');
        btn.className = `filter-btn ${f.key === currentFilter ? 'active' : ''}`;
        btn.textContent = f.label;
        btn.addEventListener('click', () => {
            currentFilter = f.key;
            renderMergedResults();
        });
        filterBar.appendChild(btn);
    }
    elMergedResults.appendChild(filterBar);

    // 域名列表
    const entries = Object.entries(merged)
        .filter(([, v]) => {
            if (currentFilter === 'foreign') return !v.isChina;
            if (currentFilter === 'china') return v.isChina;
            return true;
        })
        .sort((a, b) => {
            if (a[1].isChina === b[1].isChina) return a[0].localeCompare(b[0]);
            return a[1].isChina ? 1 : -1;
        });

    if (entries.length === 0) {
        elMergedResults.innerHTML += `
      <div class="empty-state">
        <div class="empty-icon">✨</div>
        <p>没有匹配的域名</p>
      </div>
    `;
        return;
    }

    const listContainer = document.createElement('div');

    for (const [rootDomain, info] of entries) {
        listContainer.appendChild(createDomainItem(rootDomain, {
            isChina: info.isChina,
            ips: [...info.ips],
            subdomains: [...info.subdomains]
        }));

        // 来源标签
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

// ============================================================
// 统计更新
// ============================================================

function updateStats() {
    const merged = {};
    for (const result of Object.values(allResults)) {
        for (const [rootDomain, info] of Object.entries(result.domains)) {
            if (!merged[rootDomain]) {
                merged[rootDomain] = { isChina: info.isChina };
            } else if (!info.isChina) {
                merged[rootDomain].isChina = false;
            }
        }
    }

    const nonChina = Object.values(merged).filter(v => !v.isChina).length;
    const china = Object.values(merged).filter(v => v.isChina).length;

    elStatNonChina.textContent = nonChina;
    elStatChina.textContent = china;
}

// ============================================================
// 复制功能
// ============================================================

elBtnCopyNonChina.addEventListener('click', () => {
    const domains = collectDomains(false);
    copyToClipboard(domains);
});

elBtnCopyAll.addEventListener('click', () => {
    const domains = collectDomains(null);
    copyToClipboard(domains);
});

function collectDomains(chinaFilter) {
    const merged = {};
    for (const result of Object.values(allResults)) {
        for (const [rootDomain, info] of Object.entries(result.domains)) {
            if (!merged[rootDomain]) {
                merged[rootDomain] = { isChina: info.isChina };
            } else if (!info.isChina) {
                merged[rootDomain].isChina = false;
            }
        }
    }

    return Object.entries(merged)
        .filter(([, v]) => chinaFilter === null || v.isChina === chinaFilter)
        .map(([domain]) => `*.${domain}`)
        .sort()
        .join('\n');
}

async function copyToClipboard(text) {
    if (!text) {
        showToast('❌ 没有可复制的域名');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showToast(`✅ 已复制 ${text.split('\n').length} 个域名`);
    } catch {
        // 降级方案
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(`✅ 已复制 ${text.split('\n').length} 个域名`);
    }
}

function showToast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    setTimeout(() => elToast.classList.remove('show'), 2000);
}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ============================================================
// 历史记录
// ============================================================

const MAX_HISTORY = 50;

async function loadHistory() {
    const data = await chrome.storage.local.get('domainHistory');
    return data.domainHistory || [];
}

async function saveToHistory(url, domains) {
    if (!domains || Object.keys(domains).length === 0) return;

    const history = await loadHistory();

    const entries = Object.entries(domains);
    const nonChinaCount = entries.filter(([, v]) => !v.isChina).length;
    const chinaCount = entries.filter(([, v]) => v.isChina).length;

    const record = {
        id: 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        url: url,
        timestamp: Date.now(),
        domains: domains,
        nonChinaCount: nonChinaCount,
        chinaCount: chinaCount
    };

    // 检查是否已有相同 URL 的记录（更新而非重复插入）
    const existingIndex = history.findIndex(h => h.url === url);
    if (existingIndex >= 0) {
        history[existingIndex] = record;
    } else {
        history.unshift(record);
    }

    // 限制最大条目数
    while (history.length > MAX_HISTORY) {
        history.pop();
    }

    await chrome.storage.local.set({ domainHistory: history });
}

async function deleteHistoryItem(id) {
    const history = await loadHistory();
    const filtered = history.filter(h => h.id !== id);
    await chrome.storage.local.set({ domainHistory: filtered });
    renderHistory();
}

async function clearAllHistory() {
    await chrome.storage.local.set({ domainHistory: [] });
    renderHistory();
}

async function renderHistory() {
    const history = await loadHistory();
    elHistoryResults.innerHTML = '';
    elHistoryCount.textContent = `${history.length} 条记录`;

    if (history.length === 0) {
        elHistoryResults.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📜</div>
          <p>暂无历史记录</p>
        </div>`;
        return;
    }

    for (const record of history) {
        const item = document.createElement('div');
        item.className = 'history-item';

        let hostname = '';
        try { hostname = new URL(record.url).hostname; } catch { hostname = record.url; }

        const date = new Date(record.timestamp);
        const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        const totalDomains = record.nonChinaCount + record.chinaCount;

        item.innerHTML = `
        <div class="history-item-header">
          <span class="history-url" title="${escapeHtml(record.url)}">📍 ${escapeHtml(hostname)}</span>
          <button class="history-delete" data-id="${record.id}" title="删除">✕</button>
        </div>
        <div class="history-item-meta">
          <span class="history-time">🕐 ${timeStr}</span>
          <span class="history-stats">${totalDomains} 域名 · <span class="text-red">${record.nonChinaCount} 非中国</span> · <span class="text-green">${record.chinaCount} 中国</span></span>
        </div>`;

        // 点击展开详情
        const headerEl = item.querySelector('.history-item-header');
        headerEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('history-delete')) return;

            // 切换详情展示
            let detail = item.querySelector('.history-detail');
            if (detail) {
                detail.remove();
                return;
            }

            detail = document.createElement('div');
            detail.className = 'history-detail';

            const sorted = Object.entries(record.domains).sort((a, b) => {
                if (a[1].isChina === b[1].isChina) return a[0].localeCompare(b[0]);
                return a[1].isChina ? 1 : -1;
            });

            for (const [rootDomain, info] of sorted) {
                detail.appendChild(createDomainItem(rootDomain, info));
            }

            // “加载到合并结果”按钮
            const loadBtn = document.createElement('button');
            loadBtn.className = 'btn-load-history';
            loadBtn.textContent = '📋 加载到合并结果';
            loadBtn.addEventListener('click', () => {
                allResults[record.id] = {
                    source: record.url,
                    domains: record.domains
                };
                updateStats();
                showToast('✅ 已加载到合并结果');
            });
            detail.appendChild(loadBtn);

            item.appendChild(detail);
        });

        // 删除按钮
        const deleteBtn = item.querySelector('.history-delete');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteHistoryItem(record.id);
        });

        elHistoryResults.appendChild(item);
    }
}

// 清空历史按钮
elBtnClearHistory.addEventListener('click', () => {
    if (confirm('确定要清空所有历史记录吗？')) {
        clearAllHistory();
    }
});

// ============================================================
// 启动
// ============================================================

init();
