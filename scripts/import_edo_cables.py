# -*- coding: utf-8 -*-
"""
EDO 线材台账导入 → ai_aging_cable
- 读 EDO 导出的「治具档案_履历表」xlsx, 筛线材(测试线材/测试线束)
- 机型→线体: 用 production.product_model 模糊匹配(权威源), 取过站量最大的线
- upsert by edo_id (data_id), 幂等可重跑
- 只读 EDO + production, 不改其它数据

用法: python scripts/import_edo_cables.py [xlsx路径]
"""
import sys, os, re, datetime, collections
import pymongo, openpyxl

# --- .env ---
def load_env(path='.env'):
    env = {}
    if not os.path.exists(path): return env
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()
    return env
env = load_env(os.path.join(os.path.dirname(__file__), '..', '.env'))
MONGO_URI = env.get('MONGO_URI') or os.environ.get('MONGO_URI')
MONGO_DB = env.get('MONGO_DB') or os.environ.get('MONGO_DB') or 'mes_dashboard'
XLSX = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '治具档案_履历表_20260625212111.xlsx')

if not MONGO_URI:
    print('ERROR: MONGO_URI 未找到 (.env)'); sys.exit(1)

# --- 连接 ---
client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=8000)
db = client[MONGO_DB]

# MongoDB 文档字段统一 ai_ 前缀; 脚本直连库(不经 db.js 翻译层), 故显式加前缀。
# _ai(): 递归给 dict 键加 ai_ 前缀(跳过 _id 与 $ 操作符键, 其值递归); list 逐元素递归。
def _ai(v):
    if isinstance(v, list): return [_ai(x) for x in v]
    if not isinstance(v, dict): return v
    out = {}
    for k, val in v.items():
        if k == '_id' or k.startswith('$'): out[k] = _ai(val)
        else: out['ai_' + k if not k.startswith('ai_') else k] = _ai(val)
    return out

# --- EDO 列定义 (0-based) ---
COL = dict(data_id=0, title=1, name=2, code=3, model=4, type=5, spec=6,
           status=7, storage=9, install=10, expire=11, orig_code=13,
           keeper=15, design=19, remaining=20, env=21)
CABLE_TYPES = {'测试线材', '测试线束'}

def cell(r, k):
    i = COL[k]
    v = r[i] if i < len(r) else None
    return v

def to_date(v):
    if not v: return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime('%Y-%m-%d')
    s = str(v).strip()
    m = re.match(r'(\d{4}-\d{2}-\d{2})', s)
    return m.group(1) if m else (s or None)

def to_int(v):
    if v is None or v == '': return None
    try: return int(float(v))
    except: return None

# --- 0. 客户机型→内部料号 对照表 (ai_model_map, 用户提供/admin可补) ---
# 种子: 用户提供 CX1E → QOA.UD03.1624.ZK
DEFAULT_MODEL_MAP = [
    {'customer': 'CX1E', 'match': 'prefix', 'internal': 'QOA.UD03.1624.ZK', 'note': '用户提供 2026-06-25'},
]
def load_model_map():
    """读 ai_model_map 集合, 合并默认种子 (集合优先)"""
    mp = {}
    try:
        for d in db['ai_model_map'].find({}, {'_id': 0}):
            mp[d['ai_customer']] = {'match': d.get('ai_match', 'prefix'), 'internal': d['ai_internal']}
    except Exception:
        pass
    for e in DEFAULT_MODEL_MAP:
        mp.setdefault(e['customer'], {'match': e['match'], 'internal': e['internal']})
    return mp
MODEL_MAP = load_model_map()
# 种子写入 ai_model_map (供 admin 维护, 不覆盖已有)
db['ai_model_map'].create_index('ai_customer', unique=True)
for e in DEFAULT_MODEL_MAP:
    db['ai_model_map'].update_one(_ai({'customer': e['customer']}), {'$setOnInsert': _ai({**e, 'source': 'manual'})}, upsert=True)
print(f'[0/4] 客户机型对照表: {len(MODEL_MAP)} 条 {list(MODEL_MAP.keys())}')

# --- 1. 构建 production 机型→线体 映射 (权威) ---
print('[1/4] 聚合 production 机型→线体 ...')
pm2lines = collections.defaultdict(collections.Counter)
for d in db['ai_production'].aggregate([
    {'$group': {'_id': {'pm': '$ai_product_model', 'ln': '$ai_line_name'}, 'n': {'$sum': 1}}},
    {'$match': {'_id.pm': {'$nin': [None, '']}}}
]):
    pm2lines[d['_id']['pm']][d['_id']['ln']] += d['n']
print(f'      production distinct product_model = {len(pm2lines)}')

def _dom(pm):
    return pm2lines[pm].most_common(1)[0][0] if pm in pm2lines and pm2lines[pm] else None

def match_line(model):
    """EDO机型 → (product_model, line_name, confidence) 或 None
    优先级: 显式对照表 > exact > substr > token"""
    if not model or model in ('/', '无'): return None
    # 0. 显式对照表 (prefix/contains/exact)
    for cust, e in MODEL_MAP.items():
        mt = e['match']; im = e['internal']
        hit = (mt == 'exact' and model == cust) or \
              (mt == 'prefix' and model.startswith(cust)) or \
              (mt == 'contains' and cust in model)
        if hit and im in pm2lines:
            return (im, _dom(im), 'explicit')
    # 1. exact
    if model in pm2lines:
        return (model, _dom(model), 'exact')
    # 2. substr (互相包含)
    for pm in pm2lines:
        if pm and (model in pm or pm in model):
            return (pm, _dom(pm), 'substr')
    # 3. 任一 token (≥4) 匹配
    tokens = [t for t in re.split(r'[-/& ]', model) if len(t) >= 4]
    for tok in tokens:
        for pm in pm2lines:
            if pm and (tok in pm or pm.startswith(tok)):
                return (pm, _dom(pm), 'token')
    return None

# --- 2. 读 EDO, 筛线材 ---
print(f'[2/4] 读 EDO: {XLSX}')
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb[wb.sheetnames[0]]
rows = list(ws.iter_rows(values_only=True))
header = rows[0]
cables_raw = [r for r in rows[1:] if cell(r, 'type') in CABLE_TYPES]
print(f'      总行 {len(rows)-1}, 线材 {len(cables_raw)} 根')

# --- 3. 组装文档 + 解析线体 ---
print('[3/4] 解析机型→线体 + 组装文档 ...')
docs = []
stat = collections.Counter()
line_dist = collections.Counter()
unmatched_models = collections.Counter()
for r in cables_raw:
    edo_id = cell(r, 'data_id')
    code = cell(r, 'code')
    if not edo_id or not code:
        stat['skip_no_id_or_code'] += 1; continue
    model = (cell(r, 'model') or '').strip()
    m = match_line(model)
    line_name = None; match_pm = None; match_conf = None
    if m:
        match_pm, line_name, match_conf = m
        stat['mapped_' + match_conf] += 1
        line_dist[line_name] += 1
    else:
        stat['unmapped'] += 1
        if model: unmatched_models[model] += 1

    status_raw = (cell(r, 'status') or '').strip()
    # EDO状态 → 在用/停用: 停用/闲置/异常 视为停用
    retire_date = None if status_raw in ('正常', '运行', '备用', '') else to_date(datetime.date.today())

    doc = {
        'edo_id': edo_id,
        'code': code,
        'name': (cell(r, 'name') or '').strip() or None,
        'product_model': model or None,
        'cable_type': cell(r, 'type'),
        'spec': (cell(r, 'spec') or '').strip() or None,
        'line_name': line_name,
        'match_product_model': match_pm,
        'match_confidence': match_conf,
        'install_date': to_date(cell(r, 'install')),
        'retire_date': retire_date,
        'edo_expire': to_date(cell(r, 'expire')),
        'edo_orig_code': (cell(r, 'orig_code') or '').strip() or None,
        'edo_status': status_raw or None,
        'keeper': (cell(r, 'keeper') or '').strip() or None,
        'storage': (cell(r, 'storage') or '').strip() or None,
        'design_life': to_int(cell(r, 'design')),
        'edo_remaining': to_int(cell(r, 'remaining')),
        'source': 'edo',
        'imported_at': int(datetime.datetime.now().timestamp() * 1000),
    }
    docs.append(doc)

# --- 4. upsert ---
print(f'[4/4] upsert {len(docs)} 根 → ai_aging_cable (by edo_id) ...')
coll = db['ai_aging_cable']
ops = []
for d in docs:
    edo_id = d.pop('edo_id')
    ops.append(pymongo.UpdateOne(
        _ai({'edo_id': edo_id}),
        {'$set': _ai({**d, 'edo_id': edo_id})},
        upsert=True
    ))
if ops:
    try:
        res = coll.bulk_write(ops, ordered=False)
        print(f'      matched={res.matched_count} modified={res.modified_count} upserted={res.upserted_count}')
    except pymongo.errors.BulkWriteError as e:
        print('      BulkWriteError:', e.details.get('writeErrors', [{}])[:3])
        print(f'      inserted/modified 部分成功, 详见错误')

# --- 报告 ---
total = len(docs)
mapped = sum(v for k, v in stat.items() if k.startswith('mapped_'))
print('\n========== 导入报告 ==========')
print(f'线材总数: {total}')
print(f'已映射线体: {mapped} ({mapped*100//total if total else 0}%)  [explicit={stat.get("mapped_explicit",0)} exact={stat.get("mapped_exact",0)} substr={stat.get("mapped_substr",0)} token={stat.get("mapped_token",0)}]')
print(f'未映射(未在产): {stat["unmapped"]} ({stat["unmapped"]*100//total if total else 0}%)')
print(f'\n已映射按线体分布:')
for ln, n in line_dist.most_common(): print(f'  {ln}: {n}')
print(f'\n未映射机型 top15 (需补录机型→线体):')
for m, n in unmatched_models.most_common(15): print(f'  {m}: {n}')
print(f'\nDB ai_aging_cable 现有: {coll.count_documents({})} 根')
print('完成.')
