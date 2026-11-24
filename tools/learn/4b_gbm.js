// 4b단계: 사이트용 트리 점수 모델 → data/gbm.json
//   정답 = 첫날 진입 + 지금 판매 규칙(tp2x 트레일·유예 2달·금리)으로 판 수익(strat.js), 지표 = 가격 지표(지수 3개 제외: 사이트에서 0으로 두는 항목),
//   알려진 정답 전부로 학습. 점수(0~100) 환산용 분위(pct)는 학습한 신호 전체의 예측값 분포.
//   사이트(Apps Script·index·journal)는 이 파일의 트리를 같은 식(evalModel)으로 계산하고, 항목별 점수는 기준 종목(지표 중앙값)에서 시작해 섞은 순서의 샤플리 값으로 설명한다.
const { fs, path, DATA, progress } = require('./common');
const { load, trainSetL, modelDefs } = require('./data');
const SL = require('./strat');
const GBM = require('./gbm');
const { F, L } = load(), { PRICE } = modelDefs(F);
const cols = PRICE.filter(j => !F[j].startsWith('idx_'));
const now = new Date(), CUR = now.getFullYear() * 100 + now.getMonth() + 1, END = SL.mi(CUR) - 1;
const labs = L.map(r => SL.label(r.y, r.ym, { entry: 'fd', tp: 2, grace: 2, rate: true }, END));
const tr0 = trainSetL(L, labs, now.getFullYear() + 1, 12);                    // 올해 말까지 알려진 정답 전부(= 지금 알 수 있는 것)
const clipT = t => Math.max(-2, Math.min(3, t));
const SEEDS = +process.env.GBM_SEEDS || 3;                                      // 씨앗 3개 트리를 평균(점수 흔들림 줄임) → 사이트에서는 한 모델로 합쳐 저장
const models = [];
for (let sd = 1; sd <= SEEDS; sd++) { progress('트리 모델', (sd - 1) / SEEDS); models.push(GBM.fit(tr0.map(r => r.x), tr0.map(r => clipT(r.t)), cols, { seed: sd })); }
// 씨앗 평균 = 트리 목록을 이어 붙이고 각 그루 값을 1/SEEDS배, 시작값은 평균
const feats = models[0].feats.map(p => ({ f: F[p.j], lo: p.lo, hi: p.hi, m: p.m, med: p.med }));   // m = 빈 값 채움(평균), med = 설명의 기준 종목 값(중앙값; 0/1 지표는 더 많은 쪽)
const trees = []; models.forEach(m => m.trees.forEach(T => trees.push({ f: T.f, t: T.t.map(v => +(+v).toPrecision(8)), l: T.l, r: T.r, v: T.v.map(v => +(v / SEEDS).toPrecision(7)) })));
const model = { feats, init: models.reduce((s, m) => s + m.init, 0) / SEEDS, trees };
// 점수 환산용 분위: 모델(순서 같은 x)로 학습 신호 전체의 예측값
const xOf = r => model.feats.map((p, k) => { const v = r.x[cols[k]]; return Number.isFinite(v) ? Math.min(p.hi, Math.max(p.lo, v)) : p.m; });
const pr = L.map(r => GBM.evalModel(model, xOf(r))).sort((a, b) => a - b);
const qs = Array.from({ length: 101 }, (_, k) => +pr[Math.min(pr.length - 1, Math.floor(pr.length * k / 100))].toPrecision(7));
const ref = GBM.evalModel(model, model.feats.map(p => p.med));
fs.writeFileSync(path.join(DATA, 'gbm.json'), JSON.stringify({ made: new Date().toISOString(), target: '첫날 진입 + 지금 판매 규칙 수익 log(1+r)', n: tr0.length, seeds: SEEDS, init: +model.init.toPrecision(8), base: +ref.toPrecision(8), feats, trees, pct: qs }));
progress('트리 모델', 1); process.stdout.write('\n');
console.log(`트리 모델: 학습 ${tr0.length}건, 지표 ${cols.length}개, 나무 ${trees.length}그루, 기준 종목 예측 ${ref.toFixed(4)} → ${path.join(DATA, 'gbm.json')}`);
