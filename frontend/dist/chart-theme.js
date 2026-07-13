/**
 * chart-theme.js — 全站统一 ECharts 配色模块
 *
 * 从 CSS 变量读取设计 Token，消除所有页面里 ~300 处硬编码颜色。
 * 所有页面统一引用此模块，主题切换时自动响应。
 *
 * 使用方式：
 *   <script src="chart-theme.js"></script>
 *   然后直接用 CHART.tooltip() / CHART.xAxis() / CHART.colors.blue 等
 */

var CHART = (function() {
    'use strict';

    var root = document.documentElement;
    var cs = getComputedStyle(root);

    // ===== 从 CSS 变量读取颜色 =====
    function read(name) {
        return cs.getPropertyValue(name).trim();
    }

    // 颜色→rgba: 支持 #hex / rgb() / rgba() 输入, 供渐变配色统一使用
    // (原 gradientBar/areaGradient 假设输入为 rgb() 格式, 但 token 读取后多为 #hex, 会导致渐变生成失败静默回退)
    function toRgba(color, alpha) {
        if (!color) return 'rgba(255,255,255,' + (alpha != null ? alpha : 1) + ')';
        color = String(color).trim();
        var a = alpha != null ? alpha : 1;
        // 已是 rgba/rgb
        var m = color.match(/^rgba?\(([^)]+)\)$/i);
        if (m) {
            var p = m[1].split(',').map(function(x){ return x.trim(); });
            var r = p[0], g = p[1], b = p[2];
            return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }
        // #hex (#rgb / #rrggbb)
        var h = color.replace('#', '');
        if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(function(c){ return c + c; }).join('');
        if (/^[0-9a-f]{6}$/i.test(h)) {
            var n = parseInt(h, 16);
            return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
        }
        // 兜底: 不识别的颜色原样返回(纯色比无效渐变更安全)
        return color;
    }

    // 基础颜色 (SIGMA v3.0)
    var bgPanel     = read('--bg-panel')       || '#0d1117';
    var bgInput     = read('--bg-input')       || '#1c2433';
    var textPrimary = read('--text-primary')   || '#eef0f3';
    var textSecond  = read('--text-secondary') || '#8b97a8';
    var textMuted   = read('--text-muted')     || '#5d6a7c';
    var border      = read('--border')         || 'rgba(255,255,255,0.10)';
    var line        = read('--line')           || 'rgba(255,255,255,0.10)';
    var accentBlue  = read('--brand')          || '#0166B1';
    var accentGreen = read('--success')        || '#10b981';
    var accentOrange= read('--warning')        || '#f59e0b';
    var accentRed   = read('--danger')         || '#ef4444';
    var accentPurple= read('--purple')         || '#a78bfa';
    var accentCyan  = read('--accent-cyan')    || '#22d3ee';

    // 派生的图表专用色（从 Token 导出，保持与暗色主题一致）
    var chartBg       = bgInput;                      // 图表内底色
    var axisLabel     = textMuted;                    // 轴标签
    var axisLine      = border;                       // 轴线
    var splitLine     = 'rgba(51,65,85,0.40)';       // 分割线（比 border 略重）
    var tooltipBg     = bgPanel;                      // tooltip 背景
    var tooltipBorder = border;                       // tooltip 边框
    var tooltipText   = textPrimary;                  // tooltip 文字
    var legendText    = textSecond;                   // 图例文字
    var emptyText     = textMuted;                    // 空状态文字

    // 语义色别名
    var KPI_GOOD    = accentGreen;
    var KPI_WARN    = accentOrange;
    var KPI_BAD     = accentRed;

    // ===== 配色调色盘 =====
    // 多系列图表用，优先用 accent-* 再扩展
    var palette6 = [accentBlue, accentGreen, accentOrange, accentRed, accentPurple, accentCyan];
    // paletteLight 已删除: 内容与 palette6 完全重复(死代码), 统一用 palette/palette6

    // colors: 数组(支持 colors[0..5] 索引) + 命名属性(支持 colors.blue) 双兼容
    var colors = [accentBlue, accentGreen, accentOrange, accentRed, accentPurple, accentCyan];
    colors.blue = accentBlue; colors.green = accentGreen; colors.orange = accentOrange;
    colors.red = accentRed; colors.purple = accentPurple; colors.cyan = accentCyan;
    colors.good = KPI_GOOD; colors.warn = KPI_WARN; colors.bad = KPI_BAD;

    // ===== KPI 阈值颜色 =====
    function rateColor(v, thresholds) {
        // thresholds: { good: 95, warn: 90 } — >=good 绿, >=warn 黄, else 红
        var t = thresholds || { good: 85, warn: 70 };
        return v >= t.good ? accentGreen : v >= t.warn ? accentOrange : accentRed;
    }

    // ===== ECharts 配置片段工厂 =====
    function tooltip(opts) {
        return {
            trigger: 'axis',
            backgroundColor: tooltipBg,
            borderColor: tooltipBorder,
            textStyle: { color: tooltipText, fontSize: (opts && opts.fontSize) || 12 },
            padding: [3, 7],
            confine: true,
            extraCssText: 'box-shadow:0 4px 12px rgba(0,0,0,0.35);border-radius:5px;max-width:280px;word-break:break-word;'
        };
    }

    function legend(opts) {
        return {
            top: (opts && opts.top !== undefined) ? opts.top : 0,
            right: (opts && opts.right !== undefined) ? opts.right : 0,
            textStyle: { color: legendText, fontSize: (opts && opts.fontSize) || 11 },
            itemWidth: (opts && opts.itemWidth) || 14,
            itemHeight: (opts && opts.itemHeight) || 8
        };
    }

    function xAxis(data, opts) {
        return {
            type: 'category',
            data: data,
            axisLabel: {
                color: axisLabel,
                fontSize: (opts && opts.fontSize) || 10,
                rotate: (opts && opts.rotate) || 0,
                interval: (opts && opts.interval !== undefined) ? opts.interval : 'auto'
            },
            axisLine: { lineStyle: { color: axisLine } },
            axisTick: { show: false }
        };
    }

    function yAxis(opts) {
        return {
            type: 'value',
            axisLabel: {
                color: axisLabel,
                fontSize: (opts && opts.fontSize) || 10,
                formatter: (opts && opts.formatter) || undefined
            },
            splitLine: { lineStyle: { color: splitLine } },
            axisLine: { show: false }
        };
    }

    function yAxisPercent() {
        return yAxis({ formatter: '{value}%' });
    }

    function emptyState(msg) {
        return {
            title: {
                text: msg || '暂无数据',
                left: 'center',
                top: 'center',
                textStyle: { color: emptyText, fontSize: 13 }
            },
            series: []
        };
    }

    function grid(opts) {
        return {
            top: (opts && opts.top !== undefined) ? opts.top : 50,
            bottom: (opts && opts.bottom !== undefined) ? opts.bottom : 30,
            left: (opts && opts.left !== undefined) ? opts.left : 60,
            right: (opts && opts.right !== undefined) ? opts.right : 60
        };
    }

    // 常用系列样式
    function lineSeries(name, data, color, opts) {
        return {
            name: name,
            type: 'line',
            data: data,
            smooth: true,
            symbol: (opts && opts.symbol) || 'circle',
            symbolSize: (opts && opts.symbolSize) || 4,
            lineStyle: { width: (opts && opts.width) || 2.5, color: color },
            itemStyle: { color: color },
            label: (opts && opts.label !== undefined) ? opts.label :
                { show: true, position: 'top', color: legendText, fontSize: 10, formatter: function(p) { return p.value != null ? p.value : ''; } }
        };
    }

    function barSeries(name, data, color, opts) {
        return {
            name: name,
            type: 'bar',
            data: data,
            barMaxWidth: (opts && opts.barMaxWidth) || 20,
            itemStyle: { color: color, borderRadius: (opts && opts.borderRadius) || [2, 2, 0, 0] },
            label: (opts && opts.label !== undefined) ? opts.label :
                { show: true, position: 'top', color: legendText, fontSize: 10 }
        };
    }

    function dashedTargetLine(name, data, targetColor) {
        return {
            name: name,
            type: 'line',
            data: data,
            symbol: 'none',
            lineStyle: { width: 1.5, color: targetColor || accentOrange, type: 'dashed' },
            tooltip: { show: false }
        };
    }

    // 渐变系列色（常用于柱状图立体感）
    function gradientBar(echarts, colorTop, colorBottom) {
        return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: colorTop },
            { offset: 1, color: colorBottom || toRgba(colorTop, 0.3) }
        ]);
    }

    // 面积渐变（常用于折线图下方）
    function areaGradient(echarts, color, alphaTop, alphaBottom) {
        return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: toRgba(color, alphaTop != null ? alphaTop : 0.22) },
            { offset: 1, color: toRgba(color, alphaBottom != null ? alphaBottom : 0) }
        ]);
    }

    // ===== 导出 =====
    var CHART = {
        // 基础 Token
        bg:         chartBg,
        axisLabel:  axisLabel,
        axisLine:   axisLine,
        splitLine:  splitLine,
        tooltipBg:  tooltipBg,
        tooltipBorder: tooltipBorder,
        tooltipText: tooltipText,
        legendText: legendText,
        emptyText:  emptyText,

        // 语义色（数组+命名双兼容：colors[0..5] 索引 与 colors.blue 命名 均可用）
        colors: colors,
        textColor: axisLabel,   // 兼容别名（旧代码 CHART.textColor → axisLabel）

        palette:   palette6,
        palette6:  palette6,

        // 工具函数
        rateColor: rateColor,
        tooltip:   tooltip,
        legend:    legend,
        xAxis:     xAxis,
        yAxis:     yAxis,
        yAxisPercent: yAxisPercent,
        emptyState: emptyState,
        grid:      grid,
        lineSeries: lineSeries,
        barSeries: barSeries,
        dashedTargetLine: dashedTargetLine,
        gradientBar: gradientBar,
        areaGradient: areaGradient,

        // 主题刷新（主题切换后调用，直接更新导出对象）
        refresh: function() {
            cs = getComputedStyle(root);
            var ap = read('--bg-panel')       || '#0d1117';
            var ai = read('--bg-input')       || '#1c2433';
            var tp = read('--text-primary')   || '#eef0f3';
            var ts = read('--text-secondary') || '#8b97a8';
            var tm = read('--text-muted')     || '#5d6a7c';
            var bd = read('--border')         || 'rgba(255,255,255,0.10)';
            var ab = read('--brand')          || '#0166B1';
            var ag = read('--success')        || '#10b981';
            var ao = read('--warning')        || '#f59e0b';
            var ar = read('--danger')         || '#ef4444';
            var ap2= read('--purple')         || '#a78bfa';
            var ac = read('--accent-cyan')    || '#22d3ee';

            CHART.bg            = ai;
            CHART.axisLabel     = tm;
            CHART.axisLine      = bd;
            CHART.splitLine     = 'rgba(51,65,85,0.40)';
            CHART.tooltipBg     = ap;
            CHART.tooltipBorder = bd;
            CHART.tooltipText   = tp;
            CHART.legendText    = ts;
            CHART.emptyText     = tm;
            CHART.colors[0] = ab; CHART.colors.blue   = ab;
            CHART.colors[1] = ag; CHART.colors.green  = ag;
            CHART.colors[2] = ao; CHART.colors.orange = ao;
            CHART.colors[3] = ar; CHART.colors.red    = ar;
            CHART.colors[4] = ap2; CHART.colors.purple = ap2;
            CHART.colors[5] = ac; CHART.colors.cyan   = ac;
            CHART.colors.good   = ag;
            CHART.colors.warn   = ao;
            CHART.colors.bad    = ar;
            CHART.textColor     = tm;   // 兼容别名同步
            CHART.palette       = [ab, ag, ao, ar, ap2, ac];
            CHART.palette6      = [ab, ag, ao, ar, ap2, ac];
        }
    };

    return CHART;
})();
