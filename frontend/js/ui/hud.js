/**
 * 大屏界面层
 * =========
 * 负责所有 2D 的显示与交互：指标卡、分区列表、传感网络、趋势图、决策流、详情抽屉。
 *
 * 刷新策略（这是大屏不卡的關鍵）：
 *   · 数值类文本按 4 Hz 刷新，够用且不抖；
 *   · 列表结构只在数据项发生变化时重建，不做整表重绘；
 *   · 决策流按 id 增量插入，避免动画反复重放。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const ZONE_SHORT = { Z1: 'Z1', Z2: 'Z2', Z3: 'Z3', Z4: 'Z4', Z5: 'Z5' };
const PRIORITY_TEXT = { 1: '紧急', 2: '重要', 3: '优化', 4: '节能' };

export class HUD {
  constructor({ onCommand, onFocusZone }) {
    this.onCommand = onCommand;
    this.onFocusZone = onFocusZone;

    this.site = null;
    this.frame = null;
    this.agent = null;
    this.selectedZone = 'Z2';
    this.chartRange = 180;
    this.feedIds = new Set();
    this.lastTextUpdate = 0;
    this.lastAgentCount = 0;

    this.chart = null;
    this.historyCache = null;

    this._bindEvents();
    this._initChart();
  }

  /* ================= 站点信息 ================= */
  setSite(site) {
    this.site = site;
    window.__crops = site.crops;
    this._renderZones();
    this._renderNodes();
    this._renderLegend();
  }

  /* ================= 事件绑定 ================= */
  _bindEvents() {
    // 倍速
    $('#speed-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#speed-seg button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      this.onCommand({ action: 'set_speed', value: Number(b.dataset.speed) });
    });

    // 模式
    $('#mode-switch').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#mode-switch button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      this.onCommand({ action: 'set_mode', value: b.dataset.mode });
    });

    // 曲线时间范围
    $('#chart-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#chart-tabs button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      this.chartRange = Number(b.dataset.range);
      this.refreshChart();
    });

    // 视角
    $('#view-btns').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#view-btns button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      if (window.__twinView) window.__twinView(b.dataset.view);
    });

    // 天气情景
    $('#scenario-btns').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('#scenario-btns button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      this.onCommand({ action: 'set_scenario', value: b.dataset.sc });
    });

    // 抽屉关闭
    $('#dr-close').addEventListener('click', () => this.closeDrawer());
    $('#drawer-mask').addEventListener('click', () => this.closeDrawer());

    // 分区列表
    $('#zone-list').addEventListener('click', (e) => {
      const item = e.target.closest('.zone-item');
      if (!item) return;
      this.selectZone(item.dataset.zone);
      this.onFocusZone(item.dataset.zone);
    });

    // 决策流点击
    $('#decision-feed').addEventListener('click', (e) => {
      const it = e.target.closest('.dec-item');
      if (!it) return;
      const rec = this.agent?.recent?.find(r => r.id === it.dataset.id);
      if (rec) this.showDecision(rec);
    });

    window.addEventListener('resize', () => {
      this.chart?.resize();
    });
  }

  /* ================= 分区列表 ================= */
  _renderZones() {
    if (!this.site) return;
    const list = $('#zone-list');
    const order = ['Z2', 'Z3', 'Z4', 'Z5', 'Z1'];
    list.innerHTML = order.map(zid => {
      const z = this.site.zones[zid];
      if (!z) return '';
      const crop = this.site.crops[z.crop];
      const dot = crop ? `<i style="background:${crop.color}"></i>` : '';
      return `
        <div class="zone-item ${zid === this.selectedZone ? 'active' : ''}" data-zone="${zid}">
          <div class="zi-top">
            <span class="zi-name">${z.name}</span>
            <span class="zi-crop">${dot}${crop ? crop.name : '景观水体'}</span>
          </div>
          <div class="zi-bar"><i style="width:0%;background:#3ad6c2"></i></div>
          <div class="zi-data">
            <span>气温 <b data-f="t">--</b>℃</span>
            <span>湿度 <b data-f="h">--</b>%</span>
            <span>墒情 <b data-f="m">--</b>%</span>
          </div>
        </div>`;
    }).join('');
  }

  selectZone(zid) {
    this.selectedZone = zid;
    $$('#zone-list .zone-item').forEach(el => {
      el.classList.toggle('active', el.dataset.zone === zid);
    });
    this.refreshChart();
  }

  /* ================= 传感网络 ================= */
  _renderNodes() {
    if (!this.site) return;
    const list = $('#node-list');
    list.innerHTML = this.site.nodes.map(n => `
      <div class="node-item" data-node="${n.id}" data-zone="${n.zone}">
        <span class="st"></span>
        <span class="nm">${n.name}</span>
        <span class="vl" data-f="v">--</span>
      </div>`).join('');
    $('#node-total').textContent = this.site.nodes.length;

    list.addEventListener('click', (e) => {
      const it = e.target.closest('.node-item');
      if (it) this.onFocusZone(it.dataset.zone);
    });
  }

  /* ================= 曲线 ================= */
  _initChart() {
    if (!window.echarts) return;
    const el = $('#chart');
    this.chart = window.echarts.init(el, null, { renderer: 'canvas' });
    const ro = new ResizeObserver(() => this.chart?.resize());
    ro.observe(el);
  }

  async refreshChart() {
    if (!this.chart) return;
    try {
      const zone = this.selectedZone;
      const r = await fetch(`/api/history?minutes=${this.chartRange}&zone=${zone}`);
      const data = await r.json();
      this._drawChart(data, zone);
    } catch (e) {
      /* 静默失败：曲线不是关键路径 */
    }
  }

  _drawChart(data, zone) {
    const z = data[zone];
    const wx = data['WX'];
    if (!z) {
      this.chart.clear();
      return;
    }

    const fmt = ts => {
      const d = new Date(ts * 1000);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const axisX = z.t.map(fmt);
    const wxMap = new Map();
    if (wx) wx.t.forEach((t, i) => wxMap.set(Math.round(t / 60), wx.t_out[i]));
    const wxSeries = z.t.map(t => {
      // 用分钟对齐做最近邻匹配
      let best = null, bestD = 1e9;
      if (wx) for (let i = 0; i < wx.t.length; i++) {
        const d = Math.abs(wx.t[i] - t);
        if (d < bestD) { bestD = d; best = wx.t_out[i]; }
      }
      return bestD < 600 ? best : null;
    });

    const accent = '#3ad6c2';
    const amber = '#f2b544';

    this.chart.setOption({
      backgroundColor: 'transparent',
      animationDuration: 600,
      grid: { left: 34, right: 34, top: 16, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(8,26,32,.95)',
        borderColor: 'rgba(74,210,196,.35)',
        borderWidth: 1,
        textStyle: { color: '#e2f5f2', fontSize: 11 },
        axisPointer: {
          type: 'line',
          lineStyle: { color: 'rgba(58,214,194,.37)', width: 1 },
        },
      },
      xAxis: {
        type: 'category',
        data: axisX,
        boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(74,210,196,.16)' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#5c7f80', fontSize: 9.5, fontFamily: 'monospace',
          interval: Math.max(0, Math.floor(axisX.length / 5)),
        },
      },
      yAxis: [
        {
          type: 'value',
          name: '℃',
          nameTextStyle: { color: '#5c7f80', fontSize: 9, padding: [0, 0, 0, -18] },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,.045)' } },
          axisLabel: { color: '#5c7f80', fontSize: 9, fontFamily: 'monospace' },
        },
        {
          type: 'value',
          name: '%',
          nameTextStyle: { color: '#5c7f80', fontSize: 9, padding: [0, -16, 0, 0] },
          min: 0, max: 50,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { color: '#5c7f80', fontSize: 9, fontFamily: 'monospace' },
        },
      ],
      series: [
        {
          name: '棚内温度',
          type: 'line',
          data: z.air_temp,
          smooth: 0.35,
          symbol: 'none',
          lineStyle: { width: 1.8, color: accent },
          areaStyle: {
            color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(58,214,194,.30)' },
              { offset: 1, color: 'rgba(58,214,194,0)' },
            ]),
          },
        },
        {
          name: '室外温度',
          type: 'line',
          data: wxSeries,
          smooth: 0.35,
          symbol: 'none',
          lineStyle: { width: 1.2, color: 'rgba(143,179,178,.85)', type: 'dashed' },
        },
        {
          name: '土壤含水率',
          type: 'line',
          yAxisIndex: 1,
          data: z.soil_moisture,
          smooth: 0.35,
          symbol: 'none',
          lineStyle: { width: 1.4, color: amber },
        },
      ],
    }, true);
  }

  _renderLegend() {
    $('#chart-legend').innerHTML = `
      <span><i style="background:#3ad6c2"></i>棚内温度</span>
      <span><i style="background:rgba(143,179,178,.85)"></i>室外温度</span>
      <span><i style="background:#f2b544"></i>土壤含水率</span>`;
  }

  /* ================= 帧更新 ================= */
  updateFrame(frame) {
    this.frame = frame;
    const now = performance.now();
    const doText = now - this.lastTextUpdate > 240;
    if (doText) this.lastTextUpdate = now;

    const env = frame.env;
    // 时钟
    const dt = new Date(env.ts * 1000);
    const hh = String(dt.getHours()).padStart(2, '0');
    const mm = String(dt.getMinutes()).padStart(2, '0');
    const ss = String(dt.getSeconds()).padStart(2, '0');
    $('#sim-time').textContent = `${hh}:${mm}:${ss}`;
    $('#sim-date').textContent =
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} 周${'日一二三四五六'[dt.getDay()]}`;

    // 气象
    $('#wx-temp').textContent = env.outdoor_temp.toFixed(1);
    $('#wx-rh').textContent = Math.round(env.outdoor_humidity);
    $('#wx-wind').textContent = env.wind.toFixed(1);
    $('#wx-par').textContent = Math.round(env.par);

    if (!doText) return;

    // KPI
    const k = frame.kpi;
    $('#kpi-health').textContent = k.avg_health.toFixed(0);
    $('#kpi-energy').textContent = k.energy_kwh > 9999
      ? (k.energy_kwh / 1000).toFixed(1) + 'k' : Math.round(k.energy_kwh);
    $('#kpi-water').textContent = k.water_l > 9999
      ? (k.water_l / 1000).toFixed(1) + 'k' : Math.round(k.water_l);
    $('#kpi-decisions').textContent = k.decision_count;
    $('#kpi-sub').textContent = `在线 ${k.online_rate}%`;

    // 分区数值
    const zones = frame.zones || {};
    $$('#zone-list .zone-item').forEach(el => {
      const zid = el.dataset.zone;
      const z = zones[zid];
      let t, h, m, health = 100;
      if (zid === 'Z1') {
        const wt = frame.nodes?.['SN-WT-01'];
        t = wt?.water_temp ?? env.outdoor_temp;
        h = env.outdoor_humidity;
        m = null;
      } else if (z) {
        t = z.air_temp; h = z.air_humidity; m = z.soil_moisture;
      }
      el.querySelector('[data-f="t"]').textContent = t != null ? (+t).toFixed(1) : '--';
      el.querySelector('[data-f="h"]').textContent = h != null ? Math.round(h) : '--';
      el.querySelector('[data-f="m"]').textContent = m != null ? Math.round(m) : (zid === 'Z1' ? '—' : '--');

      // 健康度来自 agent 快照
      const ag = this.agent?.zones?.find(a => a.zone === zid);
      if (ag) health = ag.health;
      const bar = el.querySelector('.zi-bar i');
      bar.style.width = `${health}%`;
      bar.style.background = health >= 88 ? '#3ad6c2'
        : health >= 75 ? '#8fd06a' : health >= 60 ? '#f2b544' : '#f2564d';
    });

    // 传感网络
    const nodes = frame.nodes || {};
    $$('#node-list .node-item').forEach(el => {
      const nid = el.dataset.node;
      const v = nodes[nid];
      const outEl = el.querySelector('[data-f="v"]');
      if (!v) { outEl.textContent = '--'; el.classList.add('off'); return; }
      el.classList.remove('off');
      let text = '';
      if (v.air_temp != null) text = `${v.air_temp.toFixed(1)}℃`;
      else if (v.soil_moisture != null) text = `${v.soil_moisture.toFixed(1)}%`;
      else if (v.water_temp != null) text = `${v.water_temp.toFixed(1)}℃`;
      outEl.textContent = text;
    });
    $('#node-online').textContent = Object.keys(nodes).length;

    // 连接状态
    const conn = $('#conn');
    conn.classList.add('ok');
    $('#conn-text').textContent = `已连接 · ${Math.round(k.online_rate)}% 在线 · 倍速 ${env.speed}×`;
  }

  /* ================= Agent 面板 ================= */
  updateAgent(agent) {
    this.agent = agent;
    const stats = agent.stats;

    $('#agent-summary').innerHTML = `
      <div class="as-item"><div class="k">累计决策</div><div class="v">${stats.total}</div></div>
      <div class="as-item"><div class="k">执行动作</div><div class="v">${stats.actions}</div></div>
      <div class="as-item"><div class="k">待办建议</div><div class="v">${
        agent.zones.reduce((s, z) => s + (z.pending?.length || 0), 0)}</div></div>`;

    // 模式同步
    const modeText = { auto: '全自动', advise: '建议模式', manual: '手动控制' };
    $('#mode-text').textContent = modeText[agent.mode] || agent.mode;
    $$('#mode-switch button').forEach(b => b.classList.toggle('on', b.dataset.mode === agent.mode));

    $('#feed-stat').textContent = `近 40 条 · 规则库 ${Object.keys(PRIORITY_TEXT).length} 级`;

    this._insertDecisions(agent.recent || []);
  }

  _insertDecisions(recent) {
    const feed = $('#decision-feed');
    // recent 是倒序（最新在前）。找出尚未渲染的，按时间正序插入到顶部
    const fresh = recent.filter(r => !this.feedIds.has(r.id)).reverse();
    if (!fresh.length) return;

    for (const rec of fresh) {
      this.feedIds.add(rec.id);
      const el = document.createElement('div');
      el.className = `dec-item p${rec.priority}`;
      el.dataset.id = rec.id;
      el.innerHTML = `
        <span class="di-badge badge-p${rec.priority}">${PRIORITY_TEXT[rec.priority]}</span>
        <div class="di-top">
          <span class="di-time">${rec.time}</span>
          <span class="di-zone">${rec.zone}</span>
          <span class="di-act">${rec.headline}</span>
        </div>
        <div class="di-line">${rec.reasons?.[0] || rec.basis || ''}</div>`;
      feed.prepend(el);
    }
    // 只保留最近 40 条 DOM
    while (feed.children.length > 40) {
      const last = feed.lastElementChild;
      this.feedIds.delete(last.dataset.id);
      last.remove();
    }
  }

  /* ================= 抽屉 ================= */
  openDrawer(tag, title, bodyHtml) {
    $('#dr-tag').textContent = tag;
    $('#dr-title').textContent = title;
    $('#dr-body').innerHTML = bodyHtml;
    $('#drawer').classList.add('open');
    $('#drawer-mask').classList.add('open');
  }

  closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer-mask').classList.remove('open');
  }

  showDecision(rec) {
    const body = `
      <div class="dr-section">
        <h4>触发依据</h4>
        <ul class="dr-reasons">${(rec.reasons || []).map(r => `<li>${r}</li>`).join('')}</ul>
      </div>
      <div class="dr-section">
        <h4>农艺依据</h4>
        <div class="dr-quote">${rec.basis || '—'}</div>
      </div>
      <div class="dr-section">
        <h4>预期效果</h4>
        <div class="dr-quote">${rec.expected || '—'}</div>
      </div>
      <div class="dr-section">
        <h4>执行信息</h4>
        <dl class="dr-kv">
          <dt>指令</dt><dd>${rec.actuator_label} → ${rec.value}${rec.unit || ''}</dd>
          <dt>原值</dt><dd>${rec.prev}${rec.unit || ''}</dd>
          <dt>优先级</dt><dd>${PRIORITY_TEXT[rec.priority] || rec.priority}</dd>
          <dt>置信度</dt><dd>${(rec.confidence * 100).toFixed(0)}%</dd>
          <dt>规则编号</dt><dd>${rec.rule || '—'}</dd>
          <dt>决策时刻</dt><dd>${rec.datetime}</dd>
          <dt>状态</dt><dd>${rec.applied ? '已下发执行' : '仅建议，未执行'}</dd>
          <dt>分区健康度</dt><dd>${rec.health ?? '—'}</dd>
        </dl>
      </div>`;
    this.openDrawer(`决策 ${rec.id}`, rec.headline, body);
  }

  showZone(zid) {
    const z = this.frame?.zones?.[zid];
    const meta = this.site?.zones?.[zid];
    const ag = this.agent?.zones?.find(a => a.zone === zid);
    if (!meta) return;

    if (zid === 'Z1' || !z) {
      this.openDrawer('功能分区', meta.name, `
        <div class="dr-section">
          <h4>分区说明</h4>
          <div class="dr-quote">${meta.description}</div>
        </div>
        <div class="dr-section">
          <h4>所属</h4>
          <dl class="dr-kv"><dt>对应实地</dt><dd>${meta.part}</dd></dl>
        </div>`);
      return;
    }

    const act = z.actuators || {};
    const bars = Object.entries(act).map(([k, v]) => {
      const label = this.site.actuators[k]?.label || k;
      const pct = k === 'irrigation' ? Math.min(100, v * 5) : v;
      return `<div class="dr-act">
        <span class="an">${label}</span>
        <span class="abar"><i style="width:${pct}%"></i></span>
        <span class="av">${k === 'irrigation' ? v + 'mm' : v + '%'}</span>
      </div>`;
    }).join('');

    this.openDrawer(meta.part, meta.name, `
      <div class="dr-section">
        <h4>分区说明</h4>
        <div class="dr-quote">${meta.description}</div>
      </div>
      <div class="dr-section">
        <h4>环境实测</h4>
        <dl class="dr-kv">
          <dt>空气温度</dt><dd>${z.air_temp} ℃</dd>
          <dt>相对湿度</dt><dd>${z.air_humidity} %</dd>
          <dt>饱和差 VPD</dt><dd>${z.vpd} kPa</dd>
          <dt>CO₂ 浓度</dt><dd>${Math.round(z.co2)} ppm</dd>
          <dt>光合辐射</dt><dd>${Math.round(z.par)} μmol/(m²·s)</dd>
          <dt>土壤温度</dt><dd>${z.soil_temp} ℃</dd>
          <dt>根区含水率</dt><dd>${z.soil_moisture} %</dd>
          <dt>土壤 pH / EC</dt><dd>${z.soil_ph} / ${z.soil_ec} mS/cm</dd>
          <dt>今日光积分</dt><dd>${z.dli} mol/m²</dd>
        </dl>
      </div>
      <div class="dr-section">
        <h4>设备状态</h4>
        <div class="dr-actuators">${bars}</div>
      </div>
      ${ag ? `<div class="dr-section">
        <h4>Agent 判读</h4>
        <div class="dr-quote">${ag.summary}</div>
        <dl class="dr-kv" style="margin-top:10px">
          <dt>物候期</dt><dd>${ag.stage}</dd>
          <dt>管理要点</dt><dd style="font-family:inherit;font-size:11.5px">${ag.stage_note}</dd>
          <dt>健康度</dt><dd>${ag.health}</dd>
        </dl>
      </div>` : ''}`);
  }

  /* ================= 载入 ================= */
  setLoader(pct, text) {
    const bar = $('#loader-bar');
    if (bar) bar.style.width = `${Math.min(100, pct)}%`;
    if (text) $('#loader-text').textContent = text;
  }

  hideLoader() {
    $('#loader').classList.add('done');
    setTimeout(() => { $('#loader').style.display = 'none'; }, 700);
  }

  setConnection(state, text) {
    const el = $('#conn');
    el.classList.remove('ok', 'bad');
    if (state) el.classList.add(state);
    $('#conn-text').textContent = text;
  }
}
