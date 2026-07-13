/**
 * detail-table.js — 通用明细表(3 级下钻 L3 全屏明细页用)
 * 从 bad-table.js 解耦:不依赖 BadCore,columns/items 传参,DOM id 可配
 * 支持:排序(三态)/分页/导出CSV/行点击(事件委托)
 * 用法:
 *   DetailTable.mount({ tbodyId, theadId, paginationId, infoId, columns, pageSize, onRowClick })
 *   DetailTable.setItems(items)
 *   DetailTable.exportCSV(filename)
 */
var DetailTable = (function () {
  var _esc = typeof escHtml === 'function' ? escHtml : function (s) {
    var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML;
  };
  var _columns = [], _items = [], _pageItems = [];
  var _sortCol = '', _sortDir = '', _page = 1, _pageSize = 50;
  var _tbody, _pag, _info, _thead, _onRowClick;
  // 服务端分页: _serverPaging=true 时, _items 即当前页数据, _total 由 setTotal 设定, goPage 触发 onPageChange
  var _serverPaging = false, _total = 0, _onPageChange = null;

  function mount(opts) {
    opts = opts || {};
    _tbody = document.getElementById(opts.tbodyId || 'detailBody');
    _pag = document.getElementById(opts.paginationId || 'pagination');
    _info = document.getElementById(opts.infoId || 'tableInfo');
    _thead = document.getElementById(opts.theadId || 'detailHead');
    _pageSize = opts.pageSize || 50;
    _onRowClick = opts.onRowClick;
    _onPageChange = opts.onPageChange || null;
    _serverPaging = !!opts.serverPaging;
    _columns = opts.columns || [];
    renderHead();
    // 行点击委托(仅绑一次)
    if (_tbody && !_tbody.__dtBound) {
      _tbody.__dtBound = true;
      _tbody.addEventListener('click', function (e) {
        if (!_onRowClick) return;
        var tr = e.target.closest('tr[data-idx]');
        if (!tr) return;
        var idx = parseInt(tr.getAttribute('data-idx'), 10);
        if (_pageItems[idx]) _onRowClick(_pageItems[idx]);
      });
      _tbody.addEventListener('keydown', function (e) {
        if (!_onRowClick) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var tr = e.target.closest('tr[data-idx]');
        if (!tr) return;
        e.preventDefault();
        var idx = parseInt(tr.getAttribute('data-idx'), 10);
        if (_pageItems[idx]) _onRowClick(_pageItems[idx]);
      });
    }
  }

  function setColumns(cols) { _columns = cols || []; renderHead(); }
  function setItems(items, opts) {
    _items = items || [];
    // 服务端分页: items 即当前页; setItems 时回到第1页(除非显式保留 page)
    if (_serverPaging) {
      if (!opts || opts.keepPage !== true) _page = 1;
      if (opts && opts.total != null) _total = +opts.total || 0;
      renderServer();
      return;
    }
    _page = 1; _sortCol = ''; _sortDir = ''; renderHead(); render();
  }
  // 服务端分页: 设总数(单独 setter, 便于 setItems 后补传)
  function setTotal(total) { _total = +total || 0; if (_serverPaging) renderServer(); }
  function getItems() { return _items; }
  function getPage() { return _page; }
  function getPageSize() { return _pageSize; }

  function renderHead() {
    if (!_thead) return;
    if (!_columns.length) { _thead.innerHTML = ''; return; }
    _thead.innerHTML = _columns.map(function (c) {
      var sortable = c.sortable !== false
        ? ' role="button" tabindex="0" aria-sort="none" onclick="DetailTable.sort(\'' + c.key + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();DetailTable.sort(\'' + c.key + '\');}"'
        : '';
      return '<th' + sortable + ' data-col="' + c.key + '"' + (c.width ? ' style="width:' + c.width + '"' : '') + '>' + _esc(c.label) + '</th>';
    }).join('');
  }

  function sort(col) {
    // 服务端分页: 排序应由服务端负责, 客户端单页排序会失真 → 忽略(避免误导)
    if (_serverPaging) return;
    if (_sortCol === col) { _sortDir = _sortDir === 'asc' ? 'desc' : _sortDir === 'desc' ? '' : 'asc'; }
    else { _sortCol = col; _sortDir = 'asc'; }
    if (_thead) {
      var ths = _thead.querySelectorAll('th');
      for (var i = 0; i < ths.length; i++) { ths[i].classList.remove('asc', 'desc'); ths[i].setAttribute('aria-sort', 'none'); }
      if (_sortDir) {
        var cur = _thead.querySelector('th[data-col="' + col + '"]');
        if (cur) { cur.classList.add(_sortDir); cur.setAttribute('aria-sort', _sortDir === 'asc' ? 'ascending' : 'descending'); }
      }
    }
    _page = 1;
    render();
  }

  function render() {
    var sorted = _items.slice();
    if (_sortCol && _sortDir) {
      sorted.sort(function (a, b) {
        var va = a[_sortCol], vb = b[_sortCol];
        if (va == null) va = ''; if (vb == null) vb = '';
        var na = parseFloat(va), nb = parseFloat(vb);
        var bothNum = !isNaN(na) && !isNaN(nb) && isFinite(va) && isFinite(vb);
        var cmp = bothNum ? (na - nb) : String(va).localeCompare(String(vb), 'zh');
        return _sortDir === 'desc' ? -cmp : cmp;
      });
    }
    var total = sorted.length;
    var totalPages = Math.max(1, Math.ceil(total / _pageSize));
    if (_page > totalPages) _page = totalPages;
    var start = (_page - 1) * _pageSize;
    _pageItems = sorted.slice(start, start + _pageSize);

    if (_info) _info.textContent = '共 ' + total + ' 条';
    if (!_tbody) return;
    if (!_pageItems.length) {
      _tbody.innerHTML = '<tr><td colspan="' + Math.max(_columns.length, 1) + '" style="text-align:center;color:var(--text-muted);padding:30px;">暂无数据</td></tr>';
      return;
    }
    _tbody.innerHTML = _pageItems.map(function (item, i) {
      var clickAttr = _onRowClick ? ' tabindex="0"' : '';
      return '<tr data-idx="' + i + '"' + clickAttr + '>' + _columns.map(function (c) {
        var v = item[c.key];
        if (typeof c.fmt === 'function') { try { v = c.fmt(v, item); } catch (e) {} }
        var style = c.cellStyle ? ' style="' + c.cellStyle + '"' : '';
        var content = (v != null ? v : '-');
        return '<td' + style + '>' + (c.html ? content : _esc(content)) + '</td>';
      }).join('') + '</tr>';
    }).join('');

    if (!_pag) return;
    if (totalPages <= 1) { _pag.innerHTML = ''; return; }
    var html = '<button onclick="DetailTable.goPage(1)" ' + (_page <= 1 ? 'disabled' : '') + '>&laquo;</button>';
    html += '<button onclick="DetailTable.goPage(' + (_page - 1) + ')" ' + (_page <= 1 ? 'disabled' : '') + '>&lsaquo;</button>';
    html += '<span class="current">' + _page + ' / ' + totalPages + '</span>';
    html += '<button onclick="DetailTable.goPage(' + (_page + 1) + ')" ' + (_page >= totalPages ? 'disabled' : '') + '>&rsaquo;</button>';
    html += '<button onclick="DetailTable.goPage(' + totalPages + ')" ' + (_page >= totalPages ? 'disabled' : '') + '>&raquo;</button>';
    _pag.innerHTML = html;
  }

  // 服务端分页渲染: _items 为当前页全量(不再客户端切片/排序), 仅渲染行+分页条
  function renderServer() {
    var total = _total;
    var totalPages = Math.max(1, Math.ceil(total / _pageSize));
    if (_page > totalPages) _page = totalPages;
    if (_page < 1) _page = 1;
    _pageItems = _items.slice();
    if (_info) _info.textContent = '共 ' + total + ' 条';
    if (!_tbody) return;
    if (!_pageItems.length) {
      _tbody.innerHTML = '<tr><td colspan="' + Math.max(_columns.length, 1) + '" style="text-align:center;color:var(--text-muted);padding:30px;">暂无数据</td></tr>';
      if (_pag) _pag.innerHTML = '';
      return;
    }
    _tbody.innerHTML = _pageItems.map(function (item, i) {
      var clickAttr = _onRowClick ? ' tabindex="0"' : '';
      return '<tr data-idx="' + i + '"' + clickAttr + '>' + _columns.map(function (c) {
        var v = item[c.key];
        if (typeof c.fmt === 'function') { try { v = c.fmt(v, item); } catch (e) {} }
        var style = c.cellStyle ? ' style="' + c.cellStyle + '"' : '';
        var content = (v != null ? v : '-');
        return '<td' + style + '>' + (c.html ? content : _esc(content)) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    if (!_pag) return;
    if (totalPages <= 1) { _pag.innerHTML = ''; return; }
    var html = '<button onclick="DetailTable.goPage(1)" ' + (_page <= 1 ? 'disabled' : '') + '>&laquo;</button>';
    html += '<button onclick="DetailTable.goPage(' + (_page - 1) + ')" ' + (_page <= 1 ? 'disabled' : '') + '>&lsaquo;</button>';
    html += '<span class="current">' + _page + ' / ' + totalPages + '</span>';
    html += '<button onclick="DetailTable.goPage(' + (_page + 1) + ')" ' + (_page >= totalPages ? 'disabled' : '') + '>&rsaquo;</button>';
    html += '<button onclick="DetailTable.goPage(' + totalPages + ')" ' + (_page >= totalPages ? 'disabled' : '') + '>&raquo;</button>';
    _pag.innerHTML = html;
  }

  function goPage(n) {
    // 服务端分页: 更新 _page 后回调 onPageChange 让宿主页重新 fetch
    if (_serverPaging) {
      var totalPages = Math.max(1, Math.ceil(_total / _pageSize));
      var target = Math.max(1, Math.min(n, totalPages));
      if (target === _page) return;
      _page = target;
      if (typeof _onPageChange === 'function') { _onPageChange(_page); return; }
      // 无回调则仅本地渲染(退化)
      renderServer();
      return;
    }
    var totalPages = Math.max(1, Math.ceil(_items.length / _pageSize));
    _page = Math.max(1, Math.min(n, totalPages));
    render();
  }

  function exportCSV(filename) {
    if (!_items.length) return;
    var header = _columns.map(function (c) { return csvCell(c.label); }).join(',');
    var rows = _items.map(function (item) {
      return _columns.map(function (c) {
        var v = item[c.key];
        if (typeof c.fmt === 'function') { try { v = c.fmt(v, item); } catch (e) {} }
        return csvCell(v);
      }).join(',');
    }).join('\n');
    var blob = new Blob(['﻿' + header + '\n' + rows], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (filename || '明细') + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function csvCell(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  return {
    mount: mount, setColumns: setColumns, setItems: setItems, getItems: getItems,
    setTotal: setTotal, getPage: getPage, getPageSize: getPageSize,
    sort: sort, goPage: goPage, exportCSV: exportCSV
  };
})();
