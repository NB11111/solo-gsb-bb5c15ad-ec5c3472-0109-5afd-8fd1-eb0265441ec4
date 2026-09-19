import { parseSrt, serializeSrt, secondsToSrtTime, srtTimeToSeconds } from '../src/lib/srt';
import { validateEdge, applyEdge, initHistory, commitHistory, undoHistory, redoHistory } from '../src/lib/cues';
import { detectSilence, snapToSilenceEdge, windowedMaxRms } from '../src/lib/silence';
import type { SilenceSegment } from '../src/types';

let fail = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.error('❌', msg);
  } else {
    console.log('✅', msg);
  }
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function segEq(actual: SilenceSegment[], expected: [number, number][]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((s, i) => approx(s.start, expected[i][0]) && approx(s.end, expected[i][1]))
  );
}

// 1. 时间格式往返
assert(secondsToSrtTime(0) === '00:00:00,000', '0 序列化');
assert(secondsToSrtTime(3661.5) === '01:01:01,500', '3661.5 序列化');
assert(srtTimeToSeconds('00:00:01,500') === 1.5, '逗号毫秒解析');
assert(srtTimeToSeconds('00:00:01.5') === 1.5, '点毫秒解析（容错）');

// 2. 解析含 BOM / CRLF / 缺序号的 SRT
const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,000\r\n你好\r\n\r\n' +
  '00:00:04.000 --> 00:00:06,500\r\n第二行\r\n第二行续\r\n\r\n' +
  'bad block\r\n\r\n' +
  '3\r\n00:00:10,000 --> 00:00:09,000\r\n逆序应跳过\r\n';
const { cues, warnings } = parseSrt(srt);
assert(cues.length === 2, `解析出 2 条（实际 ${cues.length}）`);
assert(warnings.length === 2, `产生 2 条告警（实际 ${warnings.length}）`);
assert(cues[0].text === '你好', '第一条文本');
assert(cues[1].start === 4 && cues[1].end === 6.5, '点分隔第二块');

// 3. 导出保持时间顺序且重新连续编号
cues[0].start = 100; // 打乱顺序后导出
const out = serializeSrt(cues);
const nums = [...out.matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]));
assert(JSON.stringify(nums) === '[1,2]', `导出编号连续 1,2（实际 ${JSON.stringify(nums)}）`);
assert(out.startsWith('1\n00:00:04,000'), '导出按时间升序，最早者编号 1');

// 4. 约束校验
const C = { minDuration: 0.5, minGap: 0.1 };
let r = validateEdge(cues, cues[0].id, 'start', -1, C);
assert(!r.ok && r.message.includes('00:00'), '左边界越过 0 被拒绝');
const base = [
  { id: 'a', start: 1, end: 2, text: 'a' },
  { id: 'b', start: 3, end: 4, text: 'b' }
];
r = validateEdge(base, 'a', 'end', 2.95, C);
assert(!r.ok && r.message.includes('间隔'), `间隔 0.05 < 0.1 被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 3.2, C);
assert(!r.ok && r.message.includes('重叠'), `重叠被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 1.4, C);
assert(!r.ok && r.message.includes('短于最短时长'), '时长不足被拒绝');
r = validateEdge(base, 'a', 'end', 2.9, C);
assert(r.ok, '间隔恰好 0.1 合法');
r = validateEdge(base, 'b', 'start', 2.1, C);
assert(r.ok, '右块左边界贴到 2.1 合法');
r = validateEdge(base, 'b', 'start', 2.05, C);
assert(!r.ok, '右块左边界间隔不足被拒绝');

// 5. 应用变更 & 撤销重做
let h = initHistory(base);
const next = applyEdge(base, 'a', 'end', 2.5);
h = commitHistory(h, next);
assert(h.present[0].end === 2.5 && h.past.length === 1, '提交边界调整');
h = undoHistory(h);
assert(h.present[0].end === 2 && h.future.length === 1, '撤销恢复');
h = redoHistory(h);
assert(h.present[0].end === 2.5, '重做再次应用');
h = commitHistory(h, applyEdge(h.present, 'a', 'end', 2.8));
assert(h.future.length === 0, '新提交清空 redo 栈');

// 6. 窗口 RMS：每窗口取各声道 RMS 的最大值
{
  // 采样率 1000Hz、窗口 20ms -> 每窗口 20 样本
  const chA = new Float32Array(60);
  const chB = new Float32Array(60);
  chA.fill(0.5, 0, 20);   // 窗口0：A 声道 0.5
  chB.fill(0.2, 0, 20);   // 窗口0：B 声道 0.2 -> max 0.5
  chB.fill(0.05, 20, 40); // 窗口1：A=0，B=0.05 -> max 0.05
  chA.fill(0.1, 40, 60);  // 窗口2：A=0.1，B=0 -> max 0.1
  const rms = windowedMaxRms([chA, chB], 1000, 0.02);
  assert(rms.length === 3, `60 样本 / 20 样本窗口 = 3 窗口（实际 ${rms.length}）`);
  assert(approx(rms[0], 0.5), `窗口0 取声道最大值 0.5（实际 ${rms[0]}）`);
  assert(approx(rms[1], 0.05), `窗口1 取声道最大值 0.05（实际 ${rms[1]}）`);
  assert(approx(rms[2], 0.1), `窗口2 取声道最大值 0.1（实际 ${rms[2]}）`);

  // 末尾不足一窗口的剩余样本计入最后一个窗口
  const tail = new Float32Array(45);
  tail.fill(0.3, 40, 45);
  const rmsTail = windowedMaxRms([tail], 1000, 0.02);
  assert(rmsTail.length === 3 && approx(rmsTail[2], 0.3), '尾部不完整窗口计入且 RMS 正确');
}

// 7. 静音段检测：阈值 / 最短 200ms / <80ms 间隔先合并
{
  const W = 0.02;
  const OPTS = { threshold: 0.01, minSilence: 0.2, mergeGap: 0.08 };
  // 用 [电平, 窗口数] 描述构造 RMS 序列
  const build = (spec: [number, number][]) => {
    const arr: number[] = [];
    for (const [v, n] of spec) for (let i = 0; i < n; i++) arr.push(v);
    return arr;
  };

  // 连续 15 窗口（300ms）低于阈值 -> 一段 [0, 0.3]
  let segs = detectSilence(build([[0, 15]]), W, OPTS);
  assert(segEq(segs, [[0, 0.3]]), `300ms 连续静音成段（实际 ${JSON.stringify(segs)}）`);

  // 连续 5 窗口（100ms）< 200ms -> 丢弃
  segs = detectSilence(build([[0, 5]]), W, OPTS);
  assert(segs.length === 0, '100ms 静音不足 200ms 被丢弃');

  // 恰好 200ms（10 窗口，边界含浮点噪声）-> 保留
  segs = detectSilence(build([[1, 5], [0, 10]]), W, OPTS);
  assert(segEq(segs, [[0.1, 0.3]]), `恰好 200ms 静音保留（实际 ${JSON.stringify(segs)}）`);

  // 前导有声 5 窗口后 15 窗口静音 -> [0.1, 0.4]
  segs = detectSilence(build([[1, 5], [0, 15]]), W, OPTS);
  assert(segEq(segs, [[0.1, 0.4]]), `静音段起点对齐窗口边界 0.1s（实际 ${JSON.stringify(segs)}）`);

  // 两段 160ms 静音夹 60ms（<80ms）有声 -> 先合并成 380ms -> 保留
  segs = detectSilence(build([[0, 8], [1, 3], [0, 8]]), W, OPTS);
  assert(segEq(segs, [[0, 0.38]]), `间隔 60ms 的两段先合并（实际 ${JSON.stringify(segs)}）`);

  // 两段 160ms 静音夹 80ms（不足 80ms 才合并，恰好 80ms 不合并）-> 各 160ms 均不足 200ms -> 丢弃
  segs = detectSilence(build([[0, 8], [1, 4], [0, 8]]), W, OPTS);
  assert(segs.length === 0, '间隔恰好 80ms 不合并，两段各 160ms 均被丢弃');

  // 两段 240ms 静音夹 100ms -> 不合并，各自保留
  segs = detectSilence(build([[0, 12], [1, 5], [0, 12]]), W, OPTS);
  assert(segEq(segs, [[0, 0.24], [0.34, 0.58]]), `间隔 100ms 不合并，两段各自保留（实际 ${JSON.stringify(segs)}）`);

  // RMS 恰好等于阈值不算静音（严格低于）
  segs = detectSilence(build([[0.01, 15]]), W, OPTS);
  assert(segs.length === 0, 'RMS 等于阈值不视为静音');

  // 提高阈值后同一序列可检出
  segs = detectSilence(build([[0.01, 15]]), W, { ...OPTS, threshold: 0.02 });
  assert(segEq(segs, [[0, 0.3]]), '阈值上调后原边界电平被检出');
}

// 8. 静音边缘吸附：±150ms 最近边缘，等距取更早者
{
  const SEGS: SilenceSegment[] = [
    { start: 0.5, end: 1.0 },
    { start: 2.0, end: 2.3 }
  ];
  let s = snapToSilenceEdge(0.62, SEGS, 0.15);
  assert(s !== null && approx(s, 0.5), `0.62 吸附到段首 0.5（实际 ${s}）`);
  s = snapToSilenceEdge(0.9, SEGS, 0.15);
  assert(s !== null && approx(s, 1.0), `0.9 吸附到段尾 1.0（实际 ${s}）`);
  s = snapToSilenceEdge(2.42, SEGS, 0.15);
  assert(s !== null && approx(s, 2.3), `2.42 吸附到第二段段尾 2.3（实际 ${s}）`);
  s = snapToSilenceEdge(1.5, SEGS, 0.15);
  assert(s === null, '1.5 距所有边缘超过 150ms，不吸附');
  s = snapToSilenceEdge(0.65, SEGS, 0.15);
  assert(s !== null && approx(s, 0.5), '距离恰好 150ms 仍在吸附范围内');
  s = snapToSilenceEdge(0.651, SEGS, 0.15);
  assert(s === null, '距离超过 150ms 不吸附');
  s = snapToSilenceEdge(0.5, SEGS, 0.15);
  assert(s !== null && approx(s, 0.5), '已在边缘上时吸附到自身');

  // 等距取更早者：t 位于一段 200ms 静音正中
  s = snapToSilenceEdge(1.0, [{ start: 0.9, end: 1.1 }], 0.15);
  assert(s !== null && approx(s, 0.9), `等距时取更早边缘 0.9（实际 ${s}）`);
  // 等距取更早者：t 位于两段之间且到两段边缘等距
  s = snapToSilenceEdge(1.0, [{ start: 0.8, end: 0.9 }, { start: 1.1, end: 1.2 }], 0.15);
  assert(s !== null && approx(s, 0.9), `跨段等距时仍取更早边缘 0.9（实际 ${s}）`);

  assert(snapToSilenceEdge(1.0, [], 0.15) === null, '无静音段时不吸附');
}

process.exit(fail ? 1 : 0);
