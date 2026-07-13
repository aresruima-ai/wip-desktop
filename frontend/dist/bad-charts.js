/**
 * bad-charts.js — 所有图表渲染逻辑
 */
var BadCharts = (function() {
    var charts = {};

    function rateColor(v) { return v >= 95 ? CHART.colors.good : v >= 90 ? CHART.colors.warn : CHART.colors.bad; }
    // localDate 收口到 common.js (window.localDate), 模块内调用走全局

    function getOrInit(id) {
        if (!charts[id]) charts[id] = echarts.init(document.getElementById(id));
        return charts[id];
    }

    // 3 级下钻 L2 配置:图表 click → 先开 Drawer 分组视图(L2) → 点分组项再跳 L3(detail.html)
    // paretoChart 提供 buildGroups: 点某缺陷柱 → 返回该缺陷的 SN 分组(top20 SN 列表),供 openL2 渲染。
    // 其余图暂无 buildGroups,退化为单点直跳 L3(pickDim 按 dataIndex 取原始未截断维度值)。
    var DRILL_CFG = {
        paretoChart:  {
            dimension: 'defect',  source: 'bad-records', title: '不良项明细',
            pickDim: function (p, c) { return c._drillDim ? c._drillDim[p.dataIndex] : p.name; },
            // 点某缺陷柱 → 取该缺陷的 SN 分组(BadCore.getState().badItems 按 badItems===缺陷名 过滤, top20 SN)
            // 返回 null 时 bindChart 退化为单点直跳 L3
            buildGroups: function (params, chart) {
                if (!window.BadCore) return null;
                var dim = (chart && chart._drillDim && chart._drillDim[params.dataIndex]) || params.name;
                if (!dim) return null;
                var items = (BadCore.getState().badItems || []).filter(function (i) { return (i.badItems || '未知') === dim; });
                if (!items.length) return null;
                // 按 barcode 聚合(同 SN 多次不良计为一组,值=不良次数)
                var snCount = {};
                items.forEach(function (i) { var sn = i.barcode || '未知SN'; snCount[sn] = (snCount[sn] || 0) + 1; });
                var entries = Object.keys(snCount).sort(function (a, b) { return snCount[b] - snCount[a]; }).slice(0, 20);
                return entries.map(function (sn) {
                    return { name: sn, value: snCount[sn], sub: dim };
                });
            },
            // L2 分组项(SN)点击 → 跳 sn-trace(以 barcode 为 dimValue);默认 onItem 用 defect 维度对 bad-records 过滤会落空
            onItem: function (item) {
                if (window.DrillLink && item && item.name && item.name !== '未知SN') {
                    DrillLink.openL3('sn-trace', item.name, null, { dimension: 'barcode', chart: 'paretoChart' });
                }
            }
        },
        processChart: { dimension: 'process', source: 'bad-records', title: '工序不良明细' },
        lineChart:    { dimension: 'line',    source: 'bad-records', title: '线体不良明细' },
        modelChart:   { dimension: 'model',   source: 'bad-records', title: '型号不良明细' },
        trendChart:   { dimension: 'day',     source: 'bad-records', title: '当日不良明细' }
    };
    function bindAllDrill() {
        if (!window.DrillLink) return;
        Object.keys(DRILL_CFG).forEach(function (id) {
            if (charts[id]) DrillLink.bindChart(charts[id], Object.assign({ chartId: id }, DRILL_CFG[id]));
        });
    }

    function resizeAll() {
        Object.values(charts).forEach(function(c) { if (c) c.resize(); });
    }

    function showEmpty(chart, msg) {
        chart.setOption(CHART.emptyState(msg), true);
    }

    // ========== Liquid Fill KPI ==========
    function renderLiquidKPI(rate) {
        var chart = getOrInit('liquidRate');
        // 空值防护: 产量为 0 / 无过站数据时 rate=null, liquidFill 渲染 NaN 会显示空水球或报错
        if (rate == null || isNaN(rate)) { showEmpty(chart, '暂无过站数据'); return; }
        var v = rate / 100, c = rateColor(rate);
        chart.setOption({
            series: [{ type: 'liquidFill', data: [v, v * 0.9, v * 0.8], radius: '90%',
                color: [c, c, c], backgroundStyle: { color: CHART.bg },
                outline: { borderDistance: 2, itemStyle: { borderWidth: 2, borderColor: c } },
                label: { show: false } }]
        }, true);
    }

    // ========== Trend Chart ==========
    function renderTrend(prodByDay, badByDay, target) {
        var chart = getOrInit('trendChart');
        if (!prodByDay.length) { showEmpty(chart, '暂无过站产量数据'); return; }
        var badMap = {};
        badByDay.forEach(function(b) { badMap[b.date] = b.count; });
        var dates = prodByDay.map(function(d) { return d.date; });
        var badData = prodByDay.map(function(d) { return badMap[d.date] || 0; });
        var rateData = prodByDay.map(function(d) {
            var b = badMap[d.date] || 0;
            return d.total > 0 ? +((d.total - b) / d.total * 100).toFixed(2) : null;
        });
        // 产量为0但有不良的天(口径错配): FPY 不可算, 标注"该日无过站产量,不良N条未计入FPY"
        chart.setOption({
            tooltip: Object.assign(CHART.tooltip(), {
                formatter: function(params) {
                    var date = params[0].axisValue;
                    var prod = 0, bad = 0, rate = null;
                    params.forEach(function(p) {
                        if (p.seriesName === '不良数') bad = p.value;
                        if (p.seriesName === '直通率%') rate = p.value;
                    });
                    var d = prodByDay.find(function(x) { return x.date === date; });
                    if (d) prod = d.total;
                    var html = '<b>' + date + '</b><br/>过站产量: ' + prod.toLocaleString() + '<br/>测试不良: ' + bad;
                    if (prod > 0) {
                        html += '<br/>日FPY(估算): ' + (rate != null ? rate + '%' : '--') + '%';
                    } else if (bad > 0) {
                        html += '<br/><span style="color:var(--warning)">该日无过站产量,' + bad + '条不良未计入日FPY</span>';
                    }
                    html += '<br/><span style="color:var(--text-muted);font-size:10px">产量按过站日·不良按测试日,口径差1-2天,日FPY仅供参考</span>';
                    return html;
                }
            }),
            legend: CHART.legend(),
            grid: CHART.grid(),
            xAxis: CHART.xAxis(dates),
            yAxis: [
                { type: 'value', name: '不良数', axisLabel: { color: CHART.axisLabel, fontSize: 10 }, splitLine: { lineStyle: { color: CHART.splitLine } } },
                { type: 'value', name: '直通率%', max: 100, axisLabel: { color: CHART.axisLabel, fontSize: 10, formatter: '{value}%' }, splitLine: { show: false } }
            ],
            series: [
                { name: '不良数', type: 'bar', data: badData, barMaxWidth: 28, itemStyle: { color: CHART.colors.red, borderRadius: [2, 2, 0, 0] }, label: { show: dates.length <= 15, position: 'top', fontSize: 10, color: CHART.legendText } },
                { name: '直通率%', type: 'line', yAxisIndex: 1, data: rateData, smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { color: CHART.colors.green, width: 2 }, itemStyle: { color: CHART.colors.green }, label: { show: dates.length <= 15, position: 'top', fontSize: 10, color: CHART.colors.green, formatter: function(p) { return p.value != null ? p.value + '%' : ''; } } },
                { name: '目标 ' + target + '%', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { type: 'dashed', color: CHART.colors.orange, width: 1.5 }, data: dates.map(function() { return target; }) }
            ]
        }, true);
    }

    // ========== Pareto Chart ==========
    function renderPareto(badByDefect) {
        var chart = getOrInit('paretoChart');
        var sorted = (badByDefect || []).slice(0, 15);
        if (!sorted.length) { showEmpty(chart); return; }
        var names = sorted.map(function(s) { return s.defect.length > 15 ? s.defect.slice(0, 15) + '...' : s.defect; });
        var counts = sorted.map(function(s) { return s.count; });
        var total = counts.reduce(function(a, b) { return a + b; }, 0);
        var cumData = window.paretoCumulative(counts, total);
        /* 80% 交叉点: 累计首次 >=80% 的那项 — "攻克此项即可消化 80% 不良", 是 Pareto 的核心行动锚 */
        var crossoverIdx = -1;
        for (var i = 0; i < cumData.length; i++) { if (cumData[i] >= 80) { crossoverIdx = i; break; } }
        chart.setOption({
            tooltip: CHART.tooltip(),
            legend: { data: ['数量', '累计%'], textStyle: { color: CHART.legendText, fontSize: 11 }, top: 5, right: 10 },
            grid: { left: 50, right: 45, top: 40, bottom: 100 },
            xAxis: { type: 'category', data: names, axisLabel: { color: CHART.axisLabel, fontSize: 10, rotate: 40, interval: 0 }, axisLine: { lineStyle: { color: CHART.axisLine } } },
            yAxis: [
                { type: 'value', axisLabel: { color: CHART.axisLabel, fontSize: 10 }, splitLine: { lineStyle: { color: CHART.splitLine } } },
                { type: 'value', max: 100, axisLabel: { color: CHART.axisLabel, fontSize: 10, formatter: '{value}%' }, splitLine: { show: false } }
            ],
            series: [
                { name: '数量', type: 'bar', data: counts, barWidth: '50%', itemStyle: { color: function(p) { return p.dataIndex < 3 ? CHART.colors.red : p.dataIndex < 6 ? CHART.colors.orange : CHART.axisLine; }, borderRadius: [3, 3, 0, 0] }, label: { show: true, position: 'top', fontSize: 10, color: CHART.legendText } },
                { name: '累计%', type: 'line', yAxisIndex: 1, data: cumData, smooth: false, symbol: 'circle', symbolSize: 5, lineStyle: { color: CHART.colors.orange, width: 2 }, itemStyle: { color: CHART.colors.orange }, markLine: { silent: true, symbol: 'none', lineStyle: { color: CHART.colors.red, type: 'dashed', width: 1 }, data: [{ yAxis: 80, label: { formatter: '80%', color: CHART.colors.red, fontSize: 10 } }] }, markPoint: crossoverIdx >= 0 ? { symbol: 'pin', symbolSize: 46, itemStyle: { color: CHART.colors.red }, label: { formatter: '80%\\n{b}', color: '#fff', fontSize: 9, fontWeight: 700 }, data: [{ coord: [crossoverIdx, cumData[crossoverIdx]], name: names[crossoverIdx].replace(/\.\.\.$/, '') }] } : undefined }
            ]
        }, true);
        chart._drillDim = sorted.map(function (s) { return s.defect; });
    }

    // ========== Process Chart ==========
    function renderProcess(badByProcess) {
        var chart = getOrInit('processChart');
        var data = badByProcess || [];
        if (!data.length) { showEmpty(chart); return; }
        var names = data.map(function(d) { return d.process; }).reverse();
        var counts = data.map(function(d) { return d.count; }).reverse();
        var total = counts.reduce(function(a, b) { return a + b; }, 0);
        chart.setOption({
            tooltip: Object.assign(CHART.tooltip(), { formatter: function(p) { var pct = total > 0 ? (p[0].value / total * 100).toFixed(1) : 0; return p[0].name + '<br/>不良数: ' + p[0].value + ' (' + pct + '%)'; } }),
            grid: { left: 120, right: 60, top: 15, bottom: 15 },
            xAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: CHART.splitLine } }, axisLabel: { color: CHART.axisLabel, fontSize: 10 } },
            yAxis: { type: 'category', data: names, axisLine: { lineStyle: { color: CHART.axisLine } }, axisLabel: { color: CHART.tooltipText, fontSize: 11, width: 110, overflow: 'truncate' } },
            series: [{ type: 'bar', data: counts, barWidth: 20, itemStyle: { color: function(p) { var rank = counts.length - p.dataIndex; return rank <= 3 ? CHART.colors.red : rank <= 6 ? CHART.colors.orange : CHART.colors.blue; }, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: CHART.legendText, fontSize: 11, formatter: function(p) { var pct = total > 0 ? (p.value / total * 100).toFixed(1) : 0; return p.value + ' (' + pct + '%)'; } } }]
        }, true);
    }

    // ========== Line Chart ==========
    function renderLine(badItems) {
        var chart = getOrInit('lineChart');
        var byLine = {};
        badItems.forEach(function(item) { var name = item.lineName || '未知'; byLine[name] = (byLine[name] || 0) + 1; });
        var entries = Object.entries(byLine).sort(function(a, b) { return b[1] - a[1]; });
        if (!entries.length) { showEmpty(chart); return; }
        var names = entries.map(function(e) { return e[0]; }).reverse();
        var counts = entries.map(function(e) { return e[1]; }).reverse();
        var total = counts.reduce(function(a, b) { return a + b; }, 0);
        chart.setOption({
            tooltip: CHART.tooltip(),
            grid: { left: 120, right: 60, top: 15, bottom: 15 },
            xAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: CHART.splitLine } }, axisLabel: { color: CHART.axisLabel, fontSize: 10 } },
            yAxis: { type: 'category', data: names, axisLine: { lineStyle: { color: CHART.axisLine } }, axisLabel: { color: CHART.tooltipText, fontSize: 11, width: 110, overflow: 'truncate' } },
            series: [{ type: 'bar', data: counts, barWidth: 20, itemStyle: { color: function(p) { var rank = counts.length - p.dataIndex; return rank <= 2 ? CHART.colors.red : rank <= 4 ? CHART.colors.orange : CHART.colors.blue; }, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: CHART.legendText, fontSize: 11, formatter: function(p) { var pct = total > 0 ? (p.value / total * 100).toFixed(1) : 0; return p.value + ' (' + pct + '%)'; } } }]
        }, true);
    }

    // ========== Model Chart ==========
    function renderModel(badItems) {
        var chart = getOrInit('modelChart');
        var byModel = {};
        badItems.forEach(function(item) { var name = item.productModel || '未知'; byModel[name] = (byModel[name] || 0) + 1; });
        var entries = Object.entries(byModel).sort(function(a, b) { return b[1] - a[1]; });
        if (!entries.length) { showEmpty(chart); return; }
        var names = entries.map(function(e) { return e[0]; }).reverse();
        var counts = entries.map(function(e) { return e[1]; }).reverse();
        var total = counts.reduce(function(a, b) { return a + b; }, 0);
        chart.setOption({
            tooltip: CHART.tooltip(),
            grid: { left: 120, right: 60, top: 15, bottom: 15 },
            xAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: CHART.splitLine } }, axisLabel: { color: CHART.axisLabel, fontSize: 10 } },
            yAxis: { type: 'category', data: names, axisLine: { lineStyle: { color: CHART.axisLine } }, axisLabel: { color: CHART.tooltipText, fontSize: 11, width: 110, overflow: 'truncate' } },
            series: [{ type: 'bar', data: counts, barWidth: 20, itemStyle: { color: function(p) { var rank = counts.length - p.dataIndex; return rank <= 2 ? CHART.colors.red : rank <= 4 ? CHART.colors.orange : CHART.colors.blue; }, borderRadius: [0, 4, 4, 0] }, label: { show: true, position: 'right', color: CHART.legendText, fontSize: 11, formatter: function(p) { var pct = total > 0 ? (p.value / total * 100).toFixed(1) : 0; return p.value + ' (' + pct + '%)'; } } }]
        }, true);
    }

    // ========== 共享聚合: 按日 TOP 缺陷 (renderTopTrend / renderRank 共用) ==========
    // renderAll 内两者对同一 badItems 重复算 "defectCount + top5 + 按日计数";
    // 抽出 memoize: 同一次 renderAll 内只算一次 (以 badItems 引用为 key 失效)
    var _topAggrKey = null, _topAggrCache = null;
    function computeTopAggregation(badItems) {
        if (_topAggrKey === badItems && _topAggrCache) return _topAggrCache;
        var defectCount = {};
        badItems.forEach(function(item) { var d = item.badItems || '未知'; defectCount[d] = (defectCount[d] || 0) + 1; });
        var top5 = Object.entries(defectCount).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5).map(function(e) { return e[0]; });
        var dayData = {};
        badItems.forEach(function(item) {
            var d = item.badItems || '未知';
            if (top5.indexOf(d) === -1) return;
            if (!item.testTime) return;
            var dt = new Date(item.testTime);
            if (isNaN(dt.getTime())) return;
            var day = localDate(dt);
            if (!dayData[day]) dayData[day] = {};
            dayData[day][d] = (dayData[day][d] || 0) + 1;
        });
        var dates = Object.keys(dayData).sort();
        _topAggrKey = badItems; _topAggrCache = { top5: top5, dayData: dayData, dates: dates };
        return _topAggrCache;
    }

    // ========== TOP Defect Trend ==========
    function renderTopTrend(badItems) {
        var chart = getOrInit('topTrendChart');
        if (!badItems.length) { showEmpty(chart); return; }
        var agg = computeTopAggregation(badItems);
        var top5 = agg.top5, dayDefect = agg.dayData, dates = agg.dates;
        // 数据不足 guard(横展自 renderRank): realtime=1天时 5 条单点折线近乎空白且无提示,
        // 与并列的 rankChart(显"数据不足(需≥2天)")不一致 → 同口径拦截
        if (dates.length < 2) { showEmpty(chart, '数据不足(需≥2天)'); return; }
        var colors = [CHART.colors.red, CHART.colors.orange, CHART.colors.blue, CHART.colors.purple, CHART.colors.green];
        var series = top5.map(function(name, idx) {
            return { name: name.length > 12 ? name.slice(0, 12) + '...' : name, type: 'line', smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2, color: colors[idx] }, itemStyle: { color: colors[idx] }, label: { show: dates.length <= 15, position: 'top', fontSize: 9, color: colors[idx], formatter: function(p) { return p.value > 0 ? p.value : ''; } }, data: dates.map(function(day) { return (dayDefect[day] && dayDefect[day][name]) || 0; }) };
        });
        chart.setOption({
            tooltip: CHART.tooltip(),
            legend: { top: 0, textStyle: { color: CHART.legendText, fontSize: 11 }, type: 'scroll' },
            grid: { top: 40, bottom: 30, left: 50, right: 30 },
            xAxis: CHART.xAxis(dates),
            yAxis: { type: 'value', name: '数量', axisLabel: { color: CHART.axisLabel, fontSize: 10 }, splitLine: { lineStyle: { color: CHART.splitLine } } },
            series: series
        }, true);
    }

    // ========== Heatmap ==========
    function renderHeatmap(badItems) {
        var chart = getOrInit('heatmapChart');
        if (!badItems.length) { showEmpty(chart); return; }
        var procCount = {}, defCount = {};
        badItems.forEach(function(item) { var p = item.workOprationName || '未知', d = item.badItems || '未知'; procCount[p] = (procCount[p] || 0) + 1; defCount[d] = (defCount[d] || 0) + 1; });
        var topProcs = Object.entries(procCount).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10).map(function(e) { return e[0]; });
        var topDefs = Object.entries(defCount).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10).map(function(e) { return e[0]; });
        var matrix = {};
        badItems.forEach(function(item) {
            var p = item.workOprationName || '未知', d = item.badItems || '未知';
            if (topProcs.indexOf(p) === -1 || topDefs.indexOf(d) === -1) return;
            var key = p + '|||' + d;
            matrix[key] = (matrix[key] || 0) + 1;
        });
        var data = [], maxVal = 0;
        topDefs.forEach(function(d, xi) {
            topProcs.forEach(function(p, yi) {
                var v = matrix[p + '|||' + d] || 0;
                data.push([xi, yi, v]);
                if (v > maxVal) maxVal = v;
            });
        });
        var defLabels = topDefs.map(function(d) { return d.length > 8 ? d.slice(0, 8) + '..' : d; });
        var procLabels = topProcs.map(function(p) { return p.length > 8 ? p.slice(0, 8) + '..' : p; });
        chart.setOption({
            tooltip: Object.assign(CHART.tooltip(), { trigger: 'item', formatter: function(p) { return '<b>' + topProcs[p.value[1]] + '</b><br/>' + topDefs[p.value[0]] + ': <b>' + p.value[2] + '</b> 件'; } }),
            grid: { top: 10, bottom: 100, left: 100, right: 40 },
            xAxis: { type: 'category', data: defLabels, axisLabel: { color: CHART.legendText, fontSize: 10, rotate: 40, interval: 0 }, axisLine: { lineStyle: { color: CHART.axisLine } }, splitArea: { show: true, areaStyle: { color: ['rgba(15,23,42,0.6)', 'rgba(30,41,59,0.6)'] } } },
            yAxis: { type: 'category', data: procLabels, axisLabel: { color: CHART.legendText, fontSize: 11 }, axisLine: { lineStyle: { color: CHART.axisLine } }, splitArea: { show: true, areaStyle: { color: ['rgba(15,23,42,0.6)', 'rgba(30,41,59,0.6)'] } } },
            visualMap: { min: 0, max: maxVal || 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 5, textStyle: { color: CHART.legendText }, inRange: { color: [CHART.tooltipBg, CHART.colors.cyan, CHART.colors.blue, CHART.colors.orange, CHART.colors.red] } },
            series: [{ type: 'heatmap', data: data, label: { show: true, color: CHART.tooltipText, fontSize: 10, formatter: function(p) { return p.value[2] || ''; } }, emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } } }]
        }, true);
    }

    // ========== Rank Change ==========
    function renderRank(badItems) {
        var chart = getOrInit('rankChart');
        if (!badItems.length) { showEmpty(chart); return; }
        var agg = computeTopAggregation(badItems);
        var top5 = agg.top5, dayData = agg.dayData, dates = agg.dates;
        if (dates.length < 2) { showEmpty(chart, '数据不足(需≥2天)'); return; }
        var rankings = {};
        top5.forEach(function(name) { rankings[name] = []; });
        dates.forEach(function(day) {
            var dayCounts = top5.map(function(name) { return { name: name, count: (dayData[day] && dayData[day][name]) || 0 }; });
            dayCounts.sort(function(a, b) { return b.count - a.count; });
            dayCounts.forEach(function(item, idx) { rankings[item.name].push(idx + 1); });
        });
        var colors = [CHART.colors.red, CHART.colors.orange, CHART.colors.blue, CHART.colors.purple, CHART.colors.green];
        var series = top5.map(function(name, idx) {
            return { name: name.length > 12 ? name.slice(0, 12) + '...' : name, type: 'line', smooth: true, symbol: 'circle', symbolSize: 8, lineStyle: { width: 3, color: colors[idx] }, itemStyle: { color: colors[idx] }, label: { show: dates.length <= 20, position: 'top', fontSize: 10, color: colors[idx], formatter: function(p) { return '第' + p.value + '名'; } }, data: rankings[name] };
        });
        chart.setOption({
            tooltip: Object.assign(CHART.tooltip(), { formatter: function(params) { var tip = params[0].axisValue + '<br/>'; params.sort(function(a, b) { return a.value - b.value; }); params.forEach(function(p) { tip += p.marker + p.seriesName + ': 第' + p.value + '名<br/>'; }); return tip; } }),
            legend: { top: 0, textStyle: { color: CHART.legendText, fontSize: 11 }, type: 'scroll' },
            grid: { top: 40, bottom: 30, left: 50, right: 30 },
            xAxis: CHART.xAxis(dates),
            yAxis: { type: 'value', name: '排名', inverse: true, min: 1, max: 5, interval: 1, axisLabel: { color: CHART.axisLabel, fontSize: 10, formatter: '第{value}名' }, splitLine: { lineStyle: { color: CHART.splitLine } } },
            series: series
        }, true);
    }

    return {
        rateColor: rateColor,
        resizeAll: resizeAll,
        renderLiquidKPI: renderLiquidKPI,
        renderTrend: renderTrend,
        renderPareto: renderPareto,
        renderProcess: renderProcess,
        renderLine: renderLine,
        renderModel: renderModel,
        renderTopTrend: renderTopTrend,
        renderHeatmap: renderHeatmap,
        renderRank: renderRank,
        bindAllDrill: bindAllDrill
    };
})();
