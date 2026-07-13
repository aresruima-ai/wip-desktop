/**
 * FilterBar — 公共筛选组件（增强版）
 * 支持：级联联动、loading 状态、localStorage 持久化、防抖、双向联动
 */
(function () {
'use strict';

var FIELD_DEFS = {
    dateRange: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.textContent = opts.label || '日期';
            container.appendChild(label);

            var from = document.createElement('input');
            from.type = 'date';
            from.id = opts.prefix + 'dateFrom';
            container.appendChild(from);

            var sep = document.createElement('span');
            sep.style.color = 'var(--text-muted)';
            sep.textContent = '~';
            container.appendChild(sep);

            var to = document.createElement('input');
            to.type = 'date';
            to.id = opts.prefix + 'dateTo';
            container.appendChild(to);

            var sel = document.createElement('select');
            sel.id = opts.prefix + 'dateShortcut';
            sel.className = 'date-shortcut-select';
            var groups = [
                { label: '常用', items: [['today','今天'],['yesterday','昨天'],['dayBefore','前天']] },
                { label: '周', items: [['week','本周'],['lastWeek','上周'],['last7','近7天']] },
                { label: '月', items: [['month','本月'],['lastMonth','上月'],['last30','近30天'],['last60','近60天']] },
                { label: '季度', items: [['quarter','本季度'],['lastQuarter','上季度'],['last90','近90天']] },
                { label: '年', items: [['year','本年'],['firstHalf','上半年'],['secondHalf','下半年'],['last180','近180天'],['last365','近365天']] },
                { label: '自定义', items: [['custom','自定义']] }
            ];
            var defOpt = document.createElement('option');
            defOpt.value = '';
            defOpt.textContent = '快捷选择';
            sel.appendChild(defOpt);
            groups.forEach(function(g) {
                var og = document.createElement('optgroup');
                og.label = g.label;
                g.items.forEach(function(item) {
                    var o = document.createElement('option');
                    o.value = item[0];
                    o.textContent = item[1];
                    og.appendChild(o);
                });
                sel.appendChild(og);
            });
            container.appendChild(sel);
        },
        getValue: function(container, opts) {
            return {
                dateFrom: container.querySelector('#' + opts.prefix + 'dateFrom').value,
                dateTo: container.querySelector('#' + opts.prefix + 'dateTo').value
            };
        },
        setValue: function(container, opts, val) {
            if (val.dateFrom) container.querySelector('#' + opts.prefix + 'dateFrom').value = val.dateFrom;
            if (val.dateTo) container.querySelector('#' + opts.prefix + 'dateTo').value = val.dateTo;
        },
        initDefault: function(container, opts, saved) {
            var from = container.querySelector('#' + opts.prefix + 'dateFrom');
            var to = container.querySelector('#' + opts.prefix + 'dateTo');
            var sel = container.querySelector('#' + opts.prefix + 'dateShortcut');
            if (saved && saved.dateFrom) {
                from.value = saved.dateFrom;
                to.value = saved.dateTo;
            } else {
                var defaultRange = opts.defaultRange || 'month';
                _setDateRange(defaultRange, container, opts.prefix);
                if (sel) sel.value = defaultRange;
            }
        }
    },

    line: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.textContent = opts.label || '线体';
            label.style.marginLeft = '8px';
            container.appendChild(label);

            if (opts.inputType === 'text') {
                var inp = document.createElement('input');
                inp.type = 'text';
                inp.id = opts.prefix + 'lineFilter';
                inp.placeholder = opts.placeholder || '例: SMT-1';
                container.appendChild(inp);
            } else {
                var sel = document.createElement('select');
                sel.id = opts.prefix + 'lineFilter';
                var def = document.createElement('option');
                def.value = '';
                def.textContent = opts.placeholder || '全部';
                sel.appendChild(def);
                container.appendChild(sel);
            }
        },
        load: function(container, opts, apiBase) {
            if (opts.inputType === 'text') return Promise.resolve();
            var sel = container.querySelector('#' + opts.prefix + 'lineFilter');
            return fetch(apiBase + '/api/lines').then(function(res) { return res.json(); }).then(function(r) {
                var items = r.items || (r.result && r.result.items) || [];
                _lineCache = items;
                items.forEach(function(l) {
                    var o = document.createElement('option');
                    o.value = l.id;
                    o.textContent = l.name;
                    sel.appendChild(o);
                });
            }).catch(function() {});
        },
        getValue: function(container, opts) {
            var el = container.querySelector('#' + opts.prefix + 'lineFilter');
            if (opts.inputType === 'text') {
                return { lineName: el.value };
            }
            var val = el.value;
            var result = { lineId: val, lineName: val };
            if (val && el.tagName === 'SELECT' && el.selectedOptions[0]) {
                result.lineDisplay = el.selectedOptions[0].textContent;
            }
            return result;
        },
        setValue: function(container, opts, val) {
            var el = container.querySelector('#' + opts.prefix + 'lineFilter');
            if (opts.inputType === 'text') {
                if (val.lineName !== undefined) el.value = val.lineName;
            } else {
                if (val.lineId !== undefined) el.value = val.lineId;
            }
        },
        initDefault: function(container, opts, saved) {
            var el = container.querySelector('#' + opts.prefix + 'lineFilter');
            if (opts.inputType === 'text') {
                if (saved && saved.lineName) el.value = saved.lineName;
            } else {
                if (saved && saved.lineName) el.value = saved.lineName;
                else if (saved && saved.lineId) el.value = saved.lineId;
            }
        }
    },

    product: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.textContent = opts.label || '产品型号';
            label.style.marginLeft = '8px';
            container.appendChild(label);

            var sel = document.createElement('select');
            sel.id = opts.prefix + 'productFilter';
            var def = document.createElement('option');
            def.value = '';
            def.textContent = opts.placeholder || '全部';
            sel.appendChild(def);
            container.appendChild(sel);
        },
        load: function(container, opts, apiBase) {
            var sel = container.querySelector('#' + opts.prefix + 'productFilter');
            return fetch(apiBase + '/api/products').then(function(res) { return res.json(); }).then(function(r) {
                var items = r.items || r.data || [];
                items.forEach(function(p) {
                    var o = document.createElement('option');
                    o.value = p.id || p.model;
                    o.textContent = p.model || p.name;
                    sel.appendChild(o);
                });
            }).catch(function() {});
        },
        getValue: function(container, opts) {
            return { productModel: container.querySelector('#' + opts.prefix + 'productFilter').value };
        },
        setValue: function(container, opts, val) {
            if (val.productModel !== undefined) container.querySelector('#' + opts.prefix + 'productFilter').value = val.productModel;
        },
        initDefault: function(container, opts, saved) {
            if (saved && saved.productModel) container.querySelector('#' + opts.prefix + 'productFilter').value = saved.productModel;
        }
    },

    workOperation: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.textContent = opts.label || '工序';
            label.style.marginLeft = '8px';
            container.appendChild(label);

            var sel = document.createElement('select');
            sel.id = opts.prefix + 'workOpFilter';
            var def = document.createElement('option');
            def.value = '';
            def.textContent = opts.placeholder || '全部';
            sel.appendChild(def);
            container.appendChild(sel);
        },
        load: function(container, opts, apiBase) {
            var sel = container.querySelector('#' + opts.prefix + 'workOpFilter');
            return fetch(apiBase + '/api/work-operations').then(function(res) { return res.json(); }).then(function(r) {
                var items = r.items || r.data || [];
                items.forEach(function(w) {
                    var o = document.createElement('option');
                    o.value = w.id || w.code;
                    o.textContent = w.name || w.code;
                    sel.appendChild(o);
                });
            }).catch(function() {});
        },
        getValue: function(container, opts) {
            return { workOperationId: container.querySelector('#' + opts.prefix + 'workOpFilter').value };
        },
        setValue: function(container, opts, val) {
            if (val.workOperationId !== undefined) container.querySelector('#' + opts.prefix + 'workOpFilter').value = val.workOperationId;
        },
        initDefault: function() {}
    },

    shift: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.textContent = opts.label || '班次';
            label.style.marginLeft = '8px';
            container.appendChild(label);

            var sel = document.createElement('select');
            sel.id = opts.prefix + 'shiftFilter';
            var def = document.createElement('option');
            def.value = '';
            def.textContent = '全部';
            sel.appendChild(def);
            var shifts = opts.options || [{ value: 'day', text: '白班' }, { value: 'night', text: '夜班' }];
            shifts.forEach(function(s) {
                var o = document.createElement('option');
                o.value = s.value;
                o.textContent = s.text;
                sel.appendChild(o);
            });
            container.appendChild(sel);
        },
        getValue: function(container, opts) {
            return { shift: container.querySelector('#' + opts.prefix + 'shiftFilter').value };
        },
        setValue: function(container, opts, val) {
            if (val.shift !== undefined) container.querySelector('#' + opts.prefix + 'shiftFilter').value = val.shift;
        },
        initDefault: function(container, opts, saved) {
            if (saved && saved.shift) container.querySelector('#' + opts.prefix + 'shiftFilter').value = saved.shift;
        }
    },

    equipment: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.textContent = opts.label || '设备';
            label.style.marginLeft = '8px';
            container.appendChild(label);

            var sel = document.createElement('select');
            sel.id = opts.prefix + 'equipFilter';
            var def = document.createElement('option');
            def.value = '';
            def.textContent = opts.placeholder || '全部';
            sel.appendChild(def);
            container.appendChild(sel);
        },
        load: function(container, opts, apiBase) {
            var sel = container.querySelector('#' + opts.prefix + 'equipFilter');
            return fetch(apiBase + '/api/equipment').then(function(res) { return res.json(); }).then(function(r) {
                var items = r.items || r.data || [];
                items.forEach(function(e) {
                    var o = document.createElement('option');
                    o.value = e.id || e.code;
                    o.textContent = e.name || e.code;
                    sel.appendChild(o);
                });
            }).catch(function() {});
        },
        getValue: function(container, opts) {
            return { equipmentId: container.querySelector('#' + opts.prefix + 'equipFilter').value };
        },
        setValue: function(container, opts, val) {
            if (val.equipmentId !== undefined) container.querySelector('#' + opts.prefix + 'equipFilter').value = val.equipmentId;
        },
        initDefault: function(container, opts, saved) {
            if (saved && saved.equipmentId) container.querySelector('#' + opts.prefix + 'equipFilter').value = saved.equipmentId;
        }
    },

    search: {
        render: function(container, opts) {
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'filter-search';
            inp.id = opts.prefix + (opts.id || 'globalSearch');
            inp.placeholder = opts.placeholder || '搜索...';
            container.appendChild(inp);
        },
        getValue: function(container, opts) {
            var id = opts.prefix + (opts.id || 'globalSearch');
            return { keyword: container.querySelector('#' + id).value.trim().toLowerCase() };
        },
        setValue: function(container, opts, val) {
            var id = opts.prefix + (opts.id || 'globalSearch');
            if (val.keyword !== undefined) container.querySelector('#' + id).value = val.keyword;
        },
        initDefault: function() {}
    },

    checkbox: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.style.marginLeft = '8px';
            label.style.fontSize = '12px';
            label.style.color = 'var(--text-muted)';
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.gap = '4px';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.id = opts.prefix + (opts.id || 'filterCheck');
            cb.checked = opts.defaultChecked !== false;
            cb.style.accentColor = 'var(--brand)';
            label.appendChild(cb);
            label.appendChild(document.createTextNode(opts.label || '选项'));
            container.appendChild(label);
        },
        getValue: function(container, opts) {
            var id = opts.prefix + (opts.id || 'filterCheck');
            var result = {};
            result[opts.paramName || 'checked'] = container.querySelector('#' + id).checked;
            return result;
        },
        setValue: function(container, opts, val) {
            var id = opts.prefix + (opts.id || 'filterCheck');
            var key = opts.paramName || 'checked';
            if (val[key] !== undefined) container.querySelector('#' + id).checked = val[key];
        },
        initDefault: function(container, opts, saved) {
            var id = opts.prefix + (opts.id || 'filterCheck');
            var key = opts.paramName || 'checked';
            if (saved && saved[key] !== undefined) container.querySelector('#' + id).checked = saved[key];
        }
    },

    customSelect: {
        render: function(container, opts) {
            var label = document.createElement('label');
            label.textContent = opts.label || '选项';
            label.style.marginLeft = '8px';
            container.appendChild(label);

            var sel = document.createElement('select');
            sel.id = opts.prefix + (opts.id || 'customSelect');
            (opts.options || []).forEach(function(o) {
                var opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.text;
                sel.appendChild(opt);
            });
            container.appendChild(sel);
        },
        getValue: function(container, opts) {
            var id = opts.prefix + (opts.id || 'customSelect');
            var result = {};
            result[opts.paramName || opts.id || 'customSelect'] = container.querySelector('#' + id).value;
            return result;
        },
        setValue: function(container, opts, val) {
            var id = opts.prefix + (opts.id || 'customSelect');
            var key = opts.paramName || opts.id || 'customSelect';
            if (val[key] !== undefined) container.querySelector('#' + id).value = val[key];
        },
        initDefault: function(container, opts, saved) {
            var id = opts.prefix + (opts.id || 'customSelect');
            var key = opts.paramName || opts.id || 'customSelect';
            if (saved && saved[key] !== undefined) container.querySelector('#' + id).value = saved[key];
        }
    }
};

function _fmtDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

var _lineCache = [];

function _setDateRange(type, container, prefix) {
    var now = new Date();
    var from, to = new Date(now);

    if (type === 'today') from = new Date(now);
    else if (type === 'yesterday') { from = new Date(now); from.setDate(from.getDate() - 1); to = new Date(from); }
    else if (type === 'dayBefore') { from = new Date(now); from.setDate(from.getDate() - 2); to = new Date(from); }
    else if (type === 'week') { from = new Date(now); from.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)); }
    else if (type === 'lastWeek') { from = new Date(now); from.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1) - 7); to = new Date(from); to.setDate(to.getDate() + 6); }
    else if (type === 'last7') { from = new Date(now); from.setDate(from.getDate() - 6); }
    else if (type === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (type === 'lastMonth') { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 0); }
    else if (type === 'last30') { from = new Date(now); from.setDate(from.getDate() - 29); }
    else if (type === 'last60') { from = new Date(now); from.setDate(from.getDate() - 59); }
    else if (type === 'quarter') { var q = Math.floor(now.getMonth() / 3); from = new Date(now.getFullYear(), q * 3, 1); }
    else if (type === 'lastQuarter') { var q2 = Math.floor(now.getMonth() / 3); from = new Date(now.getFullYear(), (q2 - 1) * 3, 1); to = new Date(now.getFullYear(), q2 * 3, 0); }
    else if (type === 'last90') { from = new Date(now); from.setDate(from.getDate() - 89); }
    else if (type === 'year') from = new Date(now.getFullYear(), 0, 1);
    else if (type === 'firstHalf') { from = new Date(now.getFullYear(), 0, 1); to = new Date(now.getFullYear(), 5, 30); }
    else if (type === 'secondHalf') { from = new Date(now.getFullYear(), 6, 1); to = new Date(now.getFullYear(), 11, 31); }
    else if (type === 'last180') { from = new Date(now); from.setDate(from.getDate() - 179); }
    else if (type === 'last365') { from = new Date(now); from.setDate(from.getDate() - 364); }
    else if (type === 'custom') return;
    else from = new Date(now);

    container.querySelector('#' + prefix + 'dateFrom').value = _fmtDate(from);
    container.querySelector('#' + prefix + 'dateTo').value = _fmtDate(to);
}

function _debounce(fn, delay) {
    var timer = null;
    return function() {
        var ctx = this, args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function() { fn.apply(ctx, args); }, delay);
    };
}

/**
 * FilterBar 构造函数
 * @param {string|Element} el - 容器选择器或 DOM 元素
 * @param {object} config
 * @param {string[]} config.fields - 字段列表
 * @param {object} config.fieldOptions - 每个字段的额外配置
 * @param {string} config.defaultRange - 默认日期范围
 * @param {string} config.apiBase - API 前缀
 * @param {string} config.storageKey - sessionStorage 键名
 * @param {function} config.onQuery - 点击查询回调
 * @param {Array} config.extraButtons - 额外按钮
 * @param {object} config.cascade - 级联配置 { sourceField: [targetFields] }
 * @param {boolean} config.rememberSelection - 是否用 localStorage 记住选择
 * @param {function} config.onCascade - 级联回调 (sourceField, value, params) => { targetField: [items] }
 */
function FilterBar(el, config) {
    this.container = typeof el === 'string' ? document.querySelector(el) : el;
    if (!this.container) {
        console.error('[FilterBar] 容器不存在:', el);
        return;
    }
    this.config = Object.assign({
        fields: ['dateRange', 'line'],
        fieldOptions: {},
        defaultRange: 'month',
        apiBase: '',
        storageKey: '_filter_' + location.pathname,
        onQuery: null,
        extraButtons: [],
        prefix: '',
        cascade: null,
        rememberSelection: false,
        onCascade: null
    }, config);

    this._listeners = {};
    this._cascadeHandlers = {};
    this._isRefreshing = false;
    this._build();
}

FilterBar.prototype._build = function () {
    var self = this;
    var c = this.config;
    var el = this.container;
    el.classList.add('filter-bar');
    el.innerHTML = '';

    var prefix = c.prefix;

    c.fields.forEach(function(fieldName) {
        var def = FIELD_DEFS[fieldName];
        if (!def) return;
        var fOpts = Object.assign({ prefix: prefix }, c.fieldOptions[fieldName] || {});
        if (fieldName === 'dateRange') fOpts.defaultRange = c.defaultRange;
        def.render(el, fOpts);
    });

    // "查询"按钮已去掉:筛选 change 自动触发 query(见上方 _autoQuery),与应用按钮统一
    if (c.extraButtons && c.extraButtons.length) {
        c.extraButtons.forEach(function(b) {
            var eb = document.createElement('button');
            eb.className = 'btn-query';
            eb.textContent = b.text;
            if (b.style) eb.setAttribute('style', b.style);
            eb.addEventListener('click', function() { b.onClick && b.onClick(self.getParams()); });
            el.appendChild(eb);
        });
    }

    // shortcut select event
    var shortcutSel = el.querySelector('.date-shortcut-select');
    if (shortcutSel) {
        shortcutSel.addEventListener('change', function() {
            if (shortcutSel.value && shortcutSel.value !== 'custom') {
                _setDateRange(shortcutSel.value, el, prefix);
                self.query();
            }
        });
    }

    // restore saved state (session + localStorage)
    var saved = this._loadState();
    var remembered = this._loadRemembered();
    var merged = Object.assign({}, remembered, saved);

    c.fields.forEach(function(fieldName) {
        var def = FIELD_DEFS[fieldName];
        if (!def || !def.initDefault) return;
        var fOpts = Object.assign({ prefix: prefix, defaultRange: c.defaultRange }, c.fieldOptions[fieldName] || {});
        def.initDefault(el, fOpts, merged);
    });

    // load async data
    var loadPromises = [];
    c.fields.forEach(function(fieldName) {
        var def = FIELD_DEFS[fieldName];
        if (!def || !def.load) return;
        var fOpts = Object.assign({ prefix: prefix }, c.fieldOptions[fieldName] || {});
        if (fOpts.autoLoad === false) return;
        self.setLoading(fieldName, true);
        loadPromises.push(def.load(el, fOpts, c.apiBase).then(function() {
            if (def.initDefault) def.initDefault(el, fOpts, merged);
            self.setLoading(fieldName, false);
            // 加载完成后给默认 option 附可选数量 (N) (排除默认项)
            var _el = self.getFieldElement(fieldName);
            if (_el && _el.options) self._updateCount(fieldName, Math.max(0, _el.options.length - 1));
        }).catch(function() {
            self.setLoading(fieldName, false);
        }));
    });

    Promise.all(loadPromises).then(function() {
        // 筛选 change 自动查询(debounced 300ms,与自定义日期 date change 一致,免点查询按钮)
        var _autoQuery = _debounce(function() { self.query(); }, 300);
        el.querySelectorAll('select, input').forEach(function(input) {
            input.addEventListener('change', function() { self._emit('change', self.getParams()); _autoQuery(); });
        });
        // option > 8 的 select 启用搜索面板(模糊查询), 少则用原生下拉
        el.querySelectorAll('select').forEach(function(s) { self._makeSearchable(s); });
        self._setupCascade();
        self._emit('ready', self.getParams());
    });
};

FilterBar.prototype._setupCascade = function () {
    var self = this;
    var cascade = this.config.cascade;
    if (!cascade) return;

    Object.keys(cascade).forEach(function(sourceField) {
        var targets = cascade[sourceField];
        var el = self.getFieldElement(sourceField);
        if (!el) return;

        var handler = _debounce(function() {
            var value = el.value;
            var params = self.getParams();

            targets.forEach(function(targetField) {
                self.setLoading(targetField, true);
                self._highlightField(targetField);
            });

            if (self.config.onCascade) {
                var result = self.config.onCascade(sourceField, value, params);
                if (result && typeof result.then === 'function') {
                    result.then(function(data) {
                        self._applyCascadeResult(targets, data);
                    });
                } else if (result) {
                    self._applyCascadeResult(targets, result);
                }
            }

            self._emit('cascade', { source: sourceField, value: value, targets: targets, params: params });
        }, 50);

        el.addEventListener('change', handler);
        self._cascadeHandlers[sourceField] = handler;
    });
};

FilterBar.prototype._applyCascadeResult = function (targets, data) {
    var self = this;
    targets.forEach(function(targetField) {
        if (data[targetField]) {
            self.setOptions(targetField, data[targetField]);
        }
        self.setLoading(targetField, false);
    });
};

FilterBar.prototype._highlightField = function (fieldName) {
    var el = this.getFieldElement(fieldName);
    if (!el) return;
    el.classList.add('filter-cascade-highlight');
    setTimeout(function() { el.classList.remove('filter-cascade-highlight'); }, 600);
};

FilterBar.prototype.setLoading = function (fieldName, loading) {
    var el = this.getFieldElement(fieldName);
    if (!el) return;
    if (loading) {
        el.disabled = true;
        el.classList.add('filter-loading');
        if (!el.dataset.origPlaceholder && el.options && el.options[0]) {
            el.dataset.origPlaceholder = el.options[0].textContent;
            el.options[0].textContent = '加载中...';
        }
    } else {
        el.disabled = false;
        el.classList.remove('filter-loading');
        if (el.dataset.origPlaceholder && el.options && el.options[0]) {
            el.options[0].textContent = el.dataset.origPlaceholder;
            delete el.dataset.origPlaceholder;
        }
    }
};

FilterBar.prototype.getParams = function () {
    var c = this.config;
    var params = {};
    c.fields.forEach(function(fieldName) {
        var def = FIELD_DEFS[fieldName];
        if (!def) return;
        var fOpts = Object.assign({ prefix: c.prefix }, c.fieldOptions[fieldName] || {});
        Object.assign(params, def.getValue(this.container, fOpts));
    }.bind(this));
    return params;
};

FilterBar.prototype.query = function () {
    var params = this.getParams();
    this._saveState(params);
    this._rememberSelection(params);
    this._emit('query', params);
    if (this.config.onQuery) this.config.onQuery(params);
};

FilterBar.prototype.setValues = function (vals) {
    var c = this.config;
    var self = this;
    c.fields.forEach(function(fieldName) {
        var def = FIELD_DEFS[fieldName];
        if (!def || !def.setValue) return;
        var fOpts = Object.assign({ prefix: c.prefix }, c.fieldOptions[fieldName] || {});
        def.setValue(self.container, fOpts, vals);
    });
};

FilterBar.prototype.on = function (event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    return this;
};

FilterBar.prototype._emit = function (event, data) {
    (this._listeners[event] || []).forEach(function(fn) { fn(data); });
};

FilterBar.prototype._saveState = function (params) {
    try { sessionStorage.setItem(this.config.storageKey, JSON.stringify(params)); } catch (e) {}
};

FilterBar.prototype._loadState = function () {
    try { return JSON.parse(sessionStorage.getItem(this.config.storageKey)) || {}; } catch (e) { return {}; }
};

FilterBar.prototype._rememberSelection = function (params) {
    if (!this.config.rememberSelection) return;
    try { localStorage.setItem(this.config.storageKey + '_remember', JSON.stringify(params)); } catch (e) {}
};

FilterBar.prototype._loadRemembered = function () {
    if (!this.config.rememberSelection) return {};
    try { return JSON.parse(localStorage.getItem(this.config.storageKey + '_remember')) || {}; } catch (e) { return {}; }
};

FilterBar.prototype.setRange = function (type) {
    _setDateRange(type, this.container, this.config.prefix);
    this.query();
};

FilterBar.prototype.getFieldElement = function (fieldName) {
    var prefix = this.config.prefix;
    var map = {
        line: '#' + prefix + 'lineFilter',
        product: '#' + prefix + 'productFilter',
        workOperation: '#' + prefix + 'workOpFilter',
        shift: '#' + prefix + 'shiftFilter',
        equipment: '#' + prefix + 'equipFilter',
        dateFrom: '#' + prefix + 'dateFrom',
        dateTo: '#' + prefix + 'dateTo'
    };
    if (fieldName === 'search') {
        var sOpts = this.config.fieldOptions.search || {};
        return this.container.querySelector('#' + prefix + (sOpts.id || 'globalSearch'));
    }
    if (fieldName === 'checkbox') {
        var cOpts = this.config.fieldOptions.checkbox || {};
        return this.container.querySelector('#' + prefix + (cOpts.id || 'filterCheck'));
    }
    if (fieldName === 'customSelect') {
        var csOpts = this.config.fieldOptions.customSelect || {};
        return this.container.querySelector('#' + prefix + (csOpts.id || 'customSelect'));
    }
    var selector = map[fieldName];
    return selector ? this.container.querySelector(selector) : null;
};

FilterBar.prototype.onFieldChange = function (fieldName, callback) {
    var self = this;
    var el = this.getFieldElement(fieldName);
    if (el) el.addEventListener('change', function() { callback(el.value, self.getParams()); });
    return this;
};

FilterBar.prototype.setOptions = function (fieldName, items, valueKey, textKey) {
    var el = this.getFieldElement(fieldName);
    if (!el || !el.options) return;
    var current = el.value;
    while (el.options.length > 1) el.options[1].remove();
    if (!items || items.length === 0) {
        var emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '无匹配项';
        emptyOpt.disabled = true;
        emptyOpt.style.color = 'var(--text-muted, #999)';
        el.appendChild(emptyOpt);
        el.value = '';
        this._updateCount(fieldName, 0);
        return;
    }
    items.forEach(function(item) {
        var o = document.createElement('option');
        o.value = typeof item === 'string' ? item : item[valueKey || 'id'];
        o.textContent = typeof item === 'string' ? item : item[textKey || 'name'];
        el.appendChild(o);
    });
    // 默认 option(全部) 后附当前可选数量 (N), 让用户一眼看到筛选项目数
    this._updateCount(fieldName, items.length);
    // preserve selection if still exists
    var found = false;
    for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].value === current) { found = true; break; }
    }
    el.value = found ? current : '';
    if (!found && current) {
        this._highlightField(fieldName);
    }
};

FilterBar.prototype.getLineCache = function () {
    return _lineCache;
};

// 可搜索 select: option > 8 时 mousedown 阻止原生下拉, 弹搜索面板(模糊查询)。
// select/getValue/setOptions/cascading 全不变, 仅交互层增强, 零风险。
FilterBar.prototype._makeSearchable = function (selectEl) {
    if (selectEl._searchable) return;
    selectEl._searchable = true;
    var self = this;
    selectEl.addEventListener('mousedown', function (e) {
        if (selectEl.options.length <= 8) return;  // 少则用原生下拉
        e.preventDefault();  // 阻止原生下拉
        self._showSearchPanel(selectEl);
    });
};

FilterBar.prototype._showSearchPanel = function (selectEl) {
    var existing = document.querySelector('.fb-search-panel');
    if (existing) existing.remove();
    var rect = selectEl.getBoundingClientRect();
    var panel = document.createElement('div');
    panel.className = 'fb-search-panel';
    panel.style.cssText = 'position:absolute; top:' + (rect.bottom + window.scrollY + 2) + 'px; left:' + (rect.left + window.scrollX) + 'px; width:' + Math.max(rect.width, 200) + 'px; background:var(--surface-1,#12161c); border:1px solid var(--line,#334155); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.5); z-index:1000; padding:6px; font-family:inherit;';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '搜索...';
    inp.style.cssText = 'width:100%; box-sizing:border-box; padding:6px 10px; border:1px solid var(--line,#334155); border-radius:6px; background:var(--surface-0,#0a0d12); color:var(--text-primary,#e5e7eb); font-size:13px; margin-bottom:4px; outline:none;';
    panel.appendChild(inp);
    var list = document.createElement('div');
    list.style.cssText = 'max-height:200px; overflow-y:auto;';
    panel.appendChild(list);
    var opts = [];
    for (var i = 0; i < selectEl.options.length; i++) {
        var o = selectEl.options[i];
        if (!o.value) continue;
        opts.push({ value: o.value, text: o.textContent });
    }
    function renderList(filter) {
        list.innerHTML = '';
        var f = (filter || '').toLowerCase();
        opts.forEach(function(o) {
            if (f && o.text.toLowerCase().indexOf(f) < 0 && o.value.toLowerCase().indexOf(f) < 0) return;
            var item = document.createElement('div');
            item.textContent = o.text;
            item.style.cssText = 'padding:7px 10px; cursor:pointer; border-radius:6px; color:var(--text-secondary,#94a3b8); font-size:13px; transition:background .1s;';
            item.onmouseenter = function() { item.style.background = 'var(--brand-glow,rgba(14,165,233,0.12))'; item.style.color = 'var(--brand,#0ea5e9)'; };
            item.onmouseleave = function() { item.style.background = ''; item.style.color = 'var(--text-secondary,#94a3b8)'; };
            item.onclick = function() {
                selectEl.value = o.value;
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                panel.remove();
            };
            list.appendChild(item);
        });
        if (!list.children.length) list.innerHTML = '<div style="padding:12px;color:var(--text-muted,#64748b);font-size:13px;text-align:center;">无匹配</div>';
    }
    renderList('');
    inp.oninput = function() { renderList(inp.value); };
    document.body.appendChild(panel);
    inp.focus();
    setTimeout(function() {
        var closer = function(e) {
            if (!panel.contains(e.target) && e.target !== selectEl) { panel.remove(); document.removeEventListener('mousedown', closer); }
        };
        document.addEventListener('mousedown', closer);
    }, 0);
};

// 默认 option(全部线体/工序/型号) 文本后附可选数量 (N), 随筛选收窄动态更新。
// 保留原 placeholder 文本(如"全部线体"), 仅追加 " (N)" 后缀; N=0 时去掉后缀。
FilterBar.prototype._updateCount = function (fieldName, count) {
    var el = this.getFieldElement(fieldName);
    if (!el || !el.options || !el.options[0]) return;
    var opt = el.options[0];
    var base = (opt.dataset.baseText || opt.textContent || '').replace(/\s*\(\d+\)\s*$/, '').trim();
    if (!opt.dataset.baseText) opt.dataset.baseText = base;
    opt.textContent = base + (count > 0 ? ' (' + count + ')' : '');
};

FilterBar.prototype.setRefreshing = function (refreshing) {
    this._isRefreshing = refreshing;
};

FilterBar.prototype.isRefreshing = function () {
    return this._isRefreshing;
};

FilterBar.prototype.triggerCascade = function (sourceField) {
    var handler = this._cascadeHandlers[sourceField];
    if (handler) handler();
};

window.FilterBar = FilterBar;

})();
