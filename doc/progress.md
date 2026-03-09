# 域名探测器 - 开发进展文档

## 项目信息
- **项目路径**: `D:\OneDrive - FX\AI Studio\domain-detector\`
- **版本**: v1.0.0
- **创建时间**: 2026-03-09

## 功能概述
Chrome 浏览器扩展，用于分析网页加载的第三方域名，自动识别非中国域名，帮助配置防火墙白名单。

### 核心功能
1. **自动捕获**：浏览网页时自动记录所有网络请求的域名和 IP
2. **手动分析**：支持输入多个 URL，后台自动打开分析
3. **中国 IP 判定**：内嵌 APNIC 中国 IP 段数据，离线判断
4. **结果分组**：按来源网站分组展示
5. **域名合并**：相同根域跨站去重合并
6. **一键复制**：以 `*.xxx.com` 格式复制非中国域名

### 技术方案
- Chrome Manifest V3
- `chrome.webRequest.onResponseStarted` 获取真实服务器 IP
- APNIC CN IPv4 数据（4108 条合并段），二分查找
- 无外部依赖，完全离线运行

## 文件结构
```
domain-detector/
├── manifest.json          → 扩展配置  
├── background.js          → Service Worker，监听网络请求
├── china_ip.js            → 中国 IP 段数据（96KB，自动生成）
├── popup.html             → 弹出窗口 HTML
├── popup.css              → 样式（深色主题）
├── popup.js               → 弹出窗口交互逻辑
├── icons/                 → 扩展图标 (16/48/128px)
├── scripts/
│   ├── build_china_ip.js  → APNIC 数据处理脚本
│   └── apnic_data.txt     → APNIC 原始数据
└── doc/
    └── progress.md        → 本文档
```

## 开发日志

### 2026-03-09 v1.0.0
- [x] 下载并处理 APNIC 中国 IP 段数据（4108 条）
- [x] 创建 manifest.json（Manifest V3）
- [x] 实现 background.js（网络请求监听 + 手动分析）
- [x] 实现 popup.html/css/js（三标签面板 UI）
- [x] 生成扩展图标
- [x] 创建进展文档

### 2026-03-09 v1.1.0
- [x] 修复：轮询逻辑在 Service Worker 重启后无限轮询的 bug
- [x] 修复：response 为 null 时 UI 永远显示"分析中"
- [x] 修复：manifest.json 缺少 webNavigation 权限声明
- [x] 优化：手动分析添加倒计时（30s）+ 进度条 + 跳过按钮
- [x] 优化：轮询增加 MAX_POLLS 安全阀（最多 42 秒）
- [x] 新增：历史记录功能（chrome.storage.local，最多 50 条）
- [x] 新增：历史记录面板（第四个标签页），支持展开详情、删除、清空、加载到合并结果
- [x] 新增：当前页面和手动分析结果自动保存到历史
- [x] 新增：URL 输入智能过滤（自动跳过人名、时间戳等非 URL 行）
- [x] 新增：background.js 添加 cancelTask 消息处理器

## 安装方式
1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择本项目文件夹

## 更新中国 IP 数据
重新下载 APNIC 数据并执行构建脚本：
```bash
# 下载最新 APNIC 数据
curl -o scripts/apnic_data.txt https://ftp.apnic.net/stats/apnic/delegated-apnic-latest
# 重新生成 china_ip.js
node scripts/build_china_ip.js
```
