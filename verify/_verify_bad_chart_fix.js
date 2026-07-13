// 验证 topTrend 横展修复: realtime 显"数据不足(需≥2天)" + trend空产量显"暂无过站产量数据" + month两图正常渲染 + 0报错
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR:' + e.message));
  await page.goto('http://localhost:8080/login.html', { waitUntil: 'networkidle2' });
  await page.type('input[type="text"]', 'yangning').catch(() => {});
  await page.type('input[type="password"]', 'Yn@20250908').catch(() => {});
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click('button[type="submit"]').catch(() => {})]);
  await page.goto('http://localhost:8080/bad.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 7000));

  function chartState(id) {
    return page.evaluate((id) => {
      const dom = document.getElementById(id);
      const inst = echarts.getInstanceByDom(dom);
      if (!inst) return { id, err: 'no-inst' };
      const o = inst.getOption();
      const cv = dom.querySelector('canvas');
      let nonEmpty=0, sample=0;
      if (cv) {
        const ctx = cv.getContext('2d');
        for(let y=0;y<cv.height;y+=10){for(let x=0;x<cv.width;x+=10){sample++;if(ctx.getImageData(x,y,1,1).data[3]>10)nonEmpty++;}}
      }
      return {
        id,
        title: o.title && o.title[0] ? o.title[0].text : null,
        seriesCount: (o.series||[]).length,
        hasContent: nonEmpty > sample*0.02,
        nonEmpty, sample
      };
    }, id);
  }

  // 1. realtime: topTrend 应显"数据不足(需≥2天)" (修复后), rankChart 同显(对照)
  const rt = await page.evaluate(() => document.getElementById('periodSelect').value);
  const topRt = await chartState('topTrendChart');
  const rankRt = await chartState('rankChart');
  console.log('=== realtime (period=' + rt + ') ===');
  console.log('  topTrend: title=' + JSON.stringify(topRt.title) + ' series=' + topRt.seriesCount + ' hasContent=' + topRt.hasContent + ' (' + topRt.nonEmpty + '/' + topRt.sample + ')');
  console.log('  rankChart: title=' + JSON.stringify(rankRt.title) + ' (对照)');

  // 2. month: 两图应正常渲染有内容, title=null
  await page.select('#periodSelect', 'month');
  await new Promise(r => setTimeout(r, 6500));
  const topMo = await chartState('topTrendChart');
  const rankMo = await chartState('rankChart');
  console.log('\n=== month ===');
  console.log('  topTrend: title=' + JSON.stringify(topMo.title) + ' series=' + topMo.seriesCount + ' hasContent=' + topMo.hasContent + ' (' + topMo.nonEmpty + '/' + topMo.sample + ')');
  console.log('  rankChart: title=' + JSON.stringify(rankMo.title) + ' hasContent=' + rankMo.hasContent);

  // 3. trend 空产量: 切到一个0产量线, trend 应显"暂无过站产量数据"
  const lineOpts = await page.$$eval('#lineFilter option', os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
  const noProd = lineOpts.find(o => o.t.includes('附件盒包装3线')) || lineOpts.find(o => o.t.includes('包装3线'));
  let trendNoProd = 'n/a';
  if (noProd && noProd.v) {
    await page.select('#lineFilter', noProd.v);
    await new Promise(r => setTimeout(r, 5500));
    const ts = await chartState('trendChart');
    trendNoProd = 'title=' + JSON.stringify(ts.title) + ' hasContent=' + ts.hasContent + ' (' + ts.nonEmpty + '/' + ts.sample + ')';
  }
  console.log('\n=== 0产量线 trend ===');
  console.log('  trend: ' + trendNoProd);

  // 断言
  const topRtOk = topRt.title === '数据不足(需≥2天)';
  const topMoOk = topMo.title === null && topMo.hasContent;
  const trendOk = /暂无过站产量数据/.test(trendNoProd);
  const noErr = errs.length === 0;
  console.log('\n=== 断言 ===');
  console.log('realtime topTrend 显"数据不足(需≥2天)":', topRtOk);
  console.log('month topTrend 正常渲染有内容:', topMoOk);
  console.log('0产量线 trend 显"暂无过站产量数据":', trendOk);
  console.log('0 报错:', noErr, errs.length ? '| ' + errs.slice(0,5).join('|') : '');
  const pass = topRtOk && topMoOk && trendOk && noErr;
  console.log('\n=== RESULT: ' + (pass ? 'PASS ✅' : 'FAIL ❌') + ' ===');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
