import { parseSrt, serializeSrt, secondsToSrtTime, srtTimeToSeconds } from '../src/lib/srt';
import { validateEdge, applyEdge, initHistory, commitHistory, undoHistory, redoHistory } from '../src/lib/cues';

let fail = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.error('❌', msg);
  } else {
    console.log('✅', msg);
  }
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

process.exit(fail ? 1 : 0);
