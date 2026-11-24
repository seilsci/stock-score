# 파이썬 LightGBM 점수 내보내기 (pip install lightgbm). 해마다 "그 전해 12월 말까지 12개월 지난 신호"로만 학습 → 그해 모든 신호에 점수.
import numpy as np, pandas as pd, warnings, lightgbm as lgb, sys
warnings.filterwarnings('ignore')
import sys
S = (sys.argv[1] if len(sys.argv) > 1 else 'data').rstrip('/') + '/'
d = pd.read_csv(S + 'ev_all.csv')
d['Y'] = d.ym // 100
d['mi'] = (d.ym // 100) * 12 + d.ym % 100
d['y'] = d['t12_fd'].clip(-2, 3)
drop = ['y', 'ym', 't_orig', 'exoff_orig', 't_fd', 'exoff_fd', 't12_fd', 't_me', 't12_me', 'Y', 'mi']
price = [c for c in d.columns if c not in drop and not c.startswith('m_')]
mac = [c for c in d.columns if c.startswith('m_')]
d['arith'] = (np.exp(d.t12_fd.clip(-3, 3)) - 1).clip(-0.95, 4)
d['mrank'] = d.groupby('ym').y.rank(pct=True) - 0.5
d['mdm'] = d.y - d.groupby('ym').y.transform('mean')

def zs(tr, te, cols):
    lo = tr[cols].quantile(0.01); hi = tr[cols].quantile(0.99)
    a = tr[cols].clip(lo, hi, axis=1); b = te[cols].clip(lo, hi, axis=1)
    m = a.mean(); s = a.std().replace(0, 1)
    return ((a - m) / s).fillna(0).values, ((b - m) / s).fillna(0).values

def ridge(X, y, lam):
    Xb = np.c_[np.ones(len(X)), X]; P = np.eye(Xb.shape[1]) * lam; P[0, 0] = 0
    return np.linalg.solve(Xb.T @ Xb + P, Xb.T @ y)

def run(name, fit_predict, cols, lab='y', years=range(2012, 2026)):
    out = []
    for Y in years:
        cut = (Y - 1) * 12 + 12
        tr = d[(d.mi <= cut - 12) & d[lab].notna() & d.y.notna()]
        te = d[(d.Y == Y)]
        if len(tr) < 500 or len(te) == 0: continue
        s = fit_predict(tr, te, cols, lab)
        t = te.copy(); t['s'] = s; out.append(t)
    r = pd.concat(out)
    r = r[r.y.notna()]
    res = []
    for mo, g in r.groupby('ym'):
        if len(g) < 12: continue
        g = g.sort_values('s', ascending=False)
        k = 4
        res.append(dict(ym=mo, ic=g.s.rank().corr(g.y.rank()), top4=g.arith.iloc[:k].mean() - g.arith.mean(), top4log=g.y.iloc[:k].mean() - g.y.mean(),
                        top4abs=g.arith.iloc[:k].mean(), top10=g.arith.iloc[:max(1, len(g)//10)].mean() - g.arith.mean(),
                        bot10=g.arith.iloc[-max(1, len(g)//10):].mean() - g.arith.mean(), n=len(g)))
    R = pd.DataFrame(res)
    def blk(df): return df[['ic', 'top4', 'top4log', 'top10', 'bot10']].mean()
    e, l = blk(R[R.ym < 202001]), blk(R[R.ym >= 202001])
    print(f"{name:34s} IC {e.ic:+.3f}/{l.ic:+.3f} | top4초과(산술) {e.top4:+.3f}/{l.top4:+.3f} | top4초과(log) {e.top4log:+.3f}/{l.top4log:+.3f} | 상위10% {e.top10:+.3f}/{l.top10:+.3f} | 하위10% {e.bot10:+.3f}/{l.bot10:+.3f}  (월 {len(R)})", flush=True)
    return r

def f_ridge(lam):
    def f(tr, te, cols, lab):
        A, B = zs(tr, te, cols); w = ridge(A, tr[lab].clip(-2, 3).values if lab == 'y' else tr[lab].values, lam)
        return np.c_[np.ones(len(B)), B] @ w
    return f
def f_lgb(params, rounds=300, objective='regression'):
    def f(tr, te, cols, lab):
        p = dict(objective=objective, learning_rate=0.03, num_leaves=8, max_depth=3, min_data_in_leaf=150, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=10, verbose=-1, seed=1)
        p.update(params)
        m = lgb.train(p, lgb.Dataset(tr[cols], tr[lab]), rounds)
        return m.predict(te[cols])
    return f
d['big'] = (d.t12_fd >= np.log(1.5)).astype(float).where(d.t12_fd.notna())
d['topq'] = (d.mrank >= 0.3).astype(float).where(d.mrank.notna())


def predict_all(fit_predict, cols, lab):
    out = pd.Series(np.nan, index=d.index)
    for Y in range(2011, 2027):
        cut = (Y - 1) * 12 + 12
        tr = d[(d.mi <= cut - 12) & d[lab].notna() & d.y.notna()]
        te = d[d.Y == Y]
        if len(tr) < 500 or len(te) == 0: continue
        out.loc[te.index] = fit_predict(tr, te, cols, lab)
    return out
A = price + mac
def f_split(params):
    def f(tr, te, cols, lab):
        s = np.zeros(len(te))
        for us in [0, 1]:
            a = tr[tr.us == us]; mk = (te.us == us).values
            if mk.sum() == 0: continue
            p = dict(objective='regression', learning_rate=0.03, num_leaves=8, max_depth=3, min_data_in_leaf=100, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=10, verbose=-1, seed=1); p.update(params)
            m = lgb.train(p, lgb.Dataset(a[cols], a[lab]), 300)
            pr = m.predict(te[cols][mk]); s[mk] = pd.Series(pr).rank(pct=True).values       # 시장 안 순위(0~1)로 맞춰 섞음
        return s
    return f
res = d[['y', 'ym']].copy()
res['p_gbm_macro'] = predict_all(f_lgb({}), A, 'y'); print('1', flush=True)
res['p_gbm_macro_dm'] = predict_all(f_lgb({}), A, 'mdm'); print('2', flush=True)
res['p_gbm_macro_d4'] = predict_all(f_lgb({'max_depth': 4, 'num_leaves': 12}, 600), A, 'y'); print('3', flush=True)
res['p_gbm_macro_dm_d4'] = predict_all(f_lgb({'max_depth': 4, 'num_leaves': 12}, 600), A, 'mdm'); print('4', flush=True)
res['p_gbm_macro_split'] = predict_all(f_split({}), A, 'y'); print('5', flush=True)
res['p_gbm_price'] = predict_all(f_lgb({}), price, 'y'); print('6', flush=True)
res['p_gbm_price_dm'] = predict_all(f_lgb({}), price, 'mdm'); print('7', flush=True)
res.to_csv(S + 'ext_scores.csv', index=False)
print(res.notna().sum())
