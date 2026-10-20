export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (env.ASSETS) {
    // Serve the root document internally so Pages does not canonicalize /index.html
    // to / and drop the public /l/{venue}?venue={venue} URL.
    const assetUrl = new URL("/", url.origin);
    const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));
    const origin = url.origin;
    const imageUrl = `${origin}/social-preview.png`;
    if (typeof HTMLRewriter !== "undefined") {
      return new HTMLRewriter()
        .on('meta[property="og:image"]', { element(e) { e.setAttribute("content", imageUrl); } })
        .on('meta[property="og:image:secure_url"]', { element(e) { e.setAttribute("content", imageUrl); } })
        .on('meta[name="twitter:image"]', { element(e) { e.setAttribute("content", imageUrl); } })
        .on('meta[property="og:url"]', { element(e) { e.setAttribute("content", url.href); } })
        .on('link[rel="image_src"]', { element(e) { e.setAttribute("href", imageUrl); } })
        .transform(assetResponse);
    }
    return assetResponse;
  }
  return next();
}
