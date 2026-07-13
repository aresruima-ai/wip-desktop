/**
 * bad-spc.js — SPC控制图 (P-Chart)
 */
var BadSPC = (function() {
    var chart = null;

    function render(spcData) {
        if (!chart) chart = echarts.init(document.getElementById('spcChart'));
        if (!spcData || !spcData.points || spcData.points.length < 3) {
            chart.setOption(CHART.emptyState('数据不足(需≥3天)'), true);
            return;
        }
        var points = spcData.points;
        var dates = points.map(function(p) { return p.date; });
        var pValues = points.map(function(p) { return +(p.p * 100).toFixed(3); });
        var uclValues = points.map(function(p) { return +(p.ucl * 100).toFixed(3); });
        var lclValues = points.map(function(p) { return +(p.lcl * 100).toFixed(3); });
        var clValue = +(spcData.pBar * 100).toFixed(3);

        // Mark violation points
        var violationIndices = new Set();
        (spcData.violations || []).forEach(function(v) { violationIndices.add(v.index); });
        var markData = [];
        var rippleData = []; // 越界点涟漪脉冲 (effectScatter, GPU 友好)
        points.forEach(function(p, i) {
            if (violationIndices.has(i)) {
                var val = +(p.p * 100).toFixed(3);
                markData.push({ coord: [i, val], symbolSize: 12 });
                rippleData.push({ value: [i, val] });
            }
        });

        chart.setOption({
            tooltip: Object.assign(CHART.tooltip(), {
                formatter: function(params) {
                    var tip = '<b>' + params[0].axisValue + '</b><br/>';
                    params.forEach(function(p) {
                        if (p.seriesName === '不良率') tip += p.marker + '不良率: ' + p.value + '%<br/>';
                    });
                    var pt = points[params[0].dataIndex];
                    if (pt) tip += '检验量: ' + pt.n + '<br/>不良数: ' + pt.defects;
                    if (violationIndices.has(params[0].dataIndex)) tip += '<br/><span style="color:var(--danger);font-weight:bold">⚠ 异常点</span>';
                    return tip;
                }
            }),
            legend: { data: ['不良率', 'UCL', 'CL', 'LCL'], top: 0, textStyle: { color: CHART.legendText, fontSize: 11 } },
            grid: { top: 45, bottom: 30, left: 60, right: 30 },
            xAxis: { type: 'category', data: dates, axisLabel: { color: CHART.axisLabel, fontSize: 10 }, axisLine: { lineStyle: { color: CHART.axisLine } } },
            yAxis: { type: 'value', name: '不良率%', axisLabel: { color: CHART.axisLabel, fontSize: 10, formatter: '{value}%' }, splitLine: { lineStyle: { color: CHART.splitLine } } },
            series: [
                {
                    name: '不良率', type: 'line', data: pValues, symbol: 'circle', symbolSize: 6,
                    lineStyle: { color: CHART.colors.blue, width: 2 },
                    itemStyle: { color: function(p) { return violationIndices.has(p.dataIndex) ? CHART.colors.red : CHART.colors.blue; } },
                    markPoint: { data: markData, symbol: 'circle', itemStyle: { color: CHART.colors.red, borderColor: '#fff', borderWidth: 2 } }
                },
                /* 越界点涟漪脉冲 — SPC 最抓视线的"该处理"信号 */
                {
                    name: '__spc_ripple', type: 'effectScatter', data: rippleData,
                    coordinateSystem: 'cartesian2d',
                    symbolSize: 10, zlevel: 2,
                    rippleEffect: { period: 3, scale: 3.2, brushType: 'stroke' },
                    showEffectOn: 'render',
                    itemStyle: { color: CHART.colors.red, shadowBlur: 10, shadowColor: 'rgba(239,68,68,0.6)' },
                    tooltip: { show: false }
                },
                /* SPC UCL markArea 静态危险色带 — 钩子#23：UCL 线以上整片铺极淡红色(rgba .06)做"越界危险区"静态衬底。
                   触发态强化：检测到 violationIndices 非空时一次性加深到 rgba(.12)，无异常回 .06；纯静态 markArea，无常驻呼吸/脉冲。 */
                { name: 'UCL', type: 'line', data: uclValues, symbol: 'none', lineStyle: { color: CHART.colors.red, type: 'dashed', width: 1.5 },
                  markArea: { silent: true, itemStyle: { color: violationIndices.size > 0 ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.06)' }, data: [ [{ yAxis: 'max' }, { yAxis: 'min' }] ] } },
                { name: 'CL', type: 'line', data: dates.map(function() { return clValue; }), symbol: 'none', lineStyle: { color: CHART.colors.orange, type: 'solid', width: 1.5 } },
                { name: 'LCL', type: 'line', data: lclValues, symbol: 'none', lineStyle: { color: CHART.colors.green, type: 'dashed', width: 1.5 } }
            ]
        }, true);
    }

    function renderViolations(spcData) {
        var el = document.getElementById('spcViolations');
        if (!el) return;
        if (!spcData || !spcData.violations || !spcData.violations.length) {
            el.innerHTML = '<span style="color:var(--success);font-size:12px;">&#10003; 过程受控，无异常信号</span>';
            return;
        }
        var ruleNames = {
            'out_of_limits': '点出控制界限',
            '7_above_cl': '连续7点在中心线上方',
            '7_below_cl': '连续7点在中心线下方'
        };
        var html = spcData.violations.map(function(v) {
            return '<div class="spc-viol-row">' +
                '<span class="spc-icon"></span>' +
                '<span style="font-size:12px;color:var(--text-primary);">' + v.date + ' — ' + (ruleNames[v.rule] || v.rule) + '</span>' +
                '</div>';
        }).join('');
        el.innerHTML = html;
    }

    function resize() { if (chart) chart.resize(); }

    return { render: render, renderViolations: renderViolations, resize: resize };
})();
