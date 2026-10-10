'use strict';

/* ===================== 配置 ===================== */
const PRESETS = {
  review: {
    label: '文献综述作业',
    weights: { topic: 12, literature: 22, method: 8, argument: 22, innovation: 9, structure: 7, expression: 8, writing: 12 },
    names: {
      topic: '选题与问题意识', literature: '文献检索与梳理', method: '检索与综合方法',
      argument: '论证与逻辑', innovation: '创新与价值', structure: '结构完整性',
      expression: '语言表达与可读性', writing: '学术规范与著录'
    }
  },
  general: {
    label: '一般课程作业',
    weights: { topic: 12, literature: 14, method: 16, argument: 22, innovation: 9, structure: 7, expression: 8, writing: 12 },
    names: {
      topic: '选题与问题意识', literature: '文献掌握与运用', method: '研究方法',
      argument: '论证与逻辑', innovation: '创新与价值', structure: '结构完整性',
      expression: '语言表达与可读性', writing: '学术规范与著录'
    }
  }
};
const DIM_KEYS = ['topic', 'literature', 'method', 'argument', 'innovation', 'structure', 'expression', 'writing'];

const RECENT_YEAR = 2020; // 文献“近年期”阈值：参考文献中 >= 该年份视为近期文献
// AI 痕迹——弱信号：常见于正常中文学术写作，仅作弱参考，密度需偏高才计分
const WEAK_AI_PHRASES = [
  '值得注意的是', '综上所述', '总而言之', '近年来，', '本文从', '本文以', '进行了分析',
  '具有重要的', '提供了参考', '为后续', '不难看出', '由此可见', '需要指出的是'
];
// AI 痕迹——强信号：更接近机器生成的套路表达，权重更高
const STRONG_AI_PHRASES = [
  '在当今社会', '随着社会', '随着经济', '随着时代', '随着科技', '随着人工智能',
  '不可否认', '毋庸置疑', '发挥着至关重要', '已经成为研究热点', '日益受到关注',
  '取得了显著的成果', '具有重要的意义', '应运而生', '多角度', '全方位', '不仅……而且',
  '首先，其次', '在当今世界', '在这个背景下', '为……提供了有力支撑'
];
const CONNECTORS = [
  '因此', '所以', '然而', '但是', '并且', '而且', '同时', '此外', '另外', '例如', '比如', '由于',
  '因为', '如果', '虽然', '尽管', '因而', '故而', '换句话说', '换言之', '与此同时', '在此基础上'
];

/* ===================== 工具 ===================== */
const $ = (id) => document.getElementById(id);
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function countCJK(s) { return (s.match(/[一-鿿]/g) || []).length; }

function splitSentences(text) {
  return text.split(/[。！？!?；;\n\r]+/).map(s => s.trim()).filter(s => s.length > 1);
}

/* ===================== 文献提取与核验 ===================== */
function extractDOIs(text) {
  const found = new Set();
  const re = /\b10\.\d{4,9}\/[^\s,"'<>\]）)}\u4e00-\u9fff]+/gi;
  let m;
  while ((m = re.exec(text))) {
    let d = m[0].replace(/[.,;:)\]]+$/, '');
    found.add(d);
  }
  return [...found];
}
function extractPMIDs(text) {
  const found = new Set();
  const re = /(?:PMID|pmid)\s*[:#]?\s*(\d{4,8})/gi;
  let m;
  while ((m = re.exec(text))) found.add(m[1]);
  // 也尝试 "pubmed:" 形式
  const re2 = /pubmed\s*[:#]?\s*(\d{5,8})/gi;
  while ((m = re2.exec(text))) found.add(m[1]);
  return [...found];
}
// 仅在“参考文献”区段内统计，避免正文提及年份被误算为参考文献条目
function analyzeReferences(text) {
  const headingMatch = text.match(/参考\s*文献|references?|bibliography|文献引用/gi);
  const hasHeading = !!headingMatch;
  const section = hasHeading ? text.slice(text.lastIndexOf(headingMatch[headingMatch.length - 1])) : text;
  const lines = section.split(/\n+/);
  let entries = 0, recent = 0;
  for (const ln of lines) {
    const hasYear = /(?:19|20)\d{2}/.test(ln);
    const hasId = /\b(?:doi|PMID|pubmed)\b/i.test(ln) || /\[?\d+\]?[\.、]/.test(ln);
    // 有“参考文献”标题：标题之后的年份行基本是真实文献，可放宽；
    // 无标题（退化到全文）：为避免正文年份被误算，仅认 DOI/PMID/编号条目。
    const looksCited = hasHeading
      ? (hasYear || hasId || /[A-Za-z][A-Za-z\s.]+[.，,]/.test(ln))
      : (hasId || /\[?\d+\]?[\.、]/.test(ln));
    if (ln.trim().length > 8 && looksCited) {
      entries++;
      if (hasYear) {
        const y = parseInt(ln.match(/(?:19|20)\d{2}/)[0], 10);
        if (y >= RECENT_YEAR) recent++;
      }
    }
  }
  // 与 DOI/PMID 实抽数取大，互为校验，避免漏计纯编号条目
  const ids = extractDOIs(text).length + extractPMIDs(text).length;
  entries = Math.max(entries, ids);
  recent = Math.min(recent, entries);
  return { count: entries, recent, ratio: entries ? recent / entries : 0 };
}

async function verifyDOI(doi) {
  try {
    const r = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi), { method: 'GET' });
    if (r.status === 200) {
      const j = await r.json();
      const t = j?.message?.title?.[0] || '';
      return { ok: true, title: t };
    }
    if (r.status === 404) return { ok: false, title: '' };
    return { ok: false, title: '' };
  } catch (e) {
    return { ok: null, title: '' };
  }
}
async function verifyPMID(pmid) {
  try {
    const url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=' + encodeURIComponent(pmid) + '%5Buid%5D';
    const r = await fetch(url);
    if (!r.ok) return { ok: null, title: '' };
    const j = await r.json();
    const ids = j?.esearchresult?.idlist || [];
    return { ok: ids.includes(pmid), title: '' };
  } catch (e) {
    return { ok: null, title: '' };
  }
}

/* ===================== AI 痕迹（规则层，重新校准以降低误报） ===================== */
function aiSmell(text) {
  const sents = splitSentences(text);
  const n = sents.length || 1;
  let weak = 0, strong = 0, con = 0;
  const lens = [];
  for (const s of sents) {
    for (const p of WEAK_AI_PHRASES) if (s.includes(p)) weak++;
    for (const p of STRONG_AI_PHRASES) if (s.includes(p)) strong++;
    for (const c of CONNECTORS) if (s.includes(c)) con++;
    lens.push(countCJK(s));
  }
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;

  const weakD = weak / n, strongD = strong / n, conD = con / n;

  let score = 0;
  score += Math.min(25, strongD * 180);                    // 强信号：高度疑似 AI 套话
  score += Math.min(15, Math.max(0, weakD - 0.15) * 120);  // 弱信号仅在密度明显偏高时才计分
  if (cv < 0.30) score += (0.30 - cv) * 80;                // 句长极其均匀
  else if (cv < 0.42) score += (0.42 - cv) * 30;           // 句长略均匀（弱）
  if (conD > 0.65) score += Math.min(15, (conD - 0.65) * 40);
  score = clamp(Math.round(score), 0, 100);

  let level = '低', label = 'ok';
  if (score >= 60) { level = '高'; label = 'bad'; }
  else if (score >= 30) { level = '中'; label = 'warn'; }

  const reasons = [];
  if (strongD > 0.05) reasons.push('出现较多 AI 典型套话（' + (strongD * 100).toFixed(0) + '% 句子含强 AI 特征表达）');
  if (weakD > 0.15) reasons.push('模板化套话密度偏高（' + (weakD * 100).toFixed(0) + '% 句子含常见套话）');
  if (cv < 0.30) reasons.push('句长波动极小（变异系数 ' + cv.toFixed(2) + '），偏机械匀速，疑似 AI 生成');
  else if (cv < 0.42) reasons.push('句长波动偏小（变异系数 ' + cv.toFixed(2) + '）');
  if (conD > 0.65) reasons.push('逻辑连接词过密（' + (conD * 100).toFixed(0) + '%）');
  if (reasons.length === 0) reasons.push('句长有起伏、套话与连接词密度正常，未见明显 AI 生成特征');

  return { score, level, label, reasons, weakD, strongD, conD, cv };
}

/* ===================== 六维规则评分（重新校准，提升区分度） ===================== */
function scoreTopic(text, words) {
  let s = 60;
  if (/[？?]/.test(text)) s += 6;                                  // 提出明确研究问题
  if (/(研究目的|目的|拟|旨在|探讨|分析)/.test(text)) s += 6;
  if (/(背景|现状|意义|缺口|gap|不足)/i.test(text)) s += 4;
  if (words > 2000) s += 6; else if (words < 800) s -= 10;        // 篇幅过短扣分
  return clamp(s, 30, 92);
}
function scoreLiterature(text, refCount, recentCount) {
  let s;
  if (refCount >= 20) s = 92;
  else if (refCount >= 15) s = 88;
  else if (refCount >= 10) s = 82;
  else if (refCount >= 6) s = 74;
  else if (refCount >= 3) s = 64;
  else if (refCount >= 1) s = 52;
  else s = 35;
  const ratio = refCount > 0 ? recentCount / refCount : 0;
  s += Math.round((ratio - 0.4) * 20);                            // 近期文献占比 >40% 加分，<40% 扣分
  if (/(参考文献|引文|引用)/.test(text)) s += 2;
  return clamp(s, 30, 96);
}
function scoreMethod(text) {
  // 按“方法信号类别”计分，避免同根词重复计分，且需要真实覆盖多个环节
  const cats = {
    search: /检索|文献检索/,
    db: /数据库|pubmed|cnki|embase|web of science|万方|维普|scopus/i,
    strategy: /策略|检索式/,
    inclusion: /纳入|排除/,
    mesh: /主题词|mesh|自由词/i,
    pico: /pico|研究问题|研究设计|研究类型/i,
    screening: /筛选|去重|质量评价|偏倚|循证|综述方法/
  };
  let hits = 0;
  for (const re of Object.values(cats)) if (re.test(text)) hits++;
  return clamp(50 + hits * 6, 30, 92);                            // 7 类方法信号，每类 6 分
}
function scoreArgument(text) {
  let s = 60;
  const paras = text.split(/\n\s*\n/).filter(p => p.trim().length > 20).length;
  if (paras >= 6) s += 8; else if (paras >= 3) s += 4;
  if (/(讨论|结论|小结|综上)/.test(text)) s += 8;
  if (/(不足|局限|展望|启示|未来|待解|缺口)/.test(text)) s += 6; else s -= 4;
  const conD = CONNECTORS.filter(c => text.includes(c)).length / Math.max(1, splitSentences(text).length);
  if (conD > 0.6) s += 4;
  return clamp(s, 30, 92);
}
function scoreInnovation(text) {
  const kws = ['创新', '贡献', '独特', '不足', '展望', '局限', '启示', '价值', 'gap', '研究空白', '切入点'];
  let hits = kws.filter(k => text.includes(k)).length;
  return clamp(50 + hits * 6, 30, 90);
}
function scoreWriting(text, ai, refCount) {
  let s = 70;
  if (/(参考文献|引文|references)/i.test(text)) s += 4;
  if (/(一、|1\.|1、|第一章|摘要|关键词|doi|pmid)/i.test(text)) s += 4;
  if (ai.score >= 60) s -= 14; else if (ai.score >= 35) s -= 5;
  if (refCount === 0) s -= 6;
  return clamp(s, 30, 92);
}
function scoreStructure(text) {
  const blocks = [
    { re: /摘要|abstract/i, name: '摘要' },
    { re: /引言|背景|目的|研究目的|问题提出|绪论/i, name: '引言/背景' },
    { re: /方法|检索|资料来源|检索策略/i, name: '方法/检索说明' },
    { re: /结果|发现|现状|进展|综述/i, name: '结果/文献归纳' },
    { re: /讨论/i, name: '讨论' },
    { re: /结论|小结|展望/i, name: '结论/展望' },
    { re: /参考\s*文献|references?/i, name: '参考文献' }
  ];
  let present = 0;
  for (const b of blocks) if (b.re.test(text)) present++;
  const headings = (text.match(/^\s*(?:[一二三四五六七八九十]+、|\d+[\.、]|第[一二三四]章)/gm) || []).length;
  let s = 40 + present * 7;                       // 7 个核心板块，每块 7 分
  if (headings >= 4) s += 4; else if (headings >= 2) s += 2;
  return clamp(s, 30, 92);
}
function scoreExpression(text) {
  const sents = splitSentences(text);
  const n = sents.length || 1;
  const lens = sents.map(countCJK);
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const longRatio = lens.filter(l => l > 90).length / n;     // 过长句比例（易读性差）
  const tooShort = lens.filter(l => l < 6).length / n;       // 碎句比例
  const phrases = {};
  for (const s of sents) {
    for (const m of s.match(/[一-鿿]{4,}/g) || []) phrases[m] = (phrases[m] || 0) + 1;
  }
  const repeated = Object.values(phrases).filter(c => c >= 3).length;  // 高频重复短语（疑似堆砌）
  let s = 72;
  if (longRatio > 0.25) s -= 10; else if (longRatio > 0.12) s -= 4;
  if (tooShort > 0.20) s -= 6;
  if (repeated > 0) s -= Math.min(10, repeated * 3);
  if (mean >= 25 && mean <= 55) s += 6;          // 句长落在合理区间
  return clamp(s, 30, 92);
}

/* ===================== 可选：LLM 研判（AI 痕迹 + 导师级评语，一次调用） ===================== */
async function llmAnalyze(text, model, base, key, ctx) {
  const sys = '你是资深本科文献综述课程导师兼 AI 使用痕迹审查员。仅输出 JSON（不要任何额外文字）：'
    + '{"ai_dependency":0到100的整数,"level":"低/中/高","ai_reasons":["AI痕迹要点1","要点2"],'
    + '"summary":"总体评语2-3句，点明整体水平与最需改进的1-2点",'
    + '"strengths":["优点1","优点2"],"weaknesses":["不足1","不足2"],'
    + '"suggestions":["可操作改进建议1","建议2","建议3"]}。'
    + '评判依据：套话密度、论证深度、文献质量与时效、结构完整、批判性思维、学术规范。'
    + '建议必须具体可落地（如补哪类文献、增哪类段落、如何深化讨论），不要泛泛而谈。';
  const user = '【评分上下文】\n' + (ctx.dimText || '') + '\nAI 痕迹指数(规则): ' + (ctx.aiScore || 0)
    + '\n参考文献约 ' + (ctx.refCount || 0) + ' 条，全文约 ' + (ctx.words || 0) + ' 字。\n\n【学生作业正文】\n' + text.slice(0, 7000);
  const body = {
    model, stream: false,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_object' }
  };
  const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('LLM 接口返回 ' + r.status);
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM 未返回 JSON');
  return JSON.parse(m[0]);
}

/* ===================== 主流程 ===================== */
async function run() {
  const status = $('status');
  status.textContent = '正在读取作业…';
  $('run').disabled = true;

  let text = '';
  const file = $('file').files[0];
  const pasted = $('paste').value.trim();
  try {
    if (file) text = await readFile(file);
    else if (pasted) text = pasted;
    else { alert('请先上传文件或粘贴作业正文'); return; }
  } catch (e) {
    alert('读取失败：' + e.message);
    return;
  }
  if (countCJK(text) < 50) { alert('正文过短，无法评分。'); return; }

  const presetKey = $('jobType').value;
  const preset = PRESETS[presetKey];
  const words = countCJK(text);

  $('out').classList.remove('hidden');
  $('status').textContent = '正在核验文献与评分…';

  // 文献
  const dois = extractDOIs(text);
  const pmids = extractPMIDs(text);
  const refInfo = analyzeReferences(text);
  const refCount = refInfo.count;
  const recentCount = refInfo.recent;

  const citeRows = [];
  let forged = 0, verified = 0, unverified = 0;
  const jobs = [];
  for (const d of dois) jobs.push((async () => {
    const r = await verifyDOI(d);
    if (r.ok === true) { verified++; citeRows.push({ type: 'DOI', id: d, status: 'ok', title: r.title }); }
    else if (r.ok === false) { forged++; citeRows.push({ type: 'DOI', id: d, status: 'bad', title: '' }); }
    else { unverified++; citeRows.push({ type: 'DOI', id: d, status: 'un', title: '' }); }
  })());
  for (const p of pmids) jobs.push((async () => {
    const r = await verifyPMID(p);
    if (r.ok === true) { verified++; citeRows.push({ type: 'PMID', id: p, status: 'ok', title: '' }); }
    else if (r.ok === false) { forged++; citeRows.push({ type: 'PMID', id: p, status: 'bad', title: '' }); }
    else { unverified++; citeRows.push({ type: 'PMID', id: p, status: 'un', title: '' }); }
  })());
  await Promise.all(jobs);

  // AI 痕迹（规则层，先算，供写作维度与后续使用）
  const ai = aiSmell(text);

  // 各维度（含新增结构/表达）
  const dimScores = {
    topic: scoreTopic(text, words),
    literature: scoreLiterature(text, refCount, recentCount),
    method: scoreMethod(text),
    argument: scoreArgument(text),
    innovation: scoreInnovation(text),
    structure: scoreStructure(text),
    expression: scoreExpression(text),
    writing: scoreWriting(text, ai, refCount)
  };
  let total = 0;
  for (const k of DIM_KEYS) total += dimScores[k] * preset.weights[k];
  total = Math.round(total / 100);
  const redline = forged > 0;
  if (redline) total = Math.min(total, 49);

  // 可选：大模型研判（AI 痕迹 + 导师级评语，一次调用）
  let aiDetail = { ...ai };
  let llmReview = null;
  if ($('llmOn').value === 'on') {
    const key = $('llmKey').value.trim();
    const base = $('llmBase').value.trim();
    const model = $('llmModel').value.trim();
    if (key && base && model) {
      try {
        status.textContent = '大模型研判中（AI 痕迹 + 导师评语）…';
        const dimsText = DIM_KEYS.map(k => preset.names[k] + '：' + dimScores[k] + ' 分').join('；');
        const lr = await llmAnalyze(text, model, base, key, { dimText: dimsText, aiScore: ai.score, refCount, words });
        const ad = (typeof lr.ai_dependency === 'number') ? clamp(lr.ai_dependency, 0, 100) : ai.score;
        aiDetail = {
          score: ad,
          level: lr.level || ai.level,
          label: (ad >= 60 ? 'bad' : ad >= 30 ? 'warn' : 'ok'),
          reasons: (lr.ai_reasons && lr.ai_reasons.length) ? lr.ai_reasons : ai.reasons,
          strict: true
        };
        llmReview = lr;
      } catch (e) {
        aiDetail.note = '（大模型研判失败，已退回规则版：' + e.message + '）';
      }
    }
  }

  render(preset, dimScores, total, redline, aiDetail, citeRows, forged, verified, unverified, refCount, words, llmReview, text);
  $('status').textContent = '完成。';
  $('run').disabled = false;
}

function render(preset, dimScores, total, redline, ai, citeRows, forged, verified, unverified, refCount, words, llmReview, text) {
  $('total').textContent = total;
  $('total').style.color = total >= 85 ? 'var(--ok)' : total >= 60 ? 'var(--brand)' : total >= 49 ? 'var(--warn)' : 'var(--bad)';

  const rl = $('redline');
  if (redline) rl.innerHTML = '<span class="badge bad">文献真实性存疑 · 一票否决</span>';
  else if (forged === 0 && (verified > 0 || citeRows.length === 0)) rl.innerHTML = '<span class="badge ok">文献核验通过</span>';
  else rl.innerHTML = '';

  // 维度
  let dh = '';
  for (const k of DIM_KEYS) {
    const v = dimScores[k];
    const color = v >= 80 ? 'var(--ok)' : v >= 60 ? 'var(--brand)' : v >= 45 ? 'var(--warn)' : 'var(--bad)';
    dh += '<div class="dim"><div class="name">' + preset.names[k] + ' <span class="muted">(' + preset.weights[k] + '%)</span></div>'
      + '<div class="bar"><i style="width:' + v + '%;background:' + color + '"></i></div>'
      + '<div class="val">' + v + ' 分</div></div>';
  }
  $('dims').innerHTML = dh;

  // AI 报告
  let ah = '<div class="row" style="justify-content:space-between;align-items:center">'
    + '<div><span class="muted">AI 使用痕迹指数</span> &nbsp; <b style="font-size:22px">' + ai.score + '</b> / 100'
    + ' &nbsp; <span class="badge ' + ai.label + '">' + ai.level + (ai.strict ? ' · 大模型研判' : ' · 规则初判') + '</span></div></div>';
  ah += '<ul style="margin-top:8px">';
  for (const r of ai.reasons) ah += '<li>' + escapeHtml(r) + '</li>';
  if (ai.note) ah += '<li class="muted">' + escapeHtml(ai.note) + '</li>';
  ah += '</ul>';
  if (ai.score >= 60) ah += '<div class="hint">建议：与学生面谈，要求口头复述核心论证；或让其现场改写一段，确认是否为本人独立完成。</div>';
  $('aiReport').innerHTML = ah;

  // 文献报告
  let ch = '';
  if (citeRows.length === 0) {
    ch = '<div class="hint">未在文中识别到 DOI / PMID 编号，无法自动核验。若作业含参考文献，请确认其带有 doi 或 PMID 字段；或单独用「文献核验」功能粘贴参考文献列表。</div>';
  } else {
    ch += '<div class="hint">共识别 ' + citeRows.length + ' 个编号：核验存在 ' + verified + ' · 疑似伪造/不存在 ' + forged + ' · 无法核验(跨域/网络) ' + unverified + '。</div>';
    ch += '<table class="refs"><tr><th>类型</th><th>编号</th><th>结果</th><th>题名</th></tr>';
    for (const c of citeRows) {
      const tag = c.status === 'ok' ? '<span class="tag ok">真实</span>' : c.status === 'bad' ? '<span class="tag bad">疑似伪造</span>' : '<span class="tag un">无法核验</span>';
      ch += '<tr><td>' + c.type + '</td><td class="kbd">' + escapeHtml(c.id) + '</td><td>' + tag + '</td><td class="muted">' + escapeHtml(c.title || '—') + '</td></tr>';
    }
    ch += '</table>';
    if (forged > 0) ch += '<div class="note" style="margin-top:10px">检出 ' + forged + ' 个编号在官方数据库查无记录，判定为疑似伪造文献——按「一票否决」处理，综合得分封顶 49。</div>';
  }
  $('citeReport').innerHTML = ch;

  // 评语
  let rep = '<p class="muted">综合得分 <b>' + total + '</b> 分（' + preset.label + '），全文约 ' + words + ' 字，识别参考文献约 ' + refCount + ' 条。</p>';

  // 大模型导师级评语（开启 LLM 且有返回时优先展示）
  const hasLlm = llmReview && (llmReview.summary || (llmReview.suggestions && llmReview.suggestions.length));
  if (hasLlm) {
    rep += '<h3>导师级评语（大模型生成）</h3>';
    if (llmReview.summary) rep += '<p>' + escapeHtml(llmReview.summary) + '</p>';
    if (llmReview.strengths && llmReview.strengths.length) {
      rep += '<p class="muted" style="margin:8px 0 2px">👍 优点</p><ul>';
      for (const s of llmReview.strengths) rep += '<li>' + escapeHtml(s) + '</li>';
      rep += '</ul>';
    }
    if (llmReview.weaknesses && llmReview.weaknesses.length) {
      rep += '<p class="muted" style="margin:8px 0 2px">⚠️ 不足</p><ul>';
      for (const s of llmReview.weaknesses) rep += '<li>' + escapeHtml(s) + '</li>';
      rep += '</ul>';
    }
    if (llmReview.suggestions && llmReview.suggestions.length) {
      rep += '<p class="muted" style="margin:8px 0 2px">🛠️ 改进建议</p><ul>';
      for (const s of llmReview.suggestions) rep += '<li>' + escapeHtml(s) + '</li>';
      rep += '</ul>';
    }
  }

  // 规则自动核查（始终展示，按维度细项给出具体提示）
  const rr = buildRuleReport(text, dimScores, ai, refCount, words, preset);
  rep += '<h3>系统自动核查提示</h3>';
  if (redline) rep += '<p>该作业检出疑似伪造文献，已触发一票否决（综合得分封顶 49）。请核实并替换参考文献后重交。</p>';
  rep += '<p class="muted" style="margin:4px 0 2px">👍 亮点</p><ul>';
  if (rr.strengths.length) for (const s of rr.strengths) rep += '<li>' + escapeHtml(s) + '</li>';
  else rep += '<li>暂未发现突出亮点，按下方建议逐项改进即可。</li>';
  rep += '</ul>';
  rep += '<p class="muted" style="margin:4px 0 2px">🔧 待改进</p><ul>';
  if (rr.issues.length) for (const s of rr.issues) rep += '<li>' + escapeHtml(s) + '</li>';
  else rep += '<li>各维度表现均衡，无明显短板，可进一步追求深度与个性表达。</li>';
  rep += '</ul>';
  if (!hasLlm) rep += '<div class="hint">开启「AI 严格评分」可让大模型生成更详细、可落地的导师级评语与改进建议（消耗你自己的 Key）。</div>';
  $('report').innerHTML = rep;
}

/* 规则层「亮点 / 待改进」细项核查，产出比旧版更具体的提示 */
function buildRuleReport(text, dimScores, ai, refCount, words, preset) {
  const strengths = [], issues = [];

  // 选题
  if (/[？?]/.test(text) || /(研究目的|目的|拟|旨在|探讨|分析)/.test(text)) strengths.push('选题有明确的研究问题或目的指向。');
  else issues.push('未检出清晰的研究问题/目的，建议在开篇点明“本研究要解决什么”。');
  if (!/(背景|现状|意义|缺口|gap|不足)/i.test(text)) issues.push('缺少研究背景/意义/缺口的铺垫，综述的“为什么做”不够清晰。');

  // 文献
  if (refCount >= 15) strengths.push('参考文献数量较充足（约 ' + refCount + ' 条）。');
  else issues.push('参考文献偏少（约 ' + refCount + ' 条），建议补充至 15 篇以上，尤其近 3–5 年核心文献（目标占比 ≥40%）。');
  if (!/参考\s*文献|references?/i.test(text)) issues.push('未见“参考文献”标题，请确认文末参考文献列表完整著录。');
  if (refCount === 0) issues.push('未识别到参考文献条目，请检查是否带 doi/PMID 或规范的编号列表。');

  // 方法
  const catMap = {
    '检索来源说明': /检索|文献检索/,
    '具体数据库': /数据库|pubmed|cnki|embase|web of science|万方|维普|scopus/i,
    '检索策略/式': /策略|检索式/,
    '纳入与排除标准': /纳入|排除/,
    '主题词/自由词': /主题词|mesh|自由词/i,
    'PICO/研究设计': /pico|研究问题|研究设计|研究类型/i,
    '筛选/偏倚评价': /筛选|去重|质量评价|偏倚|循证/
  };
  const missing = [];
  for (const [name, re] of Object.entries(catMap)) if (!re.test(text)) missing.push(name);
  if (missing.length <= 2) strengths.push('综述方法学要素交代较完整。');
  else issues.push('检索与综合方法交代不足，建议补充：' + missing.join('、') + '。');

  // 论证
  if (/(讨论|结论|小结|综上)/.test(text)) strengths.push('含讨论/结论段落，论证有收束。');
  if (!/(不足|局限|展望|启示|未来|待解|缺口)/.test(text)) issues.push('缺少“不足/局限/展望”的批判性反思，建议增加一段自我批判与未来方向。');

  // 创新
  if (!/(创新|贡献|独特|gap|研究空白|切入点|价值)/i.test(text)) issues.push('未点明本综述的独特贡献或切入点，建议在结尾明确“新在何处”。');

  // 结构
  const blocks = ['摘要', '引言|背景|目的', '方法|检索', '结果|现状|进展', '讨论', '结论|展望', '参考文献'];
  const secCount = blocks.filter(p => new RegExp(p, 'i').test(text)).length;
  if (secCount >= 6) strengths.push('结构完整，主要板块齐全。');
  else issues.push('结构板块不全（仅检出 ' + secCount + '/7 个核心板块），建议按“摘要—引言—方法—结果—讨论—结论—参考文献”组织。');

  // 表达
  const sents = splitSentences(text);
  const longRatio = sents.length ? sents.filter(s => countCJK(s) > 90).length / sents.length : 0;
  if (longRatio > 0.25) issues.push('长句偏多（>90 字句占比 ' + (longRatio * 100).toFixed(0) + '%），建议拆分长句、提升可读性。');
  else if (longRatio <= 0.12 && sents.length) strengths.push('句式长短适中，可读性较好。');

  // AI 痕迹
  if (ai.score >= 60) issues.push('AI 使用痕迹指数偏高（' + ai.score + '），建议面谈/现场改写核实真实性。');
  else if (ai.score >= 30) issues.push('AI 使用痕迹指数中等（' + ai.score + '），注意保留个人表达、减少模板套话。');

  return { strengths, issues };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ===================== 文件读取 ===================== */
async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md')) return await file.text();
  if (name.endsWith('.docx')) {
    const buf = await file.arrayBuffer();
    const res = await mammoth.extractRawText({ arrayBuffer: buf });
    return res.value;
  }
  if (name.endsWith('.pdf')) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF 解析库未加载（需联网），请改用 .docx/.txt，或联网后重试');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      out += c.items.map(it => it.str).join(' ') + '\n';
    }
    return out;
  }
  throw new Error('不支持的文件类型：' + file.name);
}

/* ===================== 事件绑定 ===================== */
$('drop').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => { if ($('file').files[0]) $('paste').value = ''; });
$('drop').addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault(); $('drop').classList.remove('over');
  if (e.dataTransfer.files[0]) { $('file').files = e.dataTransfer.files; $('paste').value = ''; }
});
$('llmOn').addEventListener('change', () => {
  $('llmBox').classList.toggle('hidden', $('llmOn').value !== 'on');
});
$('run').addEventListener('click', run);
$('sample').addEventListener('click', () => {
  $('paste').value = SAMPLE;
  $('file').value = '';
  $('status').textContent = '已载入示例，点「开始评分」试算。';
});

const SAMPLE = `阿尔茨海默病（AD）的非药物干预研究进展

摘要：随着人口老龄化，阿尔茨海默病的疾病负担日益加重。本文综述了近五年非药物干预（运动、认知训练、音乐疗法）的循证进展，旨在为基层防控提供参考。

1 研究背景与目的
近年来，AD 患病率持续上升。本研究目的在于梳理非药物干预的疗效证据，并探讨其在社区场景中的可及性。

2 文献检索与梳理
通过检索 PubMed、CNKI 等数据库，纳入 2019—2024 年随机对照试验 18 篇。结果表明规律有氧运动可改善认知量表评分（MoCA 提升约 2.3 分，PMID: 31234567）。认知训练对轻中度患者亦有获益。

3 讨论
值得注意的是，现有研究样本量偏小、随访期短。一方面证据等级有限，另一方面社区落地仍受资源制约。未来需更多大样本长期研究。

4 不足与展望
本综述未做 Meta 整合，且纳入文献以英文为主。综上，非药物干预前景明确，但尚需高质量证据支撑。

参考文献：
[1] Smith J, et al. Aerobic exercise and cognition in AD. J Neurol. 2021. doi:10.1000/example.001
[2] Lee K, et al. Cognitive training RCT. Aging Ment Health. 2022. PMID: 31234567`;
