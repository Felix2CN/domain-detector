# 域名探测器 (Domain Detector)

Chrome 扩展，用于分析网页请求涉及的第三方域名，识别非中国域名，辅助配置防火墙白名单。

## 功能

- 自动捕获当前页面的网络请求，按根域名聚合展示。
- 支持批量输入 URL，在后台自动打开并分析。
- 内置 APNIC 中国 IPv4 数据，离线判断 IP 是否属于中国。
- 代理环境下支持 DNS-over-HTTPS 获取真实 IP。
- 支持结果合并、去重、复制和历史记录。

## 最近优化

- 为 Manifest V3 service worker 增加 `chrome.storage.session` 状态持久化，降低 worker 回收导致的数据丢失风险。
- 为 DoH 查询增加并发去重，避免同一 hostname 短时间内重复发起解析。
- 为手动批量分析增加并发队列，默认同时处理 3 个 URL，降低浏览器压力。
- 收紧任务生命周期，补充超时、中断、取消后的清理逻辑。
- 历史记录增加签名去重，结果未变化时不重复写入存储。
- 增加本地校验脚本，检查 BOM、Manifest JSON 和关键脚本语法。

## 项目结构

```text
domain-detector/
├─ manifest.json
├─ background.js
├─ china_ip.js
├─ popup.html
├─ popup.css
├─ popup.js
├─ icons/
├─ scripts/
│  ├─ build_china_ip.js
│  ├─ validate.js
│  └─ apnic_data.txt
└─ doc/
```

## 安装

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目目录

## 本地校验

```bash
node scripts/validate.js
```

## 更新中国 IP 数据

```bash
curl -o scripts/apnic_data.txt https://ftp.apnic.net/stats/apnic/delegated-apnic-latest
node scripts/build_china_ip.js
node scripts/validate.js
```

## 权限说明

- `webRequest`: 监听网络请求并读取响应 IP
- `webNavigation`: 跟踪页面主导航
- `storage`: 保存历史记录和后台状态
- `activeTab`: 获取当前标签页信息
- `tabs`: 手动分析时创建后台标签页
- `scripting`: 预留脚本注入能力
- `<all_urls>`: 监听所有请求

## 版本

### v1.1.0 (2026-03-09)

- 修复代理环境下 IP 识别异常
- 新增 DNS-over-HTTPS 真实 IP 解析
- 新增历史记录
- 新增批量分析倒计时、跳过和进度反馈
- 优化轮询、状态持久化和批量任务并发控制
