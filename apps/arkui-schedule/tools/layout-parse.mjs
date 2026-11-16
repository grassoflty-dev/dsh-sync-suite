/**
 * `devecocli ui layout` 输出的解析器（纯函数，Node 可直接测，不依赖设备）。
 *
 * 真实输出里会混进进度行（`- Dumping layout…`）、ANSI 颜色、警告、空行，
 * PowerShell 管道还可能把 stderr 拼到 stdout 前面。因此这里做三件事：
 *   1. 去掉 ANSI 转义序列；
 *   2. 定位 JSON 数组：优先找**以 `[` 开头的行**，再从那里取到最后一个 `]`；
 *   3. 解析失败时抛带原文尾部的错误，便于定位。
 */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** 去掉 ANSI 颜色/控制序列。 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/**
 * 从可能混有噪声的输出里切出 JSON 数组文本。
 * @returns {string}
 */
export function extractJsonArray(raw) {
  const text = stripAnsi(raw);
  const lines = text.split(/\r?\n/);

  // 优先：某一行以 `[` 开头（devecocli 的 JSON 是格式化输出，数组独占首行）
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[')) {
      const candidate = [trimmed, ...lines.slice(i + 1)].join('\n');
      const end = candidate.lastIndexOf(']');
      if (end >= 0) {
        return candidate.slice(0, end + 1);
      }
    }
  }

  // 兜底：整段里第一个 `[` 到最后一个 `]`
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  throw new Error(`ui layout 输出里找不到 JSON 数组：${text.slice(-300)}`);
}

/**
 * 解析布局树，返回扁平节点列表。
 * @param {string} raw devecocli ui layout 的原始输出
 * @returns {Array<{ text: string, id: string, bounds: number[] }>}
 */
export function parseLayoutOutput(raw) {
  const json = extractJsonArray(raw);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`ui layout JSON 解析失败：${message}；原文尾部：${json.slice(-300)}`);
  }

  const flat = [];
  const walk = (node, isRoot) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, isRoot && index === 0));
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    // 根节点即使没有 text/id 也收集：它的 bounds 就是屏幕尺寸（screenSize 依赖它）
    if (isRoot || node.text !== undefined || node.id !== undefined) {
      const bounds = Array.isArray(node.bounds) ? node.bounds : [];
      flat.push({ text: node.text ?? '', id: node.id ?? '', bounds });
    }
    (node.children ?? []).forEach((child) => walk(child, false));
  };
  walk(parsed, true);

  if (flat.length === 0) {
    throw new Error('ui layout 解析成功但没有任何节点（页面可能未渲染）');
  }
  return flat;
}

/** 所有非空文本（便于断言）。 */
export function layoutTexts(flat) {
  return flat.map((node) => node.text).filter((text) => text.length > 0);
}

/** 某个文本节点（精确匹配）。 */
export function findByText(flat, text) {
  return flat.find((node) => node.text === text);
}

/** 节点中心点 `[x, y]`。 */
export function centerOf(node) {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

/** 屏幕尺寸（取所有节点 bounds 的最大右下角，避免根节点未被收集时取错）。 */
export function screenSize(flat) {
  let w = 0;
  let h = 0;
  for (const node of flat) {
    const b = node.bounds;
    if (Array.isArray(b) && b.length === 4) {
      if (b[2] > w) w = b[2];
      if (b[3] > h) h = b[3];
    }
  }
  if (w === 0 || h === 0) {
    return { w: 1600, h: 2560 };
  }
  return { w, h };
}
