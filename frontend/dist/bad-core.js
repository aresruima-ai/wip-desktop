/**
 * bad-core.js — 不良分析数据获取、筛选、状态管理
 */
var BadCore = (function() {
    var MES_API = (location.port === '8080' || (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1')) ? '' : 'http://' + location.hostname + ':8080';
    var TARGET_RATE = 95;
    var state = {
        productionTotal: 0,
        badTotal: 0,
        badItems: [],
        origBadItems: [],
        prodByDay: [],
        badByProcess: [],
        badByDefect: [],
        badByDay: [],
        summary: null,
        spcData: null,
        aiInsights: null,
        correlation: null,
        viewMode: 'all', // 'all' | 'real' | 'mistest' (旧,保留兼容;新逻辑用 typeFilter)
        stageFilter: 'all', // 'all' | 'assembly' | 'test' | 'packaging'
        typeFilter: 'real',  // 默认"真不良"视角(测试异常/误测是测试线问题,非品质;盯真不良更有行动价值)
        stageOutput: { assembly: 0, test: 0, packaging: 0 } // 各工艺段产量(KPI 分段分母)
    };

    function getState() { return state; }
    function getAPI() { return MES_API; }
    function getTarget() { return TARGET_RATE; }
    // localDate 收口到 common.js (window.localDate), 模块内调用走全局

    // 秒开: 从 localStorage last-known-good 预填主数据状态(消除白屏)。
    // 与 fetchAllData 同口径写 state; 不清空 summary/spc/ai(保留上次高级分析, 避免面板闪空)。
    // 返回 fast URL 供 fetchAllData 复用, 或 null 表示无缓存。
    function peekFastData(dateFrom, dateTo, lineId) {
        var qs = 'dateFrom=' + dateFrom + '&dateTo=' + dateTo;
        if (lineId) qs += '&lineName=' + encodeURIComponent(lineId);
        var url = MES_API + '/api/bad/fast?' + qs;
        var ck = (window.apiFetch && apiFetch.peek) ? apiFetch.peek(url) : null;
        if (!ck) return url;
        var mainResp = ck.val;
        if (!mainResp || mainResp.success === false) return url;
        try {
            state.productionTotal = mainResp.productionTotal || 0;
            state.prodByDay = (mainResp.prodByDay || []).map(function(d) { return { date: d.date, total: d.total }; });
            var allBad = mainResp.badItems || [];
            if (mainResp.badByProcess && mainResp.badByDefect && mainResp.badByDay) {
                state.badByProcess = mainResp.badByProcess;
                state.badByDefect = mainResp.badByDefect;
                state.badByDay = mainResp.badByDay;
            } else {
                recalcAggregates(allBad);
            }
            var uniqueSNs = new Set();
            allBad.forEach(function(item) { if (item.barcode) uniqueSNs.add(item.barcode); });
            state.badTotal = mainResp.badTotal != null ? mainResp.badTotal : (uniqueSNs.size || allBad.length);
            state.badItems = allBad;
            state.origBadItems = allBad.slice();
            state.fastMeta = {
                source: mainResp.source || 'mongo:ai_production+ai_bad_repair',
                cached: true,
                elapsed_ms: mainResp.elapsed_ms,
                data_quality: mainResp.data_quality
            };
        } catch(e) { /* peek 失败静默 fallback */ }
        return url;
    }

    async function fetchAllData(dateFrom, dateTo, lineId) {
        var qs = 'dateFrom=' + dateFrom + '&dateTo=' + dateTo;
        if (lineId) qs += '&lineName=' + encodeURIComponent(lineId);
        // 统一走 apiFetch(401 跳登录 / 501 Toast.warning / 5xx Toast.error / 网络失败 Toast.error)
        var mainResp;
        try {
            mainResp = await apiFetch(MES_API + '/api/bad/fast?' + qs, { credentials: 'same-origin' });
        } catch (e) {
            // 401 已由 apiFetch 跳登录, 其它已 Toast 提示 — 静默退出保留上次状态
            return false;
        }
        if (!mainResp) return false;
        if (mainResp._syncing) { Toast && Toast.info(mainResp.message || '历史数据同步中...'); return false; }
        if (mainResp.success === false) { Toast && Toast.error(mainResp.error || '数据加载失败'); return false; }

        state.productionTotal = mainResp.productionTotal || 0;
        state.prodByDay = (mainResp.prodByDay || []).map(function(d) { return { date: d.date, total: d.total }; });
        var allBad = mainResp.badItems || [];

        if (mainResp.badByProcess && mainResp.badByDefect && mainResp.badByDay) {
            state.badByProcess = mainResp.badByProcess;
            state.badByDefect = mainResp.badByDefect;
            state.badByDay = mainResp.badByDay;
        } else {
            recalcAggregates(allBad);
        }

        var uniqueSNs = new Set();
        allBad.forEach(function(item) { if (item.barcode) uniqueSNs.add(item.barcode); });
        state.badTotal = mainResp.badTotal != null ? mainResp.badTotal : (uniqueSNs.size || allBad.length);
        state.badItems = allBad;
        state.origBadItems = allBad.slice();

        // Advanced panels are loaded after first paint.
        state.summary = null;
        state.spcData = null;
        state.aiInsights = null;
        state.correlation = null;
        state.fastMeta = {
            source: mainResp.source || 'mongo:ai_production+ai_bad_repair',
            cached: !!mainResp.cached,
            elapsed_ms: mainResp.elapsed_ms,
            data_quality: mainResp.data_quality
        };

        return true;
    }

    async function fetchAdvancedData(dateFrom, dateTo, lineId) {
        var lineParam = lineId ? '&lineName=' + encodeURIComponent(lineId) : '';
        // excludeMisce 不再依赖孤儿 filterMisce 复选框; 改由 typeFilter 推导:
        // type=real/abnormal 本身已排误测(后端 badTypeFilter), type=all/mistest 不排除。
        var excludeMisce = (state.typeFilter === 'real' || state.typeFilter === 'abnormal') ? '&excludeMisce=1' : '';
        var stageParam = '&stage=' + encodeURIComponent(state.stageFilter || 'all');
        var typeParam = '&type=' + encodeURIComponent(state.typeFilter || 'all');
        var common = lineParam + excludeMisce + stageParam + typeParam;
        var [summaryResp, spcResp, aiResp, corrResp] = await Promise.all([
            apiFetch(MES_API + '/api/bad/summary?dateFrom=' + dateFrom + '&dateTo=' + dateTo + common).catch(() => null),
            apiFetch(MES_API + '/api/bad/spc?dateFrom=' + dateFrom + '&dateTo=' + dateTo + common).catch(() => null),
            apiFetch(MES_API + '/api/bad/ai-analysis?dateFrom=' + dateFrom + '&dateTo=' + dateTo + common).catch(() => null),
            apiFetch(MES_API + '/api/bad/correlation?dateFrom=' + dateFrom + '&dateTo=' + dateTo + common).catch(() => null)
        ]);
        state.summary = summaryResp;
        state.spcData = spcResp;
        state.aiInsights = aiResp;
        state.correlation = corrResp;
        return { summary: summaryResp, spc: spcResp, ai: aiResp, correlation: corrResp };
    }

    // 秒开: 从 localStorage last-known-good 预填高级分析状态(SPC/AI/关联/summary)。
    // 返回是否有任何缓存命中(供页面决定是否即时渲染)。peek 失败静默。
    function peekAdvancedData(dateFrom, dateTo, lineId) {
        if (!window.apiFetch || !apiFetch.peek) return false;
        var lineParam = lineId ? '&lineName=' + encodeURIComponent(lineId) : '';
        var excludeMisce = (state.typeFilter === 'real' || state.typeFilter === 'abnormal') ? '&excludeMisce=1' : '';
        var stageParam = '&stage=' + encodeURIComponent(state.stageFilter || 'all');
        var typeParam = '&type=' + encodeURIComponent(state.typeFilter || 'all');
        var common = lineParam + excludeMisce + stageParam + typeParam;
        var base = 'dateFrom=' + dateFrom + '&dateTo=' + dateTo + common;
        var any = false;
        try {
            var s = apiFetch.peek(MES_API + '/api/bad/summary?' + base);
            if (s && s.val) { state.summary = s.val; any = true; }
            var sp = apiFetch.peek(MES_API + '/api/bad/spc?' + base);
            if (sp && sp.val) { state.spcData = sp.val; any = true; }
            var ai = apiFetch.peek(MES_API + '/api/bad/ai-analysis?' + base);
            if (ai && ai.val) { state.aiInsights = ai.val; any = true; }
            var co = apiFetch.peek(MES_API + '/api/bad/correlation?' + base);
            if (co && co.val) { state.correlation = co.val; any = true; }
        } catch(e) { /* peek 静默 fallback */ }
        return any;
    }

    function recalcAggregates(items) {
        var byProc = {}, byDef = {}, byDay = {}, procSNs = {};
        items.forEach(function(item) {
            var proc = item.workOprationName || '未知';
            if (!procSNs[proc]) procSNs[proc] = new Set();
            var sn = item.barcode || (item.testTime + '|' + item.badItems);
            procSNs[proc].add(sn);
            var def = item.badItems || '未知';
            byDef[def] = (byDef[def] || 0) + 1;
            if (item.testTime) {
                var dt = new Date(item.testTime);
                if (!isNaN(dt.getTime())) { var day = localDate(dt); byDay[day] = (byDay[day] || 0) + 1; }
            }
        });
        Object.entries(procSNs).forEach(function(e) { byProc[e[0]] = e[1].size; });
        state.badByProcess = Object.entries(byProc).map(function(e) { return { process: e[0], count: e[1] }; }).sort(function(a, b) { return b.count - a.count; });
        state.badByDefect = Object.entries(byDef).map(function(e) { return { defect: e[0], count: e[1] }; }).sort(function(a, b) { return b.count - a.count; });
        state.badByDay = Object.entries(byDay).map(function(e) { return { date: e[0], count: e[1] }; }).sort(function(a, b) { return a.date.localeCompare(b.date); });
    }

    function isMistest(item) {
        var content = item.contentName || '';
        var causes = item.causesName || '';
        var remark = item.remark || '';
        return content === '误测' || content === 'NTF' || causes.indexOf('故障不再现') !== -1 || remark === '重测';
    }

    // 工艺段分类(与后端 db.js stageOfOperation 同规则,保证前后端口径一致)
    function stageOfOperation(name) {
        if (!name) return 'assembly';
        if (/包装|下料|贴标|封箱|装箱/.test(name)) return 'packaging';
        if (/测试|检测|EOL|ATE|振动|震动|老化|噪音|异响|目检|PIN|静置|GP12/.test(name)) return 'test';
        return 'assembly';
    }

    // 测试异常判定: bad_items 命中 -NoReturn / -纯数字(测量值/状态码) → 测试设备/程序问题,非产品不良
    function isTestAbnormal(item) {
        var bad = item.badItems || '';
        return /-NoReturn$|-\d+(\.\d+)?$/.test(bad);
    }

    function setViewMode(mode) { state.viewMode = mode; }
    function getViewMode() { return state.viewMode; }
    function setStageFilter(s) { state.stageFilter = s || 'all'; }
    function getStageFilter() { return state.stageFilter; }
    function setTypeFilter(t) { state.typeFilter = t || 'all'; }
    function getTypeFilter() { return state.typeFilter; }

    // 是否排除误测 — 由 typeFilter 推导(real/abnormal 已排误测), 供页面 misceInfo/焦点壳判断当前视角
    function isExcludingMistest() { return state.typeFilter === 'real' || state.typeFilter === 'abnormal'; }

    function applyClientFilters(procVal, prodVal, keyword, excludeMisce, lineName) {
        var items = state.origBadItems.slice();
        if (lineName) items = items.filter(function(i) { return i.lineName === lineName; });
        if (procVal) items = items.filter(function(i) { return i.workOprationName === procVal; });
        if (prodVal) items = items.filter(function(i) { return i.productModel === prodVal; });
        if (keyword) items = items.filter(function(i) { return (i.lineName + '|' + i.productModel + '|' + i.workOprationName + '|' + i.badItems + '|' + i.contentName + '|' + i.barcode).toLowerCase().indexOf(keyword) !== -1; });

        // 工艺段筛选(组装/测试/包装)
        if (state.stageFilter && state.stageFilter !== 'all') {
            items = items.filter(function(i) { return stageOfOperation(i.workOprationName) === state.stageFilter; });
        }

        // 统计三类构成(工艺段筛选后、类型筛选前;用于信息条展示)
        var mistestTotal = 0, realTotal = 0, abnormalTotal = 0;
        items.forEach(function(i) {
            if (isMistest(i)) mistestTotal++;
            else if (isTestAbnormal(i)) abnormalTotal++;
            else realTotal++;
        });

        // 不良类型筛选: typeFilter 优先; 兼容旧 viewMode(real/mistest)
        var tf = state.typeFilter && state.typeFilter !== 'all' ? state.typeFilter
            : (state.viewMode === 'real' ? 'real' : state.viewMode === 'mistest' ? 'mistest' : null);
        if (tf === 'real') {
            // 真不良 = 非误测 && 非测试异常
            items = items.filter(function(i) { return !isMistest(i) && !isTestAbnormal(i); });
        } else if (tf === 'abnormal') {
            // 测试异常 = 非误测(误测优先级更高) && 命中测试异常命名
            items = items.filter(function(i) { return !isMistest(i) && isTestAbnormal(i); });
        } else if (tf === 'mistest') {
            items = items.filter(function(i) { return isMistest(i); });
        } else if (excludeMisce) {
            var beforeCount = items.length;
            items = items.filter(function(i) { return !isMistest(i); });
            mistestTotal = beforeCount - items.length;
        }
        state.badItems = items;
        var uniqueSNs = new Set();
        items.forEach(function(i) { if (i.barcode) uniqueSNs.add(i.barcode); });
        state.badTotal = uniqueSNs.size || items.length;
        recalcAggregates(items);
        return { mistestTotal: mistestTotal, realTotal: realTotal, abnormalTotal: abnormalTotal, filtered: items.length };
    }

    return {
        getState: getState,
        getAPI: getAPI,
        getTarget: getTarget,
        fetchAllData: fetchAllData,
        peekFastData: peekFastData,
        fetchAdvancedData: fetchAdvancedData,
        peekAdvancedData: peekAdvancedData,
        applyClientFilters: applyClientFilters,
        recalcAggregates: recalcAggregates,
        setViewMode: setViewMode,
        getViewMode: getViewMode,
        setStageFilter: setStageFilter,
        getStageFilter: getStageFilter,
        setTypeFilter: setTypeFilter,
        getTypeFilter: getTypeFilter,
        isExcludingMistest: isExcludingMistest,
        stageOfOperation: stageOfOperation,
        isTestAbnormal: isTestAbnormal,
        isMistest: isMistest
    };
})();
