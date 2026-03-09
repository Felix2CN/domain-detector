/**
 * 构建脚本：从 APNIC 委派数据生成中国 IP 段文件
 * 数据来源：https://ftp.apnic.net/stats/apnic/delegated-apnic-latest
 * 输出格式：[startInt, endInt] 整数对数组，用于二分查找
 */

const fs = require('fs');
const path = require('path');

const APNIC_FILE = process.argv[2] || path.join(__dirname, 'apnic_data.txt');
const OUTPUT_FILE = path.join(__dirname, '..', 'china_ip.js');

function ip2int(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseDelegated(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const ranges = [];

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith(' ') || !line.trim()) continue;
    const parts = line.split('|');
    // 格式: registry|cc|type|start|value|date|status[|extensions]
    if (parts.length < 5) continue;
    if (parts[1] !== 'CN' || parts[2] !== 'ipv4') continue;

    const startIp = parts[3];
    const count = parseInt(parts[4], 10);
    const startInt = ip2int(startIp);
    const endInt = (startInt + count - 1) >>> 0;
    ranges.push([startInt, endInt]);
  }

  // 按起始 IP 排序
  ranges.sort((a, b) => a[0] - b[0]);

  // 合并相邻/重叠区间
  const merged = [];
  for (const range of ranges) {
    if (merged.length === 0) {
      merged.push([...range]);
      continue;
    }
    const last = merged[merged.length - 1];
    if (range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  return merged;
}

// 执行
console.log(`读取 APNIC 数据: ${APNIC_FILE}`);
const ranges = parseDelegated(APNIC_FILE);
console.log(`提取中国 IPv4 段: ${ranges.length} 条（合并后）`);

// 生成 JS 文件
const jsContent = `/**
 * 中国 IP 地址段数据
 * 来源: APNIC delegated-apnic-latest
 * 生成时间: ${new Date().toISOString()}
 * 条目数: ${ranges.length} 条（已合并相邻段）
 * 格式: [起始IP整数, 结束IP整数]
 */

const CHINA_IP_RANGES = ${JSON.stringify(ranges)};

/**
 * 将 IP 字符串转为 32 位无符号整数
 */
function ip2int(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/**
 * 二分查找判断 IP 是否属于中国
 * @param {string} ipStr - IPv4 地址字符串
 * @returns {boolean}
 */
function isChineseIP(ipStr) {
  if (!ipStr || !ipStr.match(/^\\d+\\.\\d+\\.\\d+\\.\\d+$/)) return false;
  const target = ip2int(ipStr);
  let lo = 0, hi = CHINA_IP_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = CHINA_IP_RANGES[mid];
    if (target < start) {
      hi = mid - 1;
    } else if (target > end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}
`;

fs.writeFileSync(OUTPUT_FILE, jsContent, 'utf-8');
const sizeKB = (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1);
console.log(`输出文件: ${OUTPUT_FILE} (${sizeKB} KB)`);
console.log('构建完成！');
