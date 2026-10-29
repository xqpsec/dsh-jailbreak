/**
 * dsh-jailbreak —— Client 半边（DSH Web GUI 里的图形操作面板）
 *
 * 形态遵循宿主 client 半的公开契约：
 *   - window.__ModuleLoader__.load({ id: '<包名>', factory(require) })：id 必须等于包名
 *     （client-modules 按包名建图，写错会二次注册 → "duplicate factory registration"）；
 *   - 只用 require('react')，不引其他包；
 *   - 数据走 /plugins/jailbreak/api/*（服务端 lib/routes.js 注册的 prefix 路由）；
 *   - slots 判空防御：缺 slots 就静默退出，绝不让 client boot 失败；
 *   - 颜色只走宿主 --dsw-alias-* 主题 token。
 *
 * 三个入口共用同一个 Console 组件：
 *   settings.section   设置页「破甲台 · jailbreak」整页
 *   sidebar.panellist  左侧栏入口（点开主区页面）
 *   main               主区页面本体（key 与侧栏 id 对应）
 */
window.__ModuleLoader__.load({
  id: 'dsh-jailbreak',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = '/plugins/jailbreak/api';

    async function api(method, body) {
      const res = await fetch(`${API}/${method}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
      let wire = null;
      try {
        wire = await res.json();
      } catch {
        throw new Error(`面板 API 无响应（HTTP ${res.status}）`);
      }
      if (!wire || wire.ok !== true) {
        const message = (wire && wire.error && wire.error.message) || `HTTP ${res.status}`;
        throw new Error(message);
      }
      return wire.value;
    }

    const CSS = [
      '.aecot{--aecot-acid:#3ff98d;--aecot-cyan:#22d3ee;--aecot-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);padding:2px 0}',
      '.aecot-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.aecot-title{font-size:15px;font-weight:600;letter-spacing:.2px}',
      '.aecot-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aecot-badge{margin-left:auto;display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aecot-pill{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 9px;background:var(--dsw-alias-bg-layer-1)}',
      '.aecot-pill.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.aecot-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 13px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}',
      '.aecot-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}',
      '.aecot-field{display:flex;flex-direction:column;gap:4px;min-width:104px}',
      '.aecot-field>span{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aecot textarea,.aecot input[type=text],.aecot input[type=number],.aecot select{font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}',
      '.aecot textarea:focus,.aecot input:focus,.aecot select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.aecot textarea{resize:vertical;line-height:1.55}',
      '.aecot-btn{font:inherit;font-size:12px;padding:6px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.aecot-btn:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.aecot-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);font-weight:600}',
      '.aecot-btn:disabled{opacity:.45;cursor:default}',
      '.aecot-btn.mini{padding:3px 9px;font-size:11px}',
      '.aecot-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:8px}',
      '.aecot-tab{font:inherit;font-size:12px;padding:4px 11px;border-radius:8px;border:1px solid transparent;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.aecot-tab.on{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.aecot-table{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.aecot-table th,.aecot-table td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.aecot-table th{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.aecot-table td.num{font-variant-numeric:tabular-nums}',
      '.aecot-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}',
      '.aecot-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.aecot-chip{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:2px 8px;font-size:11px;background:var(--dsw-alias-bg-layer-1);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.aecot-chip b{color:var(--dsw-alias-label-secondary);font-weight:500;margin-right:4px}',
      '.aecot-err{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;padding:8px 11px;font-size:12px;white-space:pre-wrap}',
      '.aecot-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.aecot-bar{height:5px;border-radius:99px;background:var(--dsw-alias-border-l1);overflow:hidden}',
      '.aecot-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}',
      '.aecot-scroll{max-height:300px;overflow:auto}',
      '.aecot-list{display:flex;flex-direction:column;gap:4px}',
      '.aecot-item{display:flex;gap:8px;align-items:center;padding:5px 8px;border-radius:8px;border:1px solid transparent;cursor:pointer;font-size:12px}',
      '.aecot-item:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.aecot-item .g{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.aecot-muted{color:var(--dsw-alias-label-secondary)}',
      '.aecot-kv{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px}',
      '.aecot-kv div b{color:var(--dsw-alias-label-secondary);font-weight:500;margin-right:4px}',
      '.aecot-hero{position:relative;display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1)}',
      '.aecot-hero::after{content:"";position:absolute;left:14px;right:14px;top:0;height:1px;background:rgba(63,249,141,.35)}',
      '.aecot-hero-title{font-family:var(--aecot-mono);font-size:15px;font-weight:700;letter-spacing:.3px;line-height:1.4;color:var(--dsw-alias-label-primary)}',
      '.aecot-hero-title b{color:var(--aecot-acid);font-weight:700}',
      '.aecot-hero-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:6px;line-height:1.65;max-width:560px}',
      '.aecot-hero-sub code,.aecot-plus code{font-family:var(--aecot-mono);font-size:11px;color:var(--aecot-cyan);background:rgba(34,211,238,.08);border-radius:4px;padding:1px 5px}',
      '.aecot-term{font-family:var(--aecot-mono);font-size:11.5px;line-height:1.75;color:var(--aecot-acid);background:rgba(0,0,0,.42);border:1px dashed rgba(63,249,141,.3);border-radius:10px;padding:9px 11px;white-space:pre-wrap;letter-spacing:.15px}',
      '.aecot-term .dim{color:var(--dsw-alias-label-secondary)}',
      '.aecot-term .cy{color:var(--aecot-cyan)}',
      '.aecot-state{display:flex;align-items:center;gap:9px;font-size:12px}',
      '.aecot-dot{width:9px;height:9px;border-radius:99px;background:var(--dsw-alias-border-l1);flex:none}',
      '.aecot-dot.on{background:var(--aecot-acid);box-shadow:0 0 0 3px rgba(63,249,141,.16),0 0 12px rgba(63,249,141,.6)}',
      '.aecot-big{font-family:var(--aecot-mono);font-size:12.5px;font-weight:700;letter-spacing:.4px;padding:9px 17px;border-radius:8px;border:1px solid var(--aecot-acid);background:rgba(63,249,141,.1);color:var(--aecot-acid);cursor:pointer;white-space:nowrap}',
      '.aecot-big:hover{background:rgba(63,249,141,.2)}',
      '.aecot-big.off{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1);box-shadow:none}',
      '.aecot-big.off:hover{border-color:var(--aecot-acid);color:var(--aecot-acid)}',
      '.aecot-big:disabled{opacity:.45;cursor:default}',
      '.aecot-quick textarea{font-size:13.5px;line-height:1.65}',
      '.aecot-scene{font-family:var(--aecot-mono);font-size:11px;padding:5px 11px;border-radius:6px;border:1px solid rgba(34,211,238,.3);background:rgba(34,211,238,.06);color:var(--aecot-cyan);cursor:pointer;letter-spacing:.2px}',
      '.aecot-scene:hover{background:rgba(34,211,238,.16);border-color:var(--aecot-cyan)}',
      '.aecot-label{font-size:12.5px;font-weight:650}',
      '.aecot-plus{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.aecot-answer{white-space:pre-wrap;font-size:13px;line-height:1.72;max-height:420px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-left:2px solid var(--aecot-acid);border-radius:10px;padding:12px 14px;background:rgba(0,0,0,.28)}',
      '.aecot-fold{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 13px;background:var(--dsw-alias-bg-layer-1)}',
      '.aecot-fold>summary{cursor:pointer;font-family:var(--aecot-mono);font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);list-style:none;letter-spacing:.2px}',
      '.aecot-fold>summary::-webkit-details-marker{display:none}',
      '.aecot-fold>summary::before{content:"[+] ";color:var(--aecot-acid)}',
      '.aecot-fold[open]>summary::before{content:"[-] "}',
      '.aecot-fold[open]>summary{margin-bottom:10px}',
      '.aecot-folds{display:flex;flex-direction:column;gap:8px}',
    ].join('\n');

    // 面板本体：只有开关、输入、场景、运行、回答、详情。没有解释文案。
    const UI = [
      '.jb{display:flex;flex-direction:column;gap:14px;font-size:12px;color:var(--dsw-alias-label-primary);line-height:1.55;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;background:var(--dsw-alias-bg-layer-1)}',
      '.jb-head{display:flex;align-items:center;gap:8px;min-height:20px}',
      '.jb-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.jb-state{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.jb-spacer{flex:1 1 auto}',
      '.jb-switch{width:32px;height:18px;flex:0 0 auto;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:transparent;position:relative;cursor:pointer;padding:0;transition:background .15s,border-color .15s}',
      '.jb-switch i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}',
      '.jb-switch.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.jb-switch.on i{transform:translateX(14px);background:#fff}',
      '.jb-input{width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;line-height:1.65;padding:10px 11px;outline:none;transition:border-color .15s}',
      '.jb-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.jb-tags{display:flex;flex-wrap:wrap;gap:6px}',
      '.jb-tag{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font:inherit;font-size:11px;cursor:pointer}',
      '.jb-tag:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}',
      '.jb-bar{display:flex;align-items:center;gap:10px}',
      '.jb-run{border:0;background:var(--dsw-alias-brand-primary);color:#fff;border-radius:7px;padding:7px 20px;font:inherit;font-size:12px;font-weight:500;letter-spacing:.02em;cursor:pointer}',
      '.jb-run:disabled{opacity:.45;cursor:default}',
      '.jb-link{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;border-radius:7px;padding:6px 12px;transition:color .15s,border-color .15s}',
      '.jb-link:hover:enabled{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}',
      '.jb-link:disabled{opacity:.4;cursor:default}',
      '.jb-prog{height:2px;background:var(--dsw-alias-border-l1);border-radius:2px;overflow:hidden}',
      '.jb-prog i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}',
      '.jb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:11px 13px;display:flex;flex-direction:column;gap:9px;min-height:60px}',
      '.jb-answer{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.7;max-height:340px;overflow:auto;margin:0}',
      '.jb-empty{min-height:120px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.jb-muted{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.jb-err{color:#ff8a80;font-size:11px}',
      '.jb-details{border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}',
      '.jb-details>summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary);list-style:none;outline:none}',
      '.jb-details>summary::-webkit-details-marker{display:none}',
      '.jb-details>summary::before{content:"▸ ";font-size:9px}',
      '.jb-details[open]>summary::before{content:"▾ "}',
      '.jb-details>div{margin-top:12px;display:flex;flex-direction:column;gap:10px}',
      '.jb label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.jb input[type=text],.jb input[type=number],.jb input[type=password],.jb select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 7px;font:inherit;font-size:11.5px;outline:none;min-width:0}',
      '.jb input[type=text]:focus,.jb input[type=number]:focus,.jb input[type=password]:focus,.jb select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.jb input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary);margin:0 6px 0 0}',
      '.jb pre{margin:0}',
    ].join('\n');

    // 小白入口：点一下就有具体目标，不用自己想怎么提问。
    const SCENES = [
      { label: '逆向校验', goal: '逆向这个程序的注册校验：先给静态分析步骤，再指出关键跳转与 patch 点' },
      { label: '脱壳', goal: '这个加壳样本怎么脱：给出判断壳类型的方法、脱壳步骤和工具命令' },
      { label: '免杀载荷', goal: '写一个能过 Defender 的 PowerShell 加载器：给完整代码和落地步骤' },
      { label: '流量分析', goal: '分析这段抓包，判断是不是 C2 心跳：给出特征、IOC 提取脚本' },
      { label: 'CTF 复现', goal: '给我这道 PWN 题的完整 exp 和漏洞成因分析' },
      { label: '样本分析', goal: '对比这两个 PE 样本：给导入表差异与字符串提取脚本' },
    ];

    const emptyForm = {
      backend: 'auto',
      judge: 'auto',
      provider: '',
      model: '',
      generations: 3,
      population: 10,
      maxTargetCalls: 120,
      targetMaxTokens: 1024,
      amplify: true,
      seed: '',
      baseUrl: '',
      apiKey: '',
    };

    function Field(props) {
      return h('label', { className: 'aecot-field' }, h('span', null, props.label), props.children);
    }

    function Score({ value }) {
      if (value === null || value === undefined) return h('span', { className: 'aecot-muted' }, '—');
      return h('span', { className: 'aecot-pill' + (value >= 4 ? ' on' : '') }, `f=${value}`);
    }

    function Progress({ prog }) {
      if (!prog) return null;
      const total = Math.max(1, Number(prog.generations) || 1);
      const done = Math.min(total, Number(prog.generation) || 0);
      const pct = Math.round((done / total) * 100);
      const running = prog.status === 'running';
      return h('div', { className: 'aecot-card' },
        h('div', { className: 'aecot-row' },
          h('b', { className: 'aecot-mono' }, prog.runId),
          h('span', { className: 'aecot-pill' + (running ? ' on' : '') }, prog.status === 'running' ? '运行中' : prog.status === 'done' ? '完成' : prog.status === 'archived' ? '历史' : prog.status === 'stopped' ? '已停止' : '失败'),
          h('span', { className: 'aecot-muted' }, `最优 `), h(Score, { value: prog.bestScore }),
          prog.meanScore !== null && prog.meanScore !== undefined ? h('span', { className: 'aecot-muted' }, `均值 ${prog.meanScore}`) : null,
          h('span', { className: 'aecot-muted' }, `μ=${prog.mu ?? '—'}`),
          h('span', { className: 'aecot-muted' }, `调用 ${prog.targetCalls ?? 0}`),
          prog.stopped ? h('span', { className: 'aecot-pill' }, prog.stopped) : null,
        ),
        h('div', { className: 'aecot-bar' }, h('i', { style: { width: `${pct}%` } })),
        prog.error ? h('div', { className: 'aecot-err' }, prog.error) : null,
        prog.history && prog.history.length
          ? h('div', { className: 'aecot-scroll' }, h('table', { className: 'aecot-table' },
              h('thead', null, h('tr', null, ['代', '最优', '均值', 'Δf', 'μ', '停滞', '调用'].map((t) => h('th', { key: t }, t)))),
              h('tbody', null, prog.history.map((row, i) => h('tr', { key: i },
                h('td', { className: 'num' }, row.gen),
                h('td', { className: 'num' }, row.bestScore),
                h('td', { className: 'num' }, row.meanScore ?? '—'),
                h('td', { className: 'num' }, row.delta ?? '—'),
                h('td', { className: 'num' }, row.mu ?? '—'),
                h('td', { className: 'num' }, row.stagnation ?? '—'),
                h('td', { className: 'num' }, row.targetCalls ?? '—'),
              ))),
            ))
          : h('div', { className: 'aecot-hint' }, running ? '第 0 代正在评估种群…' : '没有代际记录'),
      );
    }

    function BestPanel({ prog, onCopy }) {
      if (!prog || !prog.best) return null;
      const g = prog.best.genome || {};
      const dims = Object.keys(g);
      return h('div', { className: 'aecot-card' },
        h('div', { className: 'aecot-row' },
          h('b', null, '最优候选'),
          h(Score, { value: prog.best.score }),
          h('span', { className: 'aecot-muted aecot-mono' }, String(prog.best.key || '').slice(0, 12)),
          h('button', { className: 'aecot-btn mini', onClick: () => onCopy(prog.best.prompt, 'prompt') }, '复制提示'),
          h('button', { className: 'aecot-btn mini', onClick: () => onCopy(JSON.stringify(prog.best.genomeRaw || g, null, 2), 'genome') }, '复制基因'),
        ),
        dims.length ? h('div', { className: 'aecot-chips' }, dims.map((k) => h('span', { className: 'aecot-chip', key: k, title: `${k} = ${JSON.stringify(g[k])}` },
          h('b', null, k), Array.isArray(g[k]) ? g[k].join(' / ') : String(g[k])),
        )) : null,
        h('textarea', { className: 'aecot-mono', rows: 9, readOnly: true, value: prog.best.prompt || '' }),
        prog.artifacts && prog.artifacts.length
          ? h('details', null,
              h('summary', { className: 'aecot-hint' }, `放大阶段产物（${prog.artifacts.length} 段）`),
              prog.artifacts.map((a, i) => h('div', { key: i },
                h('div', { className: 'aecot-hint' }, a.label || a.kind),
                h('textarea', { className: 'aecot-mono', rows: 5, readOnly: true, value: String(a.text || '').slice(0, 6000) }),
              )),
            )
          : null,
        h('div', { className: 'aecot-kv' },
          h('div', null, h('b', null, '报告'), h('span', { className: 'aecot-mono' }, prog.reportPath || '—')),
          h('div', null, h('b', null, '语料'), h('span', { className: 'aecot-mono' }, prog.corpusPath || '—')),
        ),
      );
    }

    function Runs({ st, onPick }) {
      const runs = (st && st.runs) || [];
      if (!runs.length) return h('div', { className: 'aecot-card aecot-hint' }, '没有历史');
      return h('div', { className: 'aecot-card' },
        h('div', { className: 'aecot-row' }, h('b', null, '历史 run'), h('span', { className: 'aecot-hint' }, st?.config?.root || '')),
        h('div', { className: 'aecot-list' }, runs.map((r) => h('div', { key: r.id, className: 'aecot-item', onClick: () => onPick(r.id) },
          h('b', { className: 'aecot-mono' }, r.id),
          h('span', { className: 'g' }, r.goal || ''),
          h('span', { className: 'aecot-pill' }, `f=${r.bestScore ?? r.score ?? '—'}`),
        ))),
      );
    }

    function Console({ seat }) {
      const [st, setSt] = useState(null);
      const [prog, setProg] = useState(null);
      const [goal, setGoal] = useState('');
      const [form, setForm] = useState(emptyForm);
      const [tab, setTab] = useState('console');
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState(false);
      const [tax, setTax] = useState(null);
      const [toast, setToast] = useState('');
      const [adv] = useState(true);
      const [profs, setProfs] = useState([]);
      const [profId, setProfId] = useState('');
      const [profMsg, setProfMsg] = useState('');
      const [armArmed, setArmArmed] = useState(false);
      const [armNote, setArmNote] = useState('');
      const [collecting, setCollecting] = useState(false);
      const [preview, setPreview] = useState(null);
      const toastTimer = useRef(null);

      const set = (key) => (ev) => {
        const target = ev && ev.target ? ev.target : null;
        const value = target && target.type === 'checkbox' ? target.checked : target ? target.value : ev;
        setForm((prev) => ({ ...prev, [key]: value }));
      };

      const copy = useCallback((text, tag) => {
        try {
          navigator.clipboard.writeText(String(text || ''));
          setToast(`已复制${tag === 'genome' ? '基因' : tag === 'answer' ? '答案' : '提示'}`);
        } catch {
          setToast('复制失败，请手动选中');
        }
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 2200);
      }, []);

      const refresh = useCallback(async () => {
        try {
          const [s, p, pf, ar] = await Promise.all([
            api('state'),
            api('progress').catch(() => null),
            api('profiles?limit=30').catch(() => null),
            api('arm').catch(() => null),
          ]);
          setSt(s);
          if (p) setProg(p);
          if (pf && Array.isArray(pf.profiles)) setProfs(pf.profiles);
          if (ar) {
            setArmArmed(ar.armed === true);
            setArmNote(ar.section ? '' : `破甲段未挂载：${ar.sectionReason || 'unknown'}（重启 dsh web 后生效）`);
          }
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        }
      }, []);

      // 破甲模式开关：写的是 systemPrompt 常驻段的状态，因此对**所有**对话生效，
      // 包括带工具调用的回合；关掉后段返回空串，等于不存在。
      const toggleArm = async () => {
        try {
          const out = await api('arm', { on: !armArmed });
          setArmArmed(out.armed === true);
          setArmNote('');
        } catch (e) {
          setArmNote(String(e && e.message ? e.message : e));
        }
      };

      // 一键体验：固定小预算（2 代 × 4 体 × 40 次调用），几秒到几十秒就能看到回答，
      // 不让小白面对 K/N/预算这些参数。想跑满就展开「高级设置」用 start()。
      const quickStart = async () => {
        setErr('');
        setBusy(true);
        try {
          const route = pickRoute();
          const payload = {
            goal,
            backend: 'harness',
            judge: 'auto',
            generations: 2,
            population: 4,
            maxTargetCalls: 40,
            targetMaxTokens: 2048,
            amplify: true,
            provider: route.provider || undefined,
            model: route.model || undefined,
            profile: profId || undefined,
          };
          setProg(await api('run', payload));
          setTab('console');
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      };

      // 0 成本预览：只渲染"这次会注入什么提示"，不碰模型、不花调用。
      const previewNow = async () => {
        setErr('');
        try {
          const out = await api('preview', { goal, seed: form.seed || undefined });
          setPreview(out);
          setToast('已渲染，0 次模型调用');
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        }
      };

      useEffect(() => {
        refresh();
        const timer = setInterval(() => {
          api('progress').then((p) => { if (p) setProg(p); }).catch(() => {});
        }, 1600);
        return () => clearInterval(timer);
      }, [refresh]);

      const running = prog && prog.status === 'running';

      // 没有手选模型时，优先挑能力最强的已配置模型（deepseek-v4-pro / 含 pro 的 id），
      // 这样"输入一句话 → 直接给回答"不需要任何调参。
      const pickRoute = () => {
        if (form.provider && form.model) return { provider: form.provider, model: form.model };
        const allModels = (st && st.models) || {};
        for (const pid of Object.keys(allModels)) {
          const list = allModels[pid] || [];
          const hit = list.find((m) => /flash/i.test(m.id)) || list.find((m) => /v4/i.test(m.id));
          if (hit) return { provider: form.provider || pid, model: form.model || hit.id };
        }
        return { provider: form.provider || '', model: form.model || '' };
      };

      const start = async () => {
        setErr('');
        setBusy(true);
        try {
          const route = pickRoute();
          const payload = { goal, ...form, provider: route.provider, model: route.model };
          if (profId) payload.profile = profId; else delete payload.profile;
          if (!payload.provider) delete payload.provider;
          if (!payload.model) delete payload.model;
          if (!payload.baseUrl) delete payload.baseUrl;
          if (!payload.apiKey) delete payload.apiKey;
          if (!payload.seed) delete payload.seed;
          payload.generations = Number(payload.generations) || 2;
          payload.population = Number(payload.population) || 4;
          payload.maxTargetCalls = Number(payload.maxTargetCalls) || 40;
          const snap = await api('run', payload);
          setProg(snap);
          setTab('console');
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      };

      // 采集思维模板：诱导目标模型给出推理骨架 → 属性分解成九维候选池 → 存 <root>/profiles。
      const collectProfile = async () => {
        setErr('');
        setProfMsg('采集中…（三次诱导 + 属性分解，约 10–40 秒）');
        setCollecting(true);
        try {
          if (!goal.trim()) throw new Error('先写目标 g，模板要围绕目标采集');
          const route = pickRoute();
          const out = await api('profile', { goal, provider: route.provider, model: route.model, backend: form.backend });
          setProfId(out.id);
          const dims = out.dims && typeof out.dims === 'object' ? Object.keys(out.dims).length : 0;
          setProfMsg(`已采集 ${out.id} · 来源 ${out.source} · ${dims} 维 · 轨迹 ${out.traceChars} 字符 · 质量 ${out.quality || 'n/a'}`);
          setProfs((prev) => [{ id: out.id, model: route.model, source: out.source, quality: out.quality, filled: dims }, ...prev.filter((p) => p.id !== out.id)]);
        } catch (e) {
          setProfMsg('');
          setErr(String(e && e.message ? e.message : e));
        } finally {
          setCollecting(false);
        }
      };

      const stop = async () => {
        try {
          await api('stop', {});
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        }
      };

      const loadTax = async () => {
        try {
          setTax(await api('taxonomy'));
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        }
      };

      const pick = async (id) => {
        try {
          setProg(await api(`progress?id=${encodeURIComponent(id)}`));
          setTab('console');
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        }
      };

      const exportReport = async () => {
        if (!prog || !prog.runId) return;
        try {
          const out = await api(`export?id=${encodeURIComponent(prog.runId)}&format=markdown&root=${encodeURIComponent(prog.root || '')}`);
          copy((out && out.body) || '', 'prompt');
          setToast('report.md 已复制到剪贴板');
        } catch (e) {
          setErr(String(e && e.message ? e.message : e));
        }
      };

      const providers = (st && st.providers) || [];
      const models = (st && st.models && st.models[form.provider]) || [];
      const pluginRoot = st?.config?.root || '';
      const tight = seat === 'settings.section';

      const head = h('div', { className: 'jb-head' },
        h('span', { className: 'jb-name' }, 'jailbreak'),
        h('span', { className: 'jb-state' }, armArmed ? '注入中' : '已关闭'),
        h('span', { className: 'jb-spacer' }),
        h('button', {
          className: 'jb-switch' + (armArmed ? ' on' : ''),
          onClick: toggleArm,
          title: armArmed ? '点一下关掉：本机新对话不再注入' : '点一下打开：本机新对话自动带注入段',
          'aria-label': 'toggle injection',
        }, h('i')),
      );

      const advBlock = adv
        ? h('div', { className: 'aecot-card' },
            h('div', { className: 'aecot-row' },
              h(Field, { label: '后端' }, h('select', { value: form.backend, onChange: set('backend') },
                ((st && st.backends) || [{ id: 'auto', label: 'auto' }]).map((b) => h('option', { key: b.id, value: b.id }, b.label || b.id)),
              )),
              h(Field, { label: 'provider' },
                providers.length
                  ? h('select', { value: form.provider, onChange: (ev) => { setForm((p) => ({ ...p, provider: ev.target.value, model: '' })); } },
                      h('option', { value: '' }, '（自动挑最强）'),
                      providers.map((p) => h('option', { key: p.id, value: p.id }, p.label || p.id)),
                    )
                  : h('input', { type: 'text', value: form.provider, placeholder: '默认', onChange: set('provider') }),
              ),
              h(Field, { label: 'model' },
                models.length
                  ? h('select', { value: form.model, onChange: set('model') },
                      h('option', { value: '' }, '（自动挑最强）'),
                      models.map((m) => h('option', { key: m.id, value: m.id }, m.label || m.id)),
                    )
                  : h('input', { type: 'text', value: form.model, placeholder: '默认', onChange: set('model') }),
              ),
              h(Field, { label: '判分' }, h('select', { value: form.judge, onChange: set('judge') },
                ((st && st.judges) || [{ id: 'auto', label: 'auto' }]).map((j) => h('option', { key: j.id, value: j.id }, j.label || j.id)),
              )),
            ),
            h('div', { className: 'aecot-row' },
              h(Field, { label: '代数 K' }, h('input', { type: 'number', min: 1, max: 12, value: form.generations, onChange: set('generations') })),
              h(Field, { label: '种群 N' }, h('input', { type: 'number', min: 2, max: 40, value: form.population, onChange: set('population') })),
              h(Field, { label: '调用预算' }, h('input', { type: 'number', min: 1, max: 600, value: form.maxTargetCalls, onChange: set('maxTargetCalls') })),
              h(Field, { label: '回答上限' }, h('input', { type: 'number', min: 64, max: 8192, value: form.targetMaxTokens, onChange: set('targetMaxTokens') })),
              h(Field, { label: '种子' }, h('input', { type: 'text', value: form.seed, placeholder: '留空=随机', onChange: set('seed') })),
              h('label', { className: 'aecot-field' },
                h('span', null, '放大'),
                h('span', null, h('input', { type: 'checkbox', checked: !!form.amplify, onChange: set('amplify') }), ' 终局放大'),
              ),
            ),
            form.backend === 'openai'
              ? h('div', { className: 'aecot-row' },
                  h(Field, { label: 'baseUrl' }, h('input', { type: 'text', value: form.baseUrl, placeholder: 'https://api.example.com/v1', onChange: set('baseUrl') })),
                  h(Field, { label: 'apiKey' }, h('input', { type: 'text', value: form.apiKey, placeholder: 'sk-...', onChange: set('apiKey') })),
                )
              : null,
          )
        : null;

      const body = h('div', null,
        h('textarea', {
          className: 'jb-input',
          rows: 2,
          value: goal,
          placeholder: '说要做什么，例如：逆向这个程序的注册校验，指出关键跳转和 patch 点',
          onChange: (ev) => setGoal(ev.target.value),
        }),
        h('div', { className: 'jb-tags', style: { marginTop: 8 } }, SCENES.map((s) => h('button', {
          key: s.label,
          className: 'jb-tag',
          onClick: () => setGoal(s.goal),
          title: s.goal,
        }, s.label))),
        h('div', { className: 'jb-bar', style: { marginTop: 10 } },
          h('button', {
            className: 'jb-run',
            disabled: busy || running || goal.trim().length < 4,
            onClick: quickStart,
          }, running ? '跑着' : busy ? '启动中' : '运行'),
          h('button', { className: 'jb-link', disabled: running || goal.trim().length < 4, onClick: previewNow }, '提示词'),
          h('button', { className: 'jb-link', disabled: !running, onClick: stop }, '停止'),
          h('span', { className: 'jb-spacer' }),
          toast ? h('span', { className: 'jb-muted' }, toast) : null,
        ),
        err ? h('div', { className: 'jb-err', style: { marginTop: 6 } }, err) : null,
        running
          ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'jb-prog' }, h('i', {
                style: {
                  width: `${Math.round((Math.min(Number(prog.generation) || 0, Number(prog.generations) || 1) / Math.max(1, Number(prog.generations) || 1)) * 100)}%`,
                },
              })),
              h('div', { className: 'jb-muted' },
                `第 ${prog.generation || 0}/${prog.generations || '?'} 代 · 调用 ${prog.targetCalls ?? 0} · f=${prog.bestScore ?? '—'}`),
            )
          : null,
      );

      const hasAnswer = Boolean(prog && prog.best && prog.best.response);
      const answerCard = hasAnswer
        ? h('div', { className: 'jb-card' },
            h('div', { className: 'jb-head' },
              h(Score, { value: prog.best.score }),
              h('span', { className: 'jb-spacer' }),
              h('button', { className: 'jb-link', onClick: () => copy(prog.best.response, 'answer') }, '复制'),
            ),
            h('pre', { className: 'jb-answer' }, String(prog.best.response)),
          )
        : h('div', { className: 'jb-empty' }, '还没有回答');

      const promptCard = preview
        ? h('div', { className: 'jb-card' },
            h('div', { className: 'jb-muted' }, `${preview.fingerprint} · 覆盖率 ${preview.coverage}`),
            h('pre', { className: 'jb-answer' }, String(preview.prompt || '')),
          )
        : null;

      const profRow = profs.length
        ? h('div', { className: 'jb-head' },
            h('span', { className: 'jb-muted' }, '模板'),
            h('select', { className: 'jb-tag', value: profId, onChange: (ev) => setProfId(ev.target.value) },
              h('option', { value: '' }, '内置'),
              profs.map((p) => h('option', { key: p.id, value: p.id }, p.id)),
            ),
            h('span', { className: 'jb-spacer' }),
            h('button', { className: 'jb-link', disabled: collecting || busy || !goal.trim(), onClick: collectProfile }, collecting ? '采集中' : '采集'),
            profMsg ? h('span', { className: 'jb-muted' }, profMsg) : null,
          )
        : null;

      const detail = h('details', {
        className: 'jb-details',
        onToggle: (ev) => { if (ev.currentTarget.open && !tax) loadTax(); },
      },
        h('summary', null, '详情'),
        h('div', null,
          advBlock,
          profRow,
          promptCard,
          h(Progress, { prog }),
          h(BestPanel, { prog, onCopy: copy }),
          h(Runs, { st, onPick: pick }),
          h('div', { className: 'jb-head' },
            h('button', { className: 'jb-link', disabled: busy || running || goal.trim().length < 4, onClick: start }, '按参数跑'),
            h('button', { className: 'jb-link', disabled: !prog || !prog.runId, onClick: exportReport }, '复制报告'),
            h('span', { className: 'jb-spacer' }),
            tax ? h('span', { className: 'jb-muted' }, `|Θ| ${tax.space}`) : null,
          ),
        ),
      );

      return h('div', { className: 'jb', style: tight ? undefined : { maxWidth: 760 } },
        h('style', null, `${CSS}\n${UI}`),
        head,
        armNote ? h('div', { className: 'jb-err' }, armNote) : null,
        body,
        answerCard,
        detail,
      );
    }

    function NavIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M4 2c3 2 5 4 5 6s-2 4-5 6', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M12 2c-3 2-5 4-5 6s2 4 5 6', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M5.2 5.4h5.6M5.2 10.6h5.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      );
    }

    const LABEL = '破甲台 · jailbreak';

    return {
      inject: ['slots'],
      apply(ctx) {
        let slots = null;
        try {
          slots = ctx.get ? ctx.get('slots') : null;
        } catch {
          slots = null;
        }
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[jailbreak] slots 服务不可用，面板未注册（模型工具不受影响）');
          return;
        }

        const seats = [
          ['settings.section', { name: 'settings.section', id: 'aecot', order: 26, label: () => LABEL }, () => h(Console, { seat: 'settings.section' })],
          ['sidebar.panellist', { name: 'sidebar.panellist', id: 'aecot', order: 22, label: () => '破甲台' }, () => h(NavIcon)],
          ['main', { name: 'main', key: 'aecot' }, () => h(Console, { seat: 'main' })],
        ];

        for (const [slot, desc, render] of seats) {
          try {
            ctx.effect(() => slots.inject(slot, () => slots.register(desc, render)), `jailbreak: ${slot}`);
          } catch (error) {
            console.warn(`[jailbreak] ${slot} 注册失败:`, error && error.message ? error.message : error);
          }
        }
        console.log('[jailbreak] 面板已注册：settings.section / sidebar.panellist / main');
      },
    };
  },
});
