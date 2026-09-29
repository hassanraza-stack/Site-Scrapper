function normalizeBaseUrl(url) {
  const u = new URL(url);
  u.searchParams.delete("page");
  let path = u.pathname.replace(/\/$/, "");
  return `${u.origin}${path}`;
}

function pageUrl(baseUrl, pageNum) {
  if (pageNum <= 1) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(pageNum));
  return u.toString();
}

/** Read max page number from listing pagination in the DOM. */
async function detectMaxPage(page) {
  return page.evaluate(() => {
    let max = 1;
    const links = document.querySelectorAll("a[href*='page=']");
    links.forEach((a) => {
      try {
        const u = new URL(a.href, window.location.href);
        const p = parseInt(u.searchParams.get("page") || "0", 10);
        if (p > max) max = p;
      } catch {
        /* ignore */
      }
    });

    document.querySelectorAll("ul.pagination a, .pagination a").forEach((a) => {
      const n = parseInt((a.textContent || "").trim(), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    });

    document.querySelectorAll("a").forEach((a) => {
      const t = (a.textContent || "").trim();
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (n > max && n < 10000) max = n;
      }
    });

    return max;
  });
}

function buildPageJobs(baseUrl, maxPage) {
  const jobs = [];
  for (let p = 1; p <= maxPage; p++) {
    jobs.push({ pageNum: p, url: pageUrl(baseUrl, p) });
  }
  return jobs;
}

module.exports = {
  normalizeBaseUrl,
  pageUrl,
  detectMaxPage,
  buildPageJobs,
};
