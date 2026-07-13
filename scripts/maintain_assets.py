# -*- coding: utf-8 -*-
"""
台账数据维护(真实可推导值, 非编造):
- 缺启用日 → 取该机型(match_product_model)在 production 的最早过站日(线材/治具随机型投产启用)
- 缺设计寿命 → 取同机型(match_product_model)的平均设计寿命(同机型同类线材寿命一致)
在 import 之后运行。只补空值, 不覆盖已有真实值。
"""
import os, pymongo

def load_env(path='.env'):
    env = {}
    if not os.path.exists(path): return env
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1); env[k.strip()] = v.strip()
    return env
env = load_env(os.path.join(os.path.dirname(__file__), '..', '.env'))
MONGO_URI = env.get('MONGO_URI') or os.environ.get('MONGO_URI')
db = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=8000)[env.get('MONGO_DB') or 'mes_dashboard']

# MongoDB 文档字段统一 ai_ 前缀; 脚本直连库(不经 db.js 翻译层), 故显式加前缀。
def _ai(v):
    if isinstance(v, list): return [_ai(x) for x in v]
    if not isinstance(v, dict): return v
    out = {}
    for k, val in v.items():
        if k == '_id' or k.startswith('$'): out[k] = _ai(val)
        else: out['ai_' + k if not k.startswith('ai_') else k] = _ai(val)
    return out

# 1. 各机型最早过站日(production)
pm_earliest = {}
for d in db['ai_production'].aggregate([
    {'$match': {'ai_product_model': {'$nin': [None, '']}}},
    {'$group': {'_id': '$ai_product_model', 'min': {'$min': '$ai_move_out_date'}}}
]):
    if d.get('min'): pm_earliest[d['_id']] = d['min'][:10]
print(f'机型最早过站日: {len(pm_earliest)} 种')

for coll_name, label in [('ai_aging_cable','线材'), ('ai_fixture','治具')]:
    coll = db[coll_name]
    # 同机型平均设计寿命
    avg_design = {}
    for d in coll.aggregate([
        {'$match': {'ai_match_product_model': {'$ne': None}, 'ai_design_life': {'$gt': 0}}},
        {'$group': {'_id': '$ai_match_product_model', 'avg': {'$avg': '$ai_design_life'}}}
    ]):
        avg_design[d['_id']] = round(d['avg'])
    filled_date = filled_design = 0
    for doc in coll.find(_ai({'$or': [
        {'install_date': None}, {'install_date': {'$exists': False}},
        {'design_life': None}, {'design_life': {'$exists': False}}
    ]})):
        upd = {}
        mpm = doc.get('ai_match_product_model')
        if not doc.get('ai_install_date') and mpm and mpm in pm_earliest:
            upd['install_date'] = pm_earliest[mpm]
        if not doc.get('ai_design_life') and mpm and mpm in avg_design:
            upd['design_life'] = avg_design[mpm]
        if upd:
            coll.update_one({'_id': doc['_id']}, {'$set': _ai(upd)})
            if 'install_date' in upd: filled_date += 1
            if 'design_life' in upd: filled_design += 1
    print(f'{label}: 补启用日 {filled_date} 条, 补设计寿命 {filled_design} 条')
print('维护完成.')
