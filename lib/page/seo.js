async function collectSeoData(page) {
  return page.evaluate(() => {
    const title = document.title || null;
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;

    const robotsMeta = document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '';
    const noindex = /noindex/i.test(robotsMeta);

    const h1Count = document.querySelectorAll('h1').length;

    const images = Array.from(document.querySelectorAll('img'));
    const totalImages = images.length;
    const missingAltCount = images.filter((img) => !img.hasAttribute('alt')).length;

    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null;
    const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? null;
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;

    return {
      title,
      titleLength: title ? title.length : 0,
      metaDescription: metaDesc,
      metaDescriptionLength: metaDesc ? metaDesc.length : 0,
      canonical,
      noindex,
      h1Count,
      totalImages,
      missingAltCount,
      ogTitle,
      ogDescription,
      ogImage,
    };
  });
}

function scoreSeo(seoData, robotsOk, sitemapOk) {
  let score = 0;
  const findings = [];

  if (seoData.title) {
    if (seoData.titleLength >= 10 && seoData.titleLength <= 70) {
      score += 20;
    } else {
      score += 10;
      findings.push({
        field: 'title',
        issue: seoData.titleLength < 10
          ? `Title too short (${seoData.titleLength} chars — aim for 10–70)`
          : `Title too long (${seoData.titleLength} chars — aim for 10–70)`,
      });
    }
  } else {
    findings.push({ field: 'title', issue: 'Missing <title> tag' });
  }

  if (seoData.metaDescription) {
    if (seoData.metaDescriptionLength >= 50 && seoData.metaDescriptionLength <= 160) {
      score += 20;
    } else {
      score += 10;
      findings.push({
        field: 'meta_description',
        issue: seoData.metaDescriptionLength < 50
          ? `Meta description too short (${seoData.metaDescriptionLength} chars — aim for 50–160)`
          : `Meta description too long (${seoData.metaDescriptionLength} chars — aim for 50–160)`,
      });
    }
  } else {
    findings.push({ field: 'meta_description', issue: 'Missing meta description' });
  }

  if (seoData.h1Count === 1) {
    score += 15;
  } else if (seoData.h1Count === 0) {
    findings.push({ field: 'h1', issue: 'No <h1> heading found on page' });
  } else {
    score += 5;
    findings.push({ field: 'h1', issue: `${seoData.h1Count} <h1> headings found — use exactly one per page` });
  }

  if (seoData.totalImages === 0 || seoData.missingAltCount === 0) {
    score += 15;
  } else {
    const missingRatio = seoData.missingAltCount / seoData.totalImages;
    score += missingRatio < 0.25 ? 10 : missingRatio < 0.5 ? 5 : 0;
    findings.push({
      field: 'alt_text',
      issue: `${seoData.missingAltCount} of ${seoData.totalImages} images are missing the alt attribute`,
    });
  }

  if (seoData.canonical) {
    score += 10;
  } else {
    findings.push({ field: 'canonical', issue: 'No canonical URL — duplicate content issues possible' });
  }

  if (!seoData.noindex) {
    score += 10;
  } else {
    findings.push({ field: 'noindex', issue: 'Page has noindex directive — will not appear in search results' });
  }

  if (robotsOk) {
    score += 5;
  } else {
    findings.push({ field: 'robots_txt', issue: '/robots.txt returned a non-200 status or timed out' });
  }

  if (sitemapOk) {
    score += 5;
  } else {
    findings.push({ field: 'sitemap', issue: '/sitemap.xml returned a non-200 status or timed out' });
  }

  return { score: Math.min(100, score), findings };
}

module.exports = { collectSeoData, scoreSeo };
