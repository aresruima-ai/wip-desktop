/**
 * bad-table.js — 明细表、分页、排序、导出
 */
var BadTable = (function() {
    var _esc = typeof escHtml === 'function' ? escHtml : function(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    var sortCol = '', sortDir = '';
    var page = 1;
    var pageSize = 50;
    var _seenBarcodes = new Set(); // 跨渲染累积已展示过的条码, 新条码首次出现时高亮

    function getPage() { return page; }
    function setPage(p) { page = p; }
    function getPageSize() { return pageSize; }
    function setPageSize(s) { pageSize = s; page = 1; }

    // 周期切换/数据刷新后清空已见条码集合, 确保新周期首屏新条码仍触发 row-new 高亮
    function resetSeen() { _seenBarcodes = new Set(); }

    function sort(col) {
        if (sortCol === col) { sortDir = sortDir === 'asc' ? 'desc' : sortDir === 'desc' ? '' : 'asc'; }
        else { sortCol = col; sortDir = 'asc'; }
        // 更新所有可排序表头(th[role=button]): 清 asc/desc + aria-sort 重置为 none
        var heads = document.querySelectorAll('th[role="button"]');
        heads.forEach(function(th) { th.classList.remove('asc', 'desc'); th.setAttribute('aria-sort', 'none'); });
        // 标记当前列(通过 onclick 含 col 匹配), 设 asc/desc 类 + aria-sort
        if (sortDir) {
            for (var i = 0; i < heads.length; i++) {
                if ((heads[i].getAttribute('onclick') || '').indexOf("sortTable('" + col + "')") >= 0) {
                    heads[i].classList.add(sortDir);
                    heads[i].setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
                    break;
                }
            }
        }
    }

    function render(items) {
        var sorted = items.slice();
        if (sortCol && sortDir) {
            sorted.sort(function(a, b) {
                var va = (a[sortCol] || '').toString(), vb = (b[sortCol] || '').toString();
                var cmp = va.localeCompare(vb, 'zh');
                return sortDir === 'desc' ? -cmp : cmp;
            });
        }
        var totalItems = sorted.length;
        var totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        if (page > totalPages) page = totalPages;
        var start = (page - 1) * pageSize;
        var pageItems = sorted.slice(start, start + pageSize);

        document.getElementById('tableInfo').textContent = '共 ' + totalItems + ' 条';
        var tbody = document.getElementById('detailBody');
        if (!pageItems.length) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:30px;">暂无数据</td></tr>';
        } else {
            tbody.innerHTML = pageItems.map(function(item) {
                var stateCode = parseInt(item.repairStateCode) || 0;
                var stateLabel = stateCode === 20 ? '<span class="badge closed">已闭环</span>' : '<span class="badge open">待处理</span>';
                var time = item.testTime ? new Date(item.testTime).toLocaleString('zh-CN', { hour12: false }) : '';
                /* 新条码首次出现时高亮一闪 (仅在当前页可见项上) */
                var isNew = item.barcode && !_seenBarcodes.has(item.barcode);
                if (item.barcode) _seenBarcodes.add(item.barcode);
                return '<tr' + (isNew ? ' class="row-new"' : '') + '>' +
                    '<td style="font-family:Consolas,monospace;font-size:11px;">' + _esc(item.barcode || '-') + '</td>' +
                    '<td>' + _esc(item.lineName || '-') + '</td>' +
                    '<td>' + _esc(item.productModel || '-') + '</td>' +
                    '<td>' + _esc(item.workOprationName || '-') + '</td>' +
                    '<td style="color:var(--danger)">' + _esc(item.badItems || '-') + '</td>' +
                    '<td>' + _esc(item.categoryName || '-') + '</td>' +
                    '<td>' + _esc(item.contentName || '-') + '</td>' +
                    '<td>' + _esc(item.causesName || '-') + '</td>' +
                    '<td>' + _esc(item.repairMan || '-') + '</td>' +
                    '<td>' + _esc(item.moLotNo || '-') + '</td>' +
                    '<td>' + stateLabel + '</td>' +
                    '<td style="font-size:11px;color:var(--text-secondary)">' + time + '</td>' +
                    '</tr>';
            }).join('');
        }

        // Pagination
        var pagEl = document.getElementById('pagination');
        if (totalPages <= 1) { pagEl.innerHTML = ''; return; }
        var html = '<button onclick="BadTable.goPage(1)" ' + (page <= 1 ? 'disabled' : '') + '>&laquo;</button>';
        html += '<button onclick="BadTable.goPage(' + (page - 1) + ')" ' + (page <= 1 ? 'disabled' : '') + '>&lsaquo;</button>';
        html += '<span class="current">' + page + ' / ' + totalPages + '</span>';
        html += '<button onclick="BadTable.goPage(' + (page + 1) + ')" ' + (page >= totalPages ? 'disabled' : '') + '>&rsaquo;</button>';
        html += '<button onclick="BadTable.goPage(' + totalPages + ')" ' + (page >= totalPages ? 'disabled' : '') + '>&raquo;</button>';
        pagEl.innerHTML = html;
    }

    function goPage(n) {
        var state = BadCore.getState();
        var totalPages = Math.max(1, Math.ceil((state.badItems || []).length / pageSize));
        page = Math.max(1, Math.min(n, totalPages));
        render(state.badItems);
    }

    function exportCSV() {
        var items = BadCore.getState().badItems || [];
        var header = '条码,线体,型号,工序,不良项,不良类别,维修内容,原因,维修人,批次号,状态,时间\n';
        var rows = items.map(function(i) {
            var state = (parseInt(i.repairStateCode) || 0) === 20 ? '已闭环' : '待处理';
            var time = i.testTime ? new Date(i.testTime).toLocaleString('zh-CN', { hour12: false }) : '';
            return [i.barcode, i.lineName, i.productModel, i.workOprationName, i.badItems, i.categoryName || '', i.contentName, i.causesName || '', i.repairMan || '', i.moLotNo || '', state, time].map(function(v) { return '"' + (v || '').replace(/"/g, '""') + '"'; }).join(',');
        }).join('\n');
        var blob = new Blob(['﻿' + header + rows], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        // FilterBar 无 dateFrom 输入(日期由 WipUI.periodRange 管理), 改用 _currentRange.dateFrom
        var dateTag = (window._currentRange && _currentRange.dateFrom) ? _currentRange.dateFrom : '';
        a.download = '不良明细_' + dateTag + '.csv';
        a.click();
    }

    return {
        sort: sort,
        render: render,
        goPage: goPage,
        exportCSV: exportCSV,
        getPage: getPage,
        setPage: setPage,
        getPageSize: getPageSize,
        setPageSize: setPageSize,
        resetSeen: resetSeen
    };
})();
