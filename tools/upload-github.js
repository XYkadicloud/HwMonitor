// Upload the project to GitHub using the Contents API.
//
// Git is not installed on this machine (a portable download proved too slow to
// finish), so the files are pushed through the API instead.
//
// The Git Data API (blob -> tree -> commit -> ref) cannot be used here: it refuses
// to create blobs in a repository that has no commits yet
// ("409 Git Repository is empty"). The Contents API has no such restriction and
// creates the initial commit itself, so it is used for the first push. Later
// updates can use the Git Data API, or plain `git` once it is installed.
//
// Usage: node tools/upload-github.js <owner> <repo> [branch]
//
// The token is read from GITHUB_TOKEN and is never written to disk or printed.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OWNER = process.argv[2];
const REPO = process.argv[3];
const BRANCH = process.argv[4] || 'main';
const TOKEN = process.env.GITHUB_TOKEN;

if (!OWNER || !REPO) {
  console.error('usage: node tools/upload-github.js <owner> <repo> [branch]');
  process.exit(1);
}
if (!TOKEN) {
  console.error('error: GITHUB_TOKEN is not set.');
  process.exit(1);
}

const API = 'https://api.github.com';

/**
 * Directories never uploaded.
 *
 * data/ holds the access password, the SSH host list and machine-specific caches;
 * archive/ holds retired code. Both are excluded deliberately -- publishing either
 * would leak credentials or clutter the repository.
 */
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'data', 'archive']);

function collect(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...collect(full, rel));
    } else {
      out.push({ rel, full });
    }
  }
  return out;
}

async function gh(method, apiPath, body) {
  const res = await fetch(`${API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'HwMonitor-uploader',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = (json && json.message) || text.slice(0, 200);
    const err = new Error(`${method} ${apiPath} -> ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMIT_MESSAGE = [
  'Initial commit: HwMonitor 硬件监控网页服务',
  '',
  'Windows 本地硬件监控网页服务，零第三方依赖（只需 Node.js）：',
  '',
  '- 实时监控：电池剩余容量/健康度/循环次数、充电与放电功率、CPU、内存、',
  '  GPU、磁盘容量与吞吐、网络吞吐、进程列表',
  '- DSH 用量统计：只读解析 ~/.dsh/sessions 日志，统计 token 与估算费用',
  '- 网页 PowerShell 终端与远程 SSH 终端',
  '- 服务一键启停（HwMonitor / DSH / frp 穿透）',
  '- 局域网访问地址自动识别（区分真实网卡与虚拟网卡）',
  '',
  '设计要点：',
  '- 采样器为常驻进程，避免反复创建性能计数器（本机实测 8.4s -> 数 ms）',
  '- 服务状态后台预热缓存，接口响应从 8s 降到 1ms',
  '- 不编造数据：无传感器的项目显示“不支持”，未定价的模型费用显示为 0',
  '- 自我保护：不会停止承载当前会话的进程',
].join('\n');

(async () => {
  const files = collect(ROOT);
  console.log(`files to upload: ${files.length}`);
  console.log(`branch: ${BRANCH}\n`);

  let done = 0;
  for (const f of files) {
    const content = fs.readFileSync(f.full);

    // A PUT to /contents/<path> creates or updates the file. On an empty
    // repository the first PUT also creates the initial commit and the branch.
    const body = {
      message: done === 0 ? COMMIT_MESSAGE : `Add ${f.rel}`,
      content: content.toString('base64'),
      branch: BRANCH,
    };

    let attempt = 0;
    for (;;) {
      try {
        await gh('PUT', `/repos/${OWNER}/${REPO}/contents/${encodeURI(f.rel)}`, body);
        break;
      } catch (e) {
        // 409 means the file already exists (this path needs its current sha).
        // 422 can occur on a concurrent update. Both are retried once after
        // fetching the existing sha.
        if ((e.status === 409 || e.status === 422) && attempt === 0) {
          attempt++;
          try {
            const existing = await gh('GET',
              `/repos/${OWNER}/${REPO}/contents/${encodeURI(f.rel)}?ref=${BRANCH}`);
            if (existing && existing.sha) body.sha = existing.sha;
          } catch {}
          continue;
        }
        throw e;
      }
    }

    done++;
    console.log(`  [${String(done).padStart(2)}/${files.length}] ${f.rel} (${content.length} bytes)`);
    // A small delay keeps well inside the secondary rate limit for content writes.
    await sleep(250);
  }

  console.log(`\nuploaded ${done} files`);
  console.log(`https://github.com/${OWNER}/${REPO}`);
})().catch((e) => {
  console.error(`\nFAILED after partial upload: ${e.message}`);
  console.error('Re-run the script: already-uploaded files are updated in place.');
  process.exit(1);
});
