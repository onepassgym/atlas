const { BrowserManager, searchSpacesInCity, scrapeSpaceDetail } = require('./src/scraper/googleMapsScraper');
(async () => {
  await new Promise(r=>setTimeout(r,90000)); // cool off from Google throttling
  const bm = new BrowserManager(); await bm.launch();
  const page = await bm.newPage();
  const urls = await searchSpacesInCity(page, 'Margao, Goa, India', 'gym');
  console.log('found urls:', urls.length);
  for (const u of urls.slice(0,3)) {
    const t = Date.now();
    try {
      const d = await scrapeSpaceDetail(page, u, 'standard', bm.ctx);
      const ids = d.reviews.map(x=>x.reviewId);
      console.log(`${d.name} | total=${d.totalReviews} scraped=${d.reviews.length} unique=${new Set(ids).size} nullIds=${ids.filter(x=>!x).length} authors=${new Set(d.reviews.map(x=>x.authorName)).size} (${((Date.now()-t)/1000).toFixed(0)}s)`);
    } catch(e) { console.log('FAIL:', e.message.slice(0,80)); }
  }
  await bm.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
