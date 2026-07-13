/**
 * bad-ai.js — AI智能分析面板 + 关联分析
 */
var BadAI = (function() {
    var _esc = typeof escHtml === 'function' ? escHtml : function(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

    function renderInsights(aiData) {
        var el = document.getElementById('aiInsightsPanel');
        if (!el) return;
        if (!aiData || !aiData.insights || !aiData.insights.length) {
            el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:10px;">暂无分析结果</div>';
            return;
        }
        var levelIcons = { danger: '🔴', warning: '🟡', success: '🟢', info: '🔵' };
        var levelColors = { danger: CHART.colors.red, warning: CHART.colors.orange, success: CHART.colors.green, info: CHART.colors.blue };
        /* danger/warning 级卡片呼吸光 (box-shadow 脉冲), 由 ATTN.setFocusState/sev-* 统一调度;
           入场用 badSlideIn; 呼吸 keyframes 保留在 bad.html, 受 prefers-reduced-motion 守护 */
        var breatheClass = { danger: 'sev-danger', warning: 'sev-warn' };
        var html = aiData.insights.map(function(insight, idx) {
            var icon = levelIcons[insight.level] || '🔵';
            var color = levelColors[insight.level] || CHART.colors.blue;
            var breathCls = breatheClass[insight.level] || '';
            return '<div class="ai-insight-card ' + breathCls + '" style="padding:10px 12px;border-left:3px solid ' + color + ';background:rgba(15,23,42,0.5);border-radius:4px;margin-bottom:8px;animation:badSlideIn 0.5s var(--ease-out) forwards;animation-delay:' + (idx * 80) + 'ms;">' +
                '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
                '<span style="font-size:14px;">' + icon + '</span>' +
                '<span style="font-size:13px;color:var(--text-primary);font-weight:600;">' + _esc(insight.title) + '</span>' +
                '</div>' +
                '<div style="font-size:12px;color:var(--text-secondary);margin-left:22px;">' + _esc(insight.detail) + '</div>' +
                (insight.suggestion ? '<div style="font-size:11px;color:var(--brand);margin-left:22px;margin-top:4px;">💡 ' + _esc(insight.suggestion) + '</div>' : '') +
                '</div>';
        }).join('');
        el.innerHTML = html;
    }

    function renderCorrelation(corrData) {
        var el = document.getElementById('correlationPanel');
        if (!el) return;
        if (!corrData || !corrData.success) {
            el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:10px;">暂无关联数据</div>';
            return;
        }
        var html = '';

        // Repeat SN section
        if (corrData.repeatSN && corrData.repeatSN.length > 0) {
            html += '<div class="corr-block" style="margin-bottom:12px;animation-delay:0ms;">';
            html += '<div style="font-size:12px;color:var(--warning);font-weight:600;margin-bottom:6px;">🔄 重复不良条码 TOP10</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
            html += '<thead><tr><th style="text-align:left;color:var(--text-muted);padding:4px 6px;">条码</th><th style="text-align:center;color:var(--text-muted);padding:4px 6px;">次数</th><th style="text-align:left;color:var(--text-muted);padding:4px 6px;">不良项</th></tr></thead><tbody>';
            corrData.repeatSN.slice(0, 10).forEach(function(sn) {
                html += '<tr><td style="padding:3px 6px;color:var(--text-secondary);font-family:Consolas,monospace;font-size:10px;">' + _esc(sn.barcode || '-') + '</td>';
                html += '<td style="text-align:center;padding:3px 6px;color:var(--danger);font-weight:600;">' + sn.count + '</td>';
                html += '<td style="padding:3px 6px;color:var(--text-secondary);">' + _esc((sn.defects || []).join(', ')) + '</td></tr>';
            });
            html += '</tbody></table></div>';
        }

        // Time pattern section
        if (corrData.byHour && corrData.byHour.length > 0) {
            html += '<div class="corr-block" style="margin-bottom:12px;animation-delay:90ms;">';
            html += '<div style="font-size:12px;color:var(--brand);font-weight:600;margin-bottom:6px;">⏰ 时段不良高发 TOP5</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
            html += '<thead><tr><th style="text-align:left;color:var(--text-muted);padding:4px 6px;">时段</th><th style="text-align:left;color:var(--text-muted);padding:4px 6px;">不良项</th><th style="text-align:center;color:var(--text-muted);padding:4px 6px;">次数</th></tr></thead><tbody>';
            corrData.byHour.slice(0, 5).forEach(function(h) {
                html += '<tr><td style="padding:3px 6px;color:var(--text-primary);">' + h.hour + ':00</td>';
                html += '<td style="padding:3px 6px;color:var(--text-secondary);">' + _esc(h.defect || '-') + '</td>';
                html += '<td style="text-align:center;padding:3px 6px;color:var(--warning);">' + h.count + '</td></tr>';
            });
            html += '</tbody></table></div>';
        }

        // Line-Defect section
        if (corrData.byLineDefect && corrData.byLineDefect.length > 0) {
            html += '<div class="corr-block" style="animation-delay:180ms;">';
            html += '<div style="font-size:12px;color:var(--purple);font-weight:600;margin-bottom:6px;">🏭 线体×不良 TOP5</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
            html += '<thead><tr><th style="text-align:left;color:var(--text-muted);padding:4px 6px;">线体</th><th style="text-align:left;color:var(--text-muted);padding:4px 6px;">不良项</th><th style="text-align:center;color:var(--text-muted);padding:4px 6px;">次数</th></tr></thead><tbody>';
            corrData.byLineDefect.slice(0, 5).forEach(function(ld) {
                html += '<tr><td style="padding:3px 6px;color:var(--text-primary);">' + _esc(ld.line || '-') + '</td>';
                html += '<td style="padding:3px 6px;color:var(--text-secondary);">' + _esc(ld.defect || '-') + '</td>';
                html += '<td style="text-align:center;padding:3px 6px;color:var(--purple);">' + ld.count + '</td></tr>';
            });
            html += '</tbody></table></div>';
        }

        el.innerHTML = html || '<div style="color:var(--text-muted);font-size:12px;padding:10px;">暂无关联数据</div>';
    }

    function renderCompare(summary) {
        // 优先写入 #compareContent(保留面板标题), 兼容直接写 #comparePanel
        var el = document.getElementById('compareContent') || document.getElementById('comparePanel');
        if (!el) return;
        if (!summary || !summary.compare) {
            el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:10px;">暂无环比数据</div>';
            return;
        }
        var cmp = summary.compare;
        var html = '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">';
        html += compareCard('直通率', summary.fpy != null ? summary.fpy + '%' : '--', cmp.fpyDelta, true);
        html += compareCard('不良率', summary.badRate != null ? summary.badRate + '%' : '--', cmp.badRateDelta, false);
        html += compareCard('不良总数', summary.badTotal != null ? summary.badTotal : '--', summary.badTotal != null && cmp.prevBadTotal != null ? summary.badTotal - cmp.prevBadTotal : null, false);
        html += compareCard('闭环率', summary.closureRate != null ? summary.closureRate + '%' : '--', cmp.closureRateDelta, true);
        html += '</div>';
        el.innerHTML = html;
    }

    function compareCard(title, value, delta, positiveIsGood) {
        var deltaStr = '', deltaColor = 'var(--text-muted)';
        if (delta != null && delta !== 0) {
            var isPositive = delta > 0;
            var isGood = positiveIsGood ? isPositive : !isPositive;
            deltaColor = isGood ? 'var(--success)' : 'var(--danger)';
            deltaStr = (isPositive ? '↑' : '↓') + Math.abs(delta).toFixed(2);
        }
        return '<div style="background:rgba(15,23,42,0.6);border-radius:var(--radius);padding:8px 10px;">' +
            '<div style="font-size:11px;color:var(--text-muted);">' + title + '</div>' +
            '<div style="font-size:16px;font-weight:700;color:var(--text-primary);font-family:var(--font-mono);">' + value + '</div>' +
            (deltaStr ? '<div style="font-size:11px;color:' + deltaColor + ';">vs前期 ' + deltaStr + '</div>' : '<div style="font-size:11px;color:var(--text-muted);">--</div>') +
            '</div>';
    }

    return {
        renderInsights: renderInsights,
        renderCorrelation: renderCorrelation,
        renderCompare: renderCompare
    };
})();
